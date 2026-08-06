/**
 * The picker's trust boundary: text on its way to a terminal, with everything but colour
 * taken out of it.
 *
 * A picker row is a branch name or a pull-request title. On a fork, both are written by
 * whoever opened the pull request, and a terminal does not distinguish text from
 * instructions — an escape sequence embedded in a title moves the cursor, erases the
 * screen, renames the window, or writes the user's clipboard through OSC 52. fzf shipped a
 * filter of this shape in 0.73.0; the allowlist below is deliberately narrower than
 * anything upstream promises, and is pinned by [`../test/sanitize.test.ts`](../test/sanitize.test.ts)
 * rather than by a version number, because there is no corpus here to resync against the
 * way [`./fuzzy`](./fuzzy) has one.
 *
 * **Ink does not already do this, and the gap is the dangerous one.** Ink 7 runs its own
 * `sanitizeAnsi` over every text node, which strips non-SGR CSI — but its comment says
 * "Preserved: SGR sequences … and OSC sequences (hyperlinks, etc.)", so the family carrying
 * OSC 52 passes through it untouched. Deleting this module because the substrate looks like
 * it covers the ground would reopen exactly the hole the issue's constraint names.
 *
 * **What survives is SGR and nothing else.** `ESC [ … m` sets colours and text attributes
 * and moves no cursor, so it is the one family a display can pass through and still be a
 * display. Everything else goes: other CSI sequences, every string family (OSC, DCS, SOS,
 * PM, APC) with its payload, any remaining two-character escape, and the raw control ranges.
 *
 * **There are two filters, and the second one keeps hyperlinks.** {@link sanitize} is the
 * row's, described above. {@link sanitizePreview} is the preview pane's, and it additionally
 * keeps an OSC 8 whose URI it has validated — because a pane that dropped them would render
 * a document with every link silently taken out of it, and because the row path could not
 * carry one anyway. The reasoning is on {@link sanitizePreview}; what matters here is that
 * the widening is one sequence, in one direction, on one of the two.
 *
 * **The C1 range goes with them, and it is the half that is easy to forget.** `U+009B` and
 * `U+009D` are CSI and OSC in eight-bit form; a terminal acts on them exactly as it acts on
 * `ESC [` and `ESC ]`, so a filter that drops only `ESC` leaves the attack intact under a
 * different byte.
 *
 * **C0 goes too, which the criterion does not spell out but the height budget does.** A
 * newline inside a pull-request title is a picker row that renders as two lines, and
 * EXC-1009 measured what a frame one row taller than its budget does: at
 * `outputHeight >= viewportRows` Ink stops rendering inline and takes the screen. That is
 * the same bug as an unfiltered escape, arriving through the data rather than the layout.
 *
 * **And the bidi controls, which are not escapes at all.** `U+202E` and its family reorder
 * the characters *after* them, so a row can be made to read as a different branch than the
 * one it carries — CVE-2021-42574's shape, and it lands squarely on this component because
 * the payload a row resolves to is deliberately not the text it displays. The line and
 * paragraph separators go with them for the height-budget reason above. `U+200D`, the
 * zero-width joiner, deliberately **stays**: it is what holds a multi-person emoji together
 * and it reorders nothing.
 *
 * **Two things survive that a reader should know about.** SGR `8` is conceal, so a row can
 * still make itself invisible — dropping it would mean parsing SGR parameters, which is a
 * much larger surface than the one attack it closes, and an invisible row is a nuisance
 * rather than an instruction. And a doubled introducer such as `ESC ESC [ 3 1 m` loses its
 * escapes and leaves `[31m` as literal text: ugly, and inert, which is the trade this
 * module makes everywhere it cannot cheaply do better.
 *
 * The patterns are composed through `RegExp` from named constants rather than written as
 * literals, for the reason [`../test/fixtures/pty.ts`](../test/fixtures/pty.ts) gives for
 * doing the same: a regex literal carrying a control character is invisible to read, and
 * biome's `noControlCharactersInRegex` rejects it.
 *
 * @packageDocumentation
 */

/**
 * A control character by code point.
 *
 * `String.fromCodePoint` rather than an escape in a string literal so that no line in this
 * file contains a byte a reader cannot see.
 */
const ctrl = (code: number): string => String.fromCodePoint(code);

const ESC = ctrl(0x1b);
const BEL = ctrl(0x07);

