/**
 * The picker's trust boundary: text on its way to a terminal, with everything but colour
 * taken out of it.
 *
 * A picker row is a branch name or a pull-request title. On a fork, both are written by
 * whoever opened the pull request, and a terminal does not distinguish text from
 * instructions — an escape sequence embedded in a title moves the cursor, erases the
 * screen, renames the window, or writes the user's clipboard through OSC 52. fzf shipped
 * this exact filter in 0.73.0; this module is that filter, and its allowlist is fzf's
 * allowlist.
 *
 * **What survives is SGR and nothing else.** `ESC [ … m` sets colours and text attributes
 * and moves no cursor, so it is the one family a display can pass through and still be a
 * display. Everything else goes: other CSI sequences, OSC strings and their terminators,
 * any remaining two-character escape, and the raw control ranges.
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

/** `ESC [ <params> m` — the one family {@link sanitize} lets through. */
const SGR_SOURCE = `${ESC}\\[[\\d;:]*m`;

/** {@link SGR_SOURCE} anchored, for asking whether a whole match is an SGR sequence. */
const SGR_ONLY = new RegExp(`^${SGR_SOURCE}$`, "u");

/** {@link SGR_SOURCE} global, for {@link stripSgr}. */
const SGR = new RegExp(SGR_SOURCE, "gu");

/**
 * Everything {@link sanitize} recognises, in the order it must be tried.
 *
 * Order is the whole of the correctness here. SGR comes first because it is itself a CSI
 * sequence and the general CSI branch would otherwise swallow it. The catch-all
 * two-character escape comes after both structured families, so it only ever sees an
 * `ESC` that starts nothing recognisable. The raw ranges come last and mop up what is left,
 * including a trailing `ESC` at the end of the string.
 *
 * An OSC is matched up to a `BEL` but **not** past an `ESC`, so the `ESC \` form of the
 * String Terminator falls to the two-character branch on the following pass. Two matches
 * rather than one, the same nothing left behind, and no backslash in the pattern.
 *
 * The two C1 branches consume a whole eight-bit sequence rather than leaving the raw range
 * to drop the introducer alone: `U+009B 2 J` with only its first byte removed is an
 * erase-screen that has become the literal text `2J` in the middle of someone's branch
 * name. Inert, but still not what the row said. Note that this drops eight-bit SGR too —
 * the allowlist is the seven-bit form, and a colour worth keeping has never arrived any
 * other way.
 */
const SEQUENCE = new RegExp(
  [
    SGR_SOURCE,
    `${ESC}\\][^${BEL}${ESC}]*${BEL}?`,
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    `${ESC}[\\s\\S]`,
    `${C1_OSC}[^${BEL}${ESC}]*${BEL}?`,
    `${C1_CSI}[0-?]*[ -/]*[@-~]`,
    `[\\u0000-\\u001F\\u007F-\\u009F]`,
  ].join("|"),
  "gu",
);

/**
 * Makes `text` safe to write to a terminal, keeping its colour.
 *
 * @param text - Untrusted display text — a branch name, a pull-request title, an
 *   annotation.
 * @returns The same text with every escape sequence but SGR removed, along with the C0,
 *   `DEL` and C1 ranges.
 */
export function sanitize(text: string): string {
  return text.replace(SEQUENCE, (match) => (SGR_ONLY.test(match) ? match : ""));
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