/** Eight-bit CSI and OSC: what a terminal reads `ESC [` and `ESC ]` as, in one byte. */
const C1_CSI = ctrl(0x9b);
const C1_OSC = ctrl(0x9d);

/**
 * The five string families' introducers, all of which run to a terminator and all of which
 * carry a payload: OSC, DCS (`ESC P`), SOS (`ESC X`), PM (`ESC ^`) and APC (`ESC _`).
 *
 * Grouped because they are one shape. Dropping only the introducer would leave a Sixel
 * image or a `DECRQSS` reply as a wall of visible text in the middle of a row.
 */
const STRING_INTRODUCERS = "\\]P^X_";

/**
 * The bidirectional controls and the two separators, which are text rather than escapes.
 *
 * Left as a written-out range because each entry is a named character and a code point is
 * how they are named: `U+061C` Arabic letter mark, `U+200E`/`U+200F` the LTR and RTL marks,
 * `U+202A`–`U+202E` the embeddings and overrides, `U+2066`–`U+2069` the isolates, and
 * `U+2028`/`U+2029` the line and paragraph separators.
 */
const BIDI = "\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2028\\u2029\\u2066-\\u2069";

/** `ESC [ <params> m` — the one family {@link sanitize} lets through. */
const SGR_SOURCE = `${ESC}\\[[\\d;:]*m`;

/** {@link SGR_SOURCE} anchored, for asking whether a whole match is an SGR sequence. */
const SGR_ONLY = new RegExp(`^${SGR_SOURCE}$`, "u");

/** {@link SGR_SOURCE} global, for {@link stripSgr}. */
const SGR = new RegExp(SGR_SOURCE, "gu");

/**
 * An OSC 8 hyperlink taken apart: `ESC ] 8 ; <params> ; <uri>`, terminator optional.
 *
 * Anchored, and only ever applied to a whole match {@link SEQUENCE} already found, so it
 * never has to locate its own boundaries. Neither segment may contain a `;`, which is what
 * stops a crafted parameter field from carrying a second URI past {@link hyperlink}'s check.
 * The terminator is optional because the seven-bit `ESC \` form never reaches here — the
 * OSC branch stops before an `ESC`, and {@link hyperlink} re-emits what it keeps with a
 * `BEL` for exactly that reason.
 */
const OSC8 = new RegExp(`^${ESC}\\]8;([^;]*);([^;]*?)(?:${BEL})?$`, "u");

/**
 * What an OSC 8 parameter field may hold: `key=value` pairs joined by `:`, and nothing else.
 *
 * An allowlist of what `id=` needs rather than a denylist of what hurts. Nothing in this
 * repository emits a parameter at all, so being narrow costs nothing and being wide leaves a
 * field that is parsed on the far side of this module.
 */
const OSC8_PARAMS = /^[\w=:.-]*$/u;

/**
 * The schemes a kept hyperlink may name.
 *
 * A preview is a rendered pull request, so its links are web links and occasionally an
 * address. `javascript:` and `data:` are what this list exists to exclude — a terminal that
 * hands a click to the system opener hands it those too — and `file:` goes with them, since
 * a link reaching into the reader's own filesystem is not something a pull-request body
 * should be able to draw.
 */
const SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * The hyperlink `match` should be replaced by, or `null` if it is not one worth keeping.
 *
 * The kept form is always `BEL`-terminated, whatever arrived: {@link SEQUENCE}'s OSC branch
 * stops before an `ESC`, so an `ESC \` terminator is a *separate* match on the next pass and
 * would be dropped — leaving an opener the terminal never sees closed, and every character
 * after it hyperlinked. Canonicalising the terminator is one substitution and removes that
 * whole class.
 */
function hyperlink(match: string): string | null {
  const parts = OSC8.exec(match);
  if (!parts) return null;

  const [, params = "", uri = ""] = parts;
  if (!OSC8_PARAMS.test(params)) return null;

  // The empty URI is the close sequence, which is always safe and must always survive — a
  // dropped opener whose close was also dropped would leak the link into the text after it.
  if (uri !== "") {
    // `URL` is the parser already in the runtime, and it rejects a relative reference for
    // free: a hyperlink is absolute or it is not one a terminal can open.
    const parsed = URL.parse(uri);
    if (!parsed || !SCHEMES.has(parsed.protocol)) return null;
  }

  return `${ESC}]8;${params};${uri}${BEL}`;
}

/**
 * Everything {@link sanitize} recognises, in the order it must be tried.
 *
 * Order is the whole of the correctness here. SGR comes first because it is itself a CSI
 * sequence and the general CSI branch would otherwise swallow it. The catch-all
 * two-character escape comes after both structured families, so it only ever sees an
 * `ESC` that starts nothing recognisable. The raw ranges come last and mop up what is left,
 * including a trailing `ESC` at the end of the string.
 *
 * A string family is matched up to a `BEL` but **not** past an `ESC`, so the `ESC \` form of
 * the String Terminator falls to the two-character branch on the following pass. Two matches
 * rather than one, the same nothing left behind, and no backslash in the pattern.
 *
 * The two C1 branches consume a whole eight-bit sequence rather than leaving the raw range
 * to drop the introducer alone: `U+009B 2 J` with only its first byte removed is an
 * erase-screen that has become the literal text `2J` in the middle of someone's branch
 * name. Inert, but still not what the row said. Note that this drops eight-bit SGR too —
 * the allowlist is the seven-bit form, and a colour worth keeping has never arrived any
 * other way.
 *
 * Every branch consumes at least one character and none can match empty, so the alternation
 * makes forward progress on every step and there is no backtracking to blow up on.
 */
const SEQUENCE = new RegExp(
  [
    SGR_SOURCE,
    `${ESC}[${STRING_INTRODUCERS}][^${BEL}${ESC}]*${BEL}?`,
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    `${ESC}[\\s\\S]`,
    `${C1_OSC}[^${BEL}${ESC}]*${BEL}?`,
    `${C1_CSI}[0-?]*[ -/]*[@-~]`,
    `[\\u0000-\\u001F\\u007F-\\u009F${BIDI}]`,
  ].join("|"),
  "gu",
);

/**
 * Makes `text` safe to write to a terminal, keeping its colour.
 *
 * @param text - Untrusted display text — a branch name, a pull-request title, an
 *   annotation.
 * @returns The same text with every escape sequence but SGR removed, along with the C0,
 *   `DEL` and C1 ranges and the bidirectional controls.
 */
export function sanitize(text: string): string {
  return text.replace(SEQUENCE, (match) => (SGR_ONLY.test(match) ? match : ""));
}

/**
 * {@link sanitize} for the preview pane, which keeps validated OSC 8 hyperlinks as well.
 *
 * Named for its caller because the policy is the pane's rather than a general-purpose knob.
 * A row is a one-line cell where a hyperlink buys nothing; a preview is a rendered document
 * where links are the point — and the row path could not carry one anyway. Row text goes
 * through {@link stripSgr} and then code-point arithmetic to place match highlights, and
 * `stripSgr` removes SGR only, so an OSC 8 surviving into that form would inflate every
 * offset after it and land highlights on the wrong characters. Widening the shared allowlist
 * means widening that model too, for rows that gain nothing.
 *
 * Not exported from the package, for {@link stripSgr}'s reason: the pane sanitizes what a
 * caller hands it, so a caller never needs this itself.
 *
 * Newlines are dropped here exactly as they are for a row — the pane splits its text on them
 * *before* filtering, so a document keeps its lines and no line can grow one. Tabs go with
 * them, which costs a code block its indentation; expanding them would mean choosing a tab
 * stop for a pane whose width changes, and a dropped tab is at least the same width as the
 * cell it left.
 *
 * @param text - One line of untrusted pre-rendered ANSI.
 * @returns The line with everything but SGR and safe hyperlinks removed. A kept hyperlink is
 *   `BEL`-terminated whatever terminator it arrived with — see {@link hyperlink}.
 */
export function sanitizePreview(text: string): string {
  return text.replace(SEQUENCE, (match) =>
    SGR_ONLY.test(match) ? match : (hyperlink(match) ?? ""),
  );
}

/**
 * Removes the colour {@link sanitize} keeps.
 *
 * Two callers, and neither is cosmetic. The picker matches and highlights against this
 * form, so a query can never latch onto the digits inside an escape sequence and a
 * highlight can never be sliced through the middle of one. And under `NO_COLOR` it is what
 * the picker renders, since a row's own colour is still colour — see
 * [`./picker`](./picker) for why that setting cannot be left to chalk.
 *
 * Not exported from the package. It is the internal half of a pair whose public half is
 * {@link sanitize}, and EXC-1014 has a smaller surface to bless for it.
 *
 * @param text - Text that has already been through {@link sanitize}.
 * @returns The text with its SGR sequences removed.
 */
export function stripSgr(text: string): string {
  return text.replace(SGR, "");
}
