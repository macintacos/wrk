/** @jsxImportSource react */

/**
 * The picker: a list you filter by typing, rendered inline beneath whatever the terminal
 * already held.
 *
 * `pick()` is the whole public surface. It takes rows, renders them to **stderr**, and
 * resolves the payload of the row the user chose — or `null` if they dismissed it. Nothing
 * here writes to stdout, because `packages/wrk/src/output.ts` promises that channel carries
 * one JSON document per run and an interactive component's escape sequences would make it
 * unparseable.
 *
 * ## The height budget, and why it is a budget rather than a limit
 *
 * EXC-1009 measured the threshold precisely: Ink renders inline while a frame is **strictly
 * shorter** than the viewport, and takes the screen at `outputHeight >= viewportRows`.
 * There is no gradual degradation. So the frame is computed from the rows of the stream it
 * renders to — `useWindowSize()`, which reads that stream and re-renders on its `resize`
 * event, discharging the `SIGWINCH` obligation without a signal handler — and held to ~80%
 * of it. The remaining 20% is headroom, not the boundary: a picker's height is computed,
 * and every future border or status line spends some of it.
 *
 * The other way a frame grows is a row that wraps, which `ink-gotchas.test.ts` measured as
 * a property of `wrap="truncate"` alone — `flexShrink={0}` does not do it. Every cell here
 * truncates, and no column is rigid: a rigid column whose siblings sum past the terminal
 * width overflows and wraps, which is the same bug arriving from the other direction.
 * Alignment is exact while the columns fit and degrades proportionally when they do not.
 *
 * One case the budget cannot cover, because it is not this component's to cover: a viewport
 * **shrink** mid-session. `Ink.resized` re-lays out and writes the current React tree
 * synchronously, before the `useWindowSize` state update has been processed, so the frame
 * that meets the smaller viewport is the old tall one and Ink takes the screen for exactly
 * that frame before the re-budgeted one lands. Every Ink app whose frame outgrows its
 * viewport does this, and EXC-1009 left mid-session resize out of scope on those grounds.
 * `picker.test.ts` asserts what is in scope: a grow disturbs nothing, and a shrink settles
 * back inside the new budget.
 *
 * ## Piped stdin is refused
 *
 * `ink-gotchas.test.ts` settled that `useInput` throws on non-TTY stdin, that the obvious
 * guard does not stop it, and that the *working* guard is worse: it renders a picker that
 * accepts no key and waits forever. It deliberately left open which of refuse / fall back /
 * open `/dev/tty` the picker should choose.
 *
 * This picker **refuses**, at the door, before Ink mounts — {@link NotATerminal}. Nothing
 * is drawn and nothing waits. `/dev/tty` was weighed and rejected: fzf needs it because fzf
 * takes its list on stdin and must therefore find keys elsewhere, whereas these rows arrive
 * from `git` and `gh`, so a piped stdin is never a configuration the picker has to work in
 * — and opening `/dev/tty` would still need this same refusal for the case where there is
 * no controlling terminal, making it more machinery in front of the same answer.
 *
 * That check is also why no `isActive: Boolean(isRawModeSupported)` guard appears below.
 * The coercion gotcha one pins is real, and this is the same guard moved to the door, where
 * it can say something instead of silently disabling itself.
 *
 * ## Colour is decided from stderr, in both directions
 *
 * Ink colours through chalk, and chalk decides its level from **`process.stdout`** — which
 * this component never renders to. So a picker whose stdout is piped, which is the shape
 * every agent-facing and every `cd`-wrapping invocation has, would silently lose every
 * colour while its frames sat on a perfectly capable stderr. {@link pick} pins
 * `chalk.level` from `chalkStderr` for the duration of the picker and restores it after, so
 * the answer comes from the stream being drawn on.
 *
 * The same line is what gives `NO_COLOR` its teeth. Gotcha two measured that the variable
 * does not reach chalk under Bun, so honouring it is this module's own work: the level goes
 * to `0`, no styling prop is set, and rows render in their colour-stripped form — a row's
 * *own* colour is still colour, and passing it through would honour the letter of the
 * setting while breaking it. The selected row is marked with a gutter bar rather than with
 * an inverse or a colour, so the selection survives all of that with nothing else needed.
 *
 * ## The rows can change underneath the user
 *
 * {@link PickOptions.onOpen} hands the caller a `replace`, so a picker can open on a stale
 * cache and take the fresh rows when they arrive. That makes the keyboard the *second*
 * writer into this component's state rather than the only one, which is why the rows sit in
 * the reducer beside the query and the selection: one atom and one queue, so the two writes
 * are applied in the order React received them.
 *
 * The selection survives a replacement because it is stored as the **payload**, not as an
 * index — see {@link State.selected}. An index means nothing across a swap: rows appear
 * above the one the user is on, and the annotations that arrive with them change every
 * haystack, so the filter's answer moves as well. The cursor's index is derived from the
 * payload on each render, and a payload that has left the list takes its selection with it,
 * putting the cursor back at the top.
 *
 * Ordering is all the reducer gives, and it is worth being exact about the rest. A `move`
 * carries the payloads of the last *render* ({@link Action}), so a replacement that lands
 * ahead of a keystroke in the same batch leaves that keystroke answering the old list — for
 * one batch, costing at worst a cursor at the top. That window stays shut in practice
 * because Ink mounts a **legacy, non-concurrent** root unless asked otherwise, which is a
 * dependency {@link pick} records at the `render` call rather than one this component can
 * enforce. [`../test/reducer.test.ts`](../test/reducer.test.ts) pins the behaviour either
 * way, since a driven terminal cannot put two writers in one batch on purpose.
 *
 * ## The preview pane costs the budget nothing
 *
 * {@link PickOptions.preview} adds a second pane beside the list, taking 40% of the
 * terminal's columns behind a one-column seam. It is optional: without it the component
 * renders exactly what it rendered before there was one.
 *
 * Its **height** is the list's own `listRows`, which is what keeps the frame the same height
 * with a pane as without one — the row Box is as tall as its taller child, and neither child
 * may exceed the number the budget above already settled. Nothing new is spent, so nothing
 * new can push the frame to `outputHeight >= viewportRows`.
 *
 * Its **width** is a number the caller is handed rather than one it infers. `previewPullRequest`
 * in `packages/wrk` keys its cache on the column count it renders at, so a resize is a cache
 * miss by construction and the pane re-renders instead of replaying text wrapped for a
 * terminal that no longer exists. That is the whole of the width-aware behaviour: this
 * component reads `columns` off the same `useWindowSize()` it reads `rows` off, and passes it
 * on.
 *
 * Its **content** is pre-rendered ANSI, and it goes through {@link sanitizePreview} rather
 * than {@link sanitize} — the row filter drops all OSC, which would take every hyperlink out
 * of a rendered document. That module states why the two filters exist and why the widening
 * is the pane's alone.
 *
 * ## What is not here
 *
 * The latency budget (EXC-1020) belongs to its own issue. The filter loop calls
 * {@link fuzzyMatch} once per row per keystroke and does not pre-compile the query; see the
 * `ponytail:` note on {@link useMatches} for when that stops being the right call, and the
 * one on {@link usePreview} for the redraw the pane does not debounce.
 *
 * @packageDocumentation
 */

import chalk, { chalkStderr } from "chalk";
import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import type { ReactElement } from "react";
import { useEffect, useMemo, useReducer, useState } from "react";
import stringWidth from "string-width";

import { fuzzyMatch } from "./fuzzy";
import { sanitize, sanitizePreview, stripSgr } from "./sanitize";

/** What precedes the query on the first line, unless a caller says otherwise. */
const DEFAULT_PROMPT = "❯ ";

/**
 * The selected row's marker, and the blank that holds its place on every other row.
 *
 * A gutter bar rather than an arrow or an inverted row: it is one glyph wide, it reads as
 * "this band", it cannot be confused with {@link DEFAULT_PROMPT} on the line above, and it
 * is the only selection cue that survives `NO_COLOR` without any escape sequence at all.
 */
const GUTTER = ["  ", "▌ "] as const;

/** The colour the picker draws attention with: a matched character, and the selected gutter. */
const HIGHLIGHT = "cyan";

/** What the list says when the query matches nothing. */
const NO_MATCHES = "no matches";

/** The fraction of the viewport the whole frame is allowed to occupy. */
const HEIGHT_BUDGET = 0.8;

/** The fraction of the terminal's columns the preview pane occupies, seam included. */
const PREVIEW_SHARE = 0.4;

/**
 * The seam between the panes: one column, drawn as the pane's left border.
 *
 * A rule rather than a box. A full border would cost two of the frame's rows, and rows are
 * the budget's scarce resource where columns are not — the picker has no border of its own
 * for that same reason. Ink's `borderStyle="single"` draws it as `│`, deliberately lighter
 * than {@link GUTTER}'s `▌`, so the split and the selection do not read as the same mark.
 */
const SEAM = 1;

/**
 * Whether this run may emit colour at all.
 *
 * Read once, from the environment, per [no-color.org](https://no-color.org): set and
 * non-empty means off.
 */
const COLOUR = !process.env.NO_COLOR;

/** Control characters, which a keystroke handler must not append to the query. */
const CONTROL = /\p{Cc}/u;

/**
 * One aligned column of a row.
 *
 * There is deliberately no `width`. A column is sized to its widest cell across **all**
 * rows — all, not the filtered ones, so a column cannot change width as the user types —
 * and a caller who wants a wider one pads its text. A per-column width declared on a
 * per-row type has no coherent meaning when two rows disagree, and this is published
 * surface; the smallest surface that answers the need wins.
 */
export interface PickerColumn {
  /**
   * The text to display.
   *
   * Sanitized before it reaches the terminal, per [`./sanitize`](./sanitize). A cell that
   * carries its own SGR keeps its colour but forgoes match highlighting — see
   * {@link CellText} for why those two cannot both be had.
   */
  readonly text: string;
  /** A chalk colour name or hex string. Ignored under `NO_COLOR`. */
  readonly color?: string;
}

/** A row: what is shown, and what choosing it means. */
export interface PickerRow<T> {
  /**
   * What choosing this row resolves to — and deliberately not what it displays.
   *
   * A worktree path or a pull-request number, carried beside the columns rather than parsed
   * back out of them. It is also the row's **identity**: a replacement through
   * {@link PickOptions.onOpen} restores the selection by matching this value with `===`,
   * which is only possible because it is not the text.
   *
   * Two obligations follow, and both are the caller's. A payload has to come back equal from
   * a fresh fetch — a string or a number does, an object rebuilt from the same fields does
   * not — and it has to be **unique across the rows**, because the cursor resolves to the
   * first `===` hit and a duplicate makes every later row carrying it unreachable.
   */
  readonly payload: T;
  /** The row's columns, left to right. */
  readonly columns: readonly PickerColumn[];
}

/** Everything {@link pick} needs. */
export interface PickOptions<T> {
  /** The rows the picker opens on, in the order they will be shown. Filtering never reorders them. */
  readonly rows: readonly PickerRow<T>[];
  /**
   * What precedes the query on the first line. Defaults to `"❯ "`.
   *
   * Sanitized like row text is, even though a prompt comes from the calling program rather
   * than from a pull request: a newline here would cost the frame a line just as surely,
   * and one shared rule is easier to keep than two.
   */
  readonly prompt?: string;

  /**
   * Called once, when the picker opens, with a function that replaces the whole row set.
   *
   * The channel for rows that are not ready when the picker has to be — `wrk wt` draws its
   * worktrees the moment `git` has them and annotates them from the pull-request graph a
   * moment later. `replace` may be called any number of times, from anywhere, and takes
   * effect on the next frame; the user's query, and the row their cursor is on, both
   * survive it. See {@link PickerRow.payload} for what "the row they are on" is matched by.
   *
   * A handle passed out rather than an async iterable of row sets: {@link pick} already
   * returns the answer, so it cannot also return a handle, and a generator is a lot of
   * ceremony for something that happens once or twice per run.
   *
   * A `replace` that arrives after the user has chosen is ignored, so a refresh losing its
   * race is not an error to guard against — but *stopping* that refresh is the caller's job,
   * and the cue is {@link pick}'s promise settling. There is deliberately no cancellation
   * channel here: a caller that needs one holds its own `AbortController`, passes the signal
   * into whatever this starts, and aborts in a `finally` — which is a few lines on the side
   * that owns the work and none on this one. [`../README.md`](../README.md) carries the
   * snippet. Handing the signal *out* instead would be an additive second parameter, which a
   * callback ignoring it keeps compiling through, so it stays a minor-version change for
   * whenever a consumer shows it is worth having.
   */
  readonly onOpen?: (replace: (rows: readonly PickerRow<T>[]) => void) => void;

  /**
   * What to show beside the list for the selected row. Omit it and there is no second pane.
   *
   * Called with the row's `payload` — its identity, not its text — and the pane's exact width
   * in terminal cells, and called again whenever either changes. Answering the width is the
   * caller's half of the resize contract: `previewPullRequest` in `packages/wrk` keys its
   * cache on that number, so a resized pane re-renders rather than replaying text wrapped for
   * the width it used to be.
   *
   * The text is displayed as given — pre-rendered ANSI, colour and hyperlinks intact — after
   * the sanitizing every string reaching this terminal goes through. It is split on newlines
   * and the pane shows one screenful, scrolled with the page keys.
   *
   * A rejection is displayed rather than thrown: an unhandled one would take the process down
   * with the terminal still in raw mode.
   */
  readonly preview?: (payload: T, width: number) => string | Promise<string>;
}

/**
 * Thrown by {@link pick} when there is no terminal to pick in.
 *
 * A class rather than a bare `Error` so a caller can map it to its own vocabulary — a
 * refusal, an exit code — without matching on the message text.
 */
export class NotATerminal extends Error {}

/** A column, prepared: sanitized, measured, and placed within its row's match text. */
interface Cell {
  /** Stable React key. The column's index, which never changes for a given row. */
  readonly key: string;
  /** Sanitized, colour intact — what renders. */
  readonly safe: string;
  /** {@link safe} with its colour removed — what matches, and what renders under `NO_COLOR`. */
  readonly plain: string;
  readonly color: string | undefined;
  /**
   * The column's resolved width, in **terminal cells**.
   *
   * A different unit from {@link offset} and {@link length} below, and deliberately so: this
   * one becomes a `<Box width>`, which Ink sizes and truncates against `string-width`, so
   * counting code points here sizes a column of CJK or emoji at half the space it occupies
   * and destroys the far end of every cell in it.
   */
  readonly width: number;
  /** Where this cell's text begins within its row's match text, in code points. */
  readonly offset: number;
  /** The cell's length in code points. */
  readonly length: number;
}

/** A row, prepared. */
interface Prepared<T> {
  readonly key: string;
  readonly payload: T;
  readonly cells: readonly Cell[];
  /**
   * The cells' plain text joined by the single space the layout renders between columns.
   *
   * One haystack per row rather than one per cell, so a query spans columns the way it
   * reads on screen. Positions come back as code-point indices into it, which {@link Cell}'s
   * `offset` and `length` map back to a column.
   */
  readonly haystack: string;
}

/** A row that survived the filter, with the positions the query matched in it. */
interface Match<T> {
  readonly row: Prepared<T>;
  readonly positions: readonly number[];
}

/**
 * Length in code points — the unit {@link fuzzyMatch} reports positions in.
 *
 * Never the unit a layout wants; {@link stringWidth} is that one. The two disagree for every
 * wide, combining and emoji character, which is most of what makes a pull-request title
 * interesting.
 */
const count = (text: string): number => Array.from(text).length;

/**
 * Sanitizes, measures and lays out every row once.
 *
 * Once, rather than per keystroke: the widths are a property of the whole row set, and the
 * sanitizer is a regex pass over every cell. Both would otherwise run on every frame — which
 * is also why the sanitized forms are computed up front and the widths read from them,
 * rather than each pass sanitizing the same text again.
 */
function prepare<T>(rows: readonly PickerRow<T>[]): Prepared<T>[] {
  const plain = rows.map((row) => row.columns.map((column) => stripSgr(sanitize(column.text))));
  const columnCount = Math.max(0, ...rows.map((row) => row.columns.length));

  const widths = Array.from({ length: columnCount }, (_unused, column) =>
    Math.max(1, ...plain.map((cells) => stringWidth(cells[column] ?? ""))),
  );

  return rows.map((row, index) => {
    let offset = 0;
    const cells = row.columns.map((column, columnIndex): Cell => {
      const text = plain[index]?.[columnIndex] ?? "";
      const cell: Cell = {
        key: String(columnIndex),
        safe: sanitize(column.text),
        plain: text,
        color: column.color,
        width: widths[columnIndex] ?? stringWidth(text),
        offset,
        length: count(text),
      };

      // `+ 1` for the space the layout puts between columns, which the haystack joins on.
      offset += cell.length + 1;
      return cell;
    });

    return {
      key: String(index),
      payload: row.payload,
      cells,
      haystack: cells.map((cell) => cell.plain).join(" "),
    };
  });
}

/**
 * The rows the query keeps, in the order they arrived.
 *
 * **Insertion order, never score order.** `fuzzyMatch` returns a score and this deliberately
 * ignores it: the pickers built on this component list worktrees and pull requests in an
 * order that already means something, and re-ranking on every keystroke moves the row the
 * user was reaching for.
 */
// ponytail: one `fuzzyMatch` call per row per keystroke, which re-decodes the query each
// time — roughly 4–6 ms per keystroke at 5,000 rows, two orders of magnitude above what
// this component's callers list. The fix, when EXC-1020's budget says it is needed, is
// `compileQuery(query) -> (textCodePoints) => match` with each row's code points cached.
// A replacement is the second trigger, and the more expensive one: it re-runs `prepare`
// over every cell as well as this pass. It is also far rarer — one or two per run against
// dozens of keystrokes — so EXC-1020 should measure the keystroke first.
function useMatches<T>(rows: readonly Prepared<T>[], query: string): Match<T>[] {
  return useMemo(() => {
    if (query === "") return rows.map((row) => ({ row, positions: [] }));

    const matches: Match<T>[] = [];
    for (const row of rows) {
      const match = fuzzyMatch(row.haystack, query);
      if (match) matches.push({ row, positions: match.positions });
    }

    return matches;
  }, [rows, query]);
}

/** One line of a preview: sanitized, and carrying the identity Ink renders it under. */
interface PreviewLine {
  /**
   * Stable React key — the line's place in the document, as {@link Prepared} does for a row.
   * The window slides, so keying by the window's own offset would move text between keys on
   * every scroll.
   */
  readonly key: string;
  readonly text: string;
}

/** What an unloaded pane shows, hoisted so its identity is stable across renders. */
const NO_LINES: readonly PreviewLine[] = [];

/**
 * The selected row's preview, sanitized and split into lines, or nothing while it loads.
 *
 * `useState` rather than the reducer, and the distinction is the reducer's whole reason for
 * existing: {@link Action} carries the actions of a *keystroke batch*, which React does not
 * re-render between. A resolved promise is not in that batch — it arrives with a render of
 * its own — so the hazard the reducer answers does not reach here.
 *
 * The stored value carries the row and the width it answers, and is read back only when both
 * still match. That is what the effect's own cleanup does *not* give: cleanup stops a stale
 * write, and what is also wanted is to stop a stale *read* of whatever the last write left
 * behind — a slow render for a row the user has already left, still on screen under the row
 * they are on now. The pane is blank until the current one lands, which is what `fzf` does
 * and the honest reading of "no answer yet".
 *
 * The row is compared by identity rather than by a key built from it. {@link Prepared} is
 * memoised on the row set, so its identity already changes exactly when the content should
 * be re-fetched — including across a replacement — and a stringified proxy for that is one
 * more thing to keep in step with the effect it guards.
 */
// ponytail: one call per row the cursor passes through and one per column count a drag
// passes through, neither debounced. `preview.ts` records the same ceiling from its end and
// says the fix belongs to the caller, which is this — a timer here would collapse both. Left
// out until EXC-1020's latency budget says what the interval should be, since a guessed one
// is a delay a user feels for no measured reason.
function usePreview<T>(
  preview: ((payload: T, width: number) => string | Promise<string>) | undefined,
  row: Prepared<T> | undefined,
  width: number,
): readonly PreviewLine[] {
  const [loaded, setLoaded] = useState<{
    readonly row: Prepared<T>;
    readonly width: number;
    readonly lines: readonly PreviewLine[];
  } | null>(null);

  useEffect(() => {
    if (!preview || !row) return;

    let live = true;
    const show = (text: string) => {
      if (!live) return;
      setLoaded({
        row,
        width,
        // Split before sanitizing, so the document keeps its lines: the filter drops a
        // newline exactly as the row one does, and for the same height-budget reason.
        lines: text.split("\n").map((line, index) => {
          const safe = sanitizePreview(line);
          return { key: String(index), text: COLOUR ? safe : stripSgr(safe) };
        }),
      });
    };

    // A rejection is content: `previewPullRequest` already answers a failed lookup with
    // `gh`'s own complaint, so what reaches here is the cache failing to write — which is
    // worth saying in the pane and fatal to say by letting it escape.
    Promise.resolve(preview(row.payload, width)).then(show, (error: unknown) => {
      show(String(error));
    });

    return () => {
      live = false;
    };
  }, [preview, row, width]);

  // `loaded !== null` rather than optional chaining: with no row selected, `loaded?.row` and
  // `row` are both `undefined` and the comparison would pass on a value that is not there.
  return loaded !== null && loaded.row === row && loaded.width === width ? loaded.lines : NO_LINES;
}

/** A run of characters that the query either matched or did not. */
interface Segment {
  /** Where the run starts, in code points. Also its stable React key. */
  readonly at: number;
  readonly text: string;
  readonly matched: boolean;
}

/**
 * Splits `text` into alternating matched and unmatched runs.
 *
 * Adjacent characters are coalesced so three consecutive matches are one `<Text>` rather
 * than three, which keeps the emitted frame close to what an unhighlighted one would be.
 */
function segment(text: string, positions: readonly number[]): Segment[] {
  const hit = new Set(positions);
  const segments: { at: number; text: string; matched: boolean }[] = [];

  Array.from(text).forEach((character, index) => {
    const matched = hit.has(index);
    const previous = segments.at(-1);

    if (previous && previous.matched === matched) previous.text += character;
    else segments.push({ at: index, text: character, matched });
  });

  return segments;
}

/** The positions falling inside `cell`, rebased to its own text. */
function within(cell: Cell, positions: readonly number[]): number[] {
  return positions
    .filter((position) => position >= cell.offset && position < cell.offset + cell.length)
    .map((position) => position - cell.offset);
}

/** One cell's text, with the matched characters picked out. */
function CellText({
  cell,
  positions,
  selected,
}: {
  readonly cell: Cell;
  readonly positions: readonly number[];
  readonly selected: boolean;
}): ReactElement {
  // Under NO_COLOR there is nothing to draw a highlight with, so the plain text goes
  // through unstyled — which is also what keeps a row's own colour from leaking past the
  // setting.
  if (!COLOUR) {
    return <Text wrap="truncate">{cell.plain}</Text>;
  }

  // A cell carrying its own colour can have its colour or its highlight, not both: the
  // highlight is per-character `<Text>` nodes, and rebuilding those around an arbitrary run
  // of SGR would mean tracking which attributes were open at each boundary and reopening
  // them — a small ANSI state machine, for a row no caller in this repository produces. The
  // trade is made toward colour, since that is what the caller asked for explicitly.
  // (Rendering `plain` highlighted was the other option; it silently discards a caller's
  // colour, which is worse than silently discarding a highlight.)
  if (positions.length === 0 || cell.safe !== cell.plain) {
    return (
      <Text wrap="truncate" color={cell.color} bold={selected}>
        {cell.safe}
      </Text>
    );
  }

  return (
    <Text wrap="truncate" color={cell.color} bold={selected}>
      {segment(cell.plain, positions).map((run) =>
        run.matched ? (
          <Text key={run.at} color={HIGHLIGHT} bold>
            {run.text}
          </Text>
        ) : (
          run.text
        ),
      )}
    </Text>
  );
}

/** One row: its selection gutter, then its columns. */
function Row<T>({
  row,
  positions,
  selected,
}: {
  readonly row: Prepared<T>;
  readonly positions: readonly number[];
  readonly selected: boolean;
}): ReactElement {
  return (
    <Box>
      <Text wrap="truncate" color={COLOUR && selected ? HIGHLIGHT : undefined}>
        {GUTTER[selected ? 1 : 0]}
      </Text>
      <Box gap={1}>
        {row.cells.map((cell) => (
          <Box key={cell.key} width={cell.width}>
            <CellText cell={cell} positions={within(cell, positions)} selected={selected} />
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/** Everything the picker's two writers — the keyboard and {@link PickOptions.onOpen} — can change. */
interface State<T> {
  readonly query: string;
  /**
   * The payload under the cursor, or `undefined` when nothing is selected.
   *
   * The index is derived from this on each render and never stored; this module's header
   * has why an index cannot survive a replacement.
   */
  readonly selected: T | undefined;
  /** The first visible row, as a hint — {@link Picker} re-derives the real one each render. */
  readonly top: number;
  /**
   * The rows, as they stand.
   *
   * Seeded from {@link PickOptions.rows} and thereafter owned here, replaced wholesale by
   * {@link Action}'s `replace`. Reading a prop once into state is a shape worth distrusting
   * on sight, so: {@link pick} renders {@link Picker} exactly once and never re-renders it
   * from outside, which means that prop cannot change and there is nothing to sync back to.
   */
  readonly rows: readonly PickerRow<T>[];
  /** The preview's first visible line. Unlike {@link top}, the pane's alone to move. */
  readonly previewTop: number;
}

/**
 * One writer's effect, expressed so it can be applied to a state it has not seen yet.
 *
 * This indirection is the whole reason there is a reducer here rather than four
 * `useState`s. Ink parses a stdin *chunk* into however many events it holds and calls the
 * `useInput` handler for each one **synchronously, in a loop** — its own parser splits
 * repeated bytes precisely because a held-down key arrives that way. React does not
 * re-render between those calls, so every handler in the batch closes over the same state
 * and a value-form `setState` makes N keystrokes behave as one: three backspaces delete one
 * character, three arrows move one row. A reducer applies each action to the result of the
 * last, which is the only shape that cannot regress into that.
 *
 * `replace` arrives from outside the keyboard entirely, and holding the rows here rather
 * than in a second `useState` is what keeps the two writers on one queue: a refresh landing
 * in the same batch as a keystroke is applied in order against the accumulated state.
 *
 * `payloads` and `listRows` ride along on a move because the reducer cannot derive them:
 * the filtered list depends on the matcher and the row budget on the viewport. Neither
 * changes without a re-render, so both are constant across a batch of keystrokes — but a
 * `replace` in that batch does not re-render either, which makes the guarantee **ordering,
 * not freshness**. A move sitting behind a replacement answers the row list it was built
 * from, and if that answer is not in the new rows the cursor falls to the top for one
 * frame, exactly as a dropped row does.
 *
 * A `scroll` carries its own `last` for the same reason `move` carries `payloads`: the
 * preview's length is a property of text the reducer never sees.
 */
type Action<T> =
  | { readonly type: "retype"; readonly edit: (query: string) => string }
  | {
      readonly type: "move";
      readonly delta: number;
      readonly payloads: readonly T[];
      readonly listRows: number;
    }
  | { readonly type: "replace"; readonly rows: readonly PickerRow<T>[] }
  | { readonly type: "scroll"; readonly delta: number; readonly last: number };

/**
 * Where `selected` sits in the list currently on screen — the cursor.
 *
 * Nothing selected, or a payload no longer in the list, answers the top row. That is the
 * whole fallback: a payload that has left takes its selection with it, and the top is where
 * a picker with no selection already puts the cursor. Carrying the old *index* across
 * instead would leave the cursor on a row the user never moved onto, with no cue that
 * anything had happened.
 *
 * Matched by `===`, on the identity contract {@link PickerRow.payload} states.
 */
function cursorFor<T>(payloads: readonly T[], selected: T | undefined): number {
  if (selected === undefined) return 0;

  return Math.max(payloads.indexOf(selected), 0);
}

/**
 * Applies one action. See {@link Action} for why this is a reducer.
 *
 * Exported for [`../test/reducer.test.ts`](../test/reducer.test.ts) and not from
 * [`./index`](./index): a batch is two actions applied with no render between them, which a
 * driven terminal cannot schedule on purpose and a direct call is. The same split
 * `stripSgr` has.
 */
export function reduce<T>(state: State<T>, action: Action<T>): State<T> {
  if (action.type === "replace") {
    // `query` and `top` are left alone: the user keeps what they typed, and the window is
    // re-derived from the cursor each render anyway. `selected` is kept too — that is the
    // feature — but only while the payload is still somewhere in the rows. Letting a
    // departed one linger would make the fallback hold for exactly one replacement: the
    // cursor renders at the top because the payload cannot be found, and then a later
    // replacement that brings it back teleports the cursor out from under a user who has
    // been sitting on that top row for a while. `onOpen` promises any number of
    // replacements, so the drop has to be a state transition rather than a rendering
    // accident. A payload still in `rows` but filtered out by a standing query is the one
    // case this cannot see; `retype` clears the selection on every keystroke, so reaching it
    // takes a replacement that keeps a row while making it stop matching, and it costs a
    // cursor at the top either way.
    const kept = action.rows.some((row) => row.payload === state.selected);

    return {
      ...state,
      rows: action.rows,
      selected: kept ? state.selected : undefined,
      // A dropped selection puts the cursor on a different row, and therefore under a
      // different document; a kept one is still looking at the same text it scrolled.
      previewTop: kept ? state.previewTop : 0,
    };
  }

  if (action.type === "retype") {
    // A changed query invalidates the selection: the row under the cursor is probably not
    // in the new result set, and "wherever the cursor happened to be" is not a selection a
    // user made.
    return {
      ...state,
      query: action.edit(state.query),
      selected: undefined,
      top: 0,
      previewTop: 0,
    };
  }

  if (action.type === "scroll") {
    const previewTop = state.previewTop + action.delta;
    return { ...state, previewTop: Math.min(Math.max(previewTop, 0), Math.max(action.last, 0)) };
  }

  const last = Math.max(action.payloads.length - 1, 0);
  const cursor = Math.min(
    Math.max(cursorFor(action.payloads, state.selected) + action.delta, 0),
    last,
  );

  const landed = action.payloads[cursor];

  return {
    ...state,
    // `undefined` on an empty list, which is exactly right: there is nothing to select.
    selected: landed,
    top: Math.min(Math.max(state.top, cursor - action.listRows + 1, 0), cursor),
    // A different row is a different document, so the pane starts at its top again. An arrow
    // that changed nothing — the last row, pressed down — leaves the pane where the reader
    // scrolled it.
    previewTop: landed === state.selected ? state.previewTop : 0,
  };
}

/** What {@link Picker} needs beyond {@link PickOptions}. */
interface PickerProps<T> extends PickOptions<T> {
  /**
   * Called once with the outcome — the chosen payload, or `null` for a dismissal — while the
   * frame is still on screen, so the caller can erase it before the app unmounts.
   */
  readonly onDone: (payload: T | null) => void;
}

/** The component itself. */
function Picker<T>({ rows, prompt, preview, onOpen, onDone }: PickerProps<T>): ReactElement {
  const { exit } = useApp();
  const { columns, rows: viewportRows } = useWindowSize();
  const [{ query, selected, top, previewTop, rows: current }, dispatch] = useReducer(reduce, {
    query: "",
    selected: undefined,
    top: 0,
    previewTop: 0,
    rows,
  });

  const prepared = useMemo(() => prepare(current), [current]);
  const matches = useMatches(prepared, query);

  // Handed out after the first frame — once, since `pick` renders this component exactly
  // once and the prop it passes therefore never changes identity. A `replace` arriving after
  // the user has chosen dispatches into an unmounted component, which React makes a no-op.
  useEffect(() => {
    onOpen?.((next) => dispatch({ type: "replace", rows: next }));
  }, [onOpen]);

  const payloads = useMemo(() => matches.map((match) => match.row.payload), [matches]);
  const cursor = cursorFor(payloads, selected);

  // One line for the query, and the rest of the budget for rows. `floor` of a fraction
  // below one is strictly under `viewportRows` for any viewport worth rendering in, which
  // is the threshold EXC-1009 measured.
  const listRows = Math.max(1, Math.floor(viewportRows * HEIGHT_BUDGET) - 1);

  // Derived rather than taken from state, so the cursor stays visible even when a resize has
  // changed `listRows` under a `top` that was correct for the old one — and, now, when a
  // replacement has moved the selected row somewhere the old window does not reach.
  const windowTop = Math.min(Math.max(top, cursor - listRows + 1, 0), cursor);

  // The share, less the seam that is drawn inside it, so the number the caller renders at is
  // the number of cells its text actually gets. Never below one: it reaches `gh` as a forced
  // terminal width, where zero is not a render.
  const previewWidth = Math.max(1, Math.floor(columns * PREVIEW_SHARE) - SEAM);

  const previewLines = usePreview(preview, matches[cursor]?.row, previewWidth);

  // Derived for `windowTop`'s reason, one line up: a widened terminal wraps the preview into
  // fewer lines, and an offset that was inside the old document can be past the end of the
  // new one — which renders as a pane gone blank with no cue.
  const lastPaneTop = Math.max(0, previewLines.length - listRows);
  const paneTop = Math.min(previewTop, lastPaneTop);

  const finish = (payload: T | null) => {
    onDone(payload);
    exit();
  };

  useInput((input, key) => {
    if (key.escape) return finish(null);
    if (key.return) return finish(matches[cursor]?.row.payload ?? null);

    if (key.upArrow || key.downArrow) {
      dispatch({ type: "move", delta: key.upArrow ? -1 : 1, payloads, listRows });
      return;
    }

    // The pane's own keys, and only when there is a pane. The arrows stay the list's, so the
    // two never contend for one binding — which is what "independently scrollable" asks for.
    if (preview && (key.pageUp || key.pageDown)) {
      dispatch({ type: "scroll", delta: key.pageUp ? -listRows : listRows, last: lastPaneTop });
      return;
    }

    if (key.backspace || key.delete) {
      dispatch({ type: "retype", edit: (current) => current.slice(0, -1) });
      return;
    }

    if (input !== "" && !key.ctrl && !key.meta && !CONTROL.test(input)) {
      dispatch({ type: "retype", edit: (current) => current + input });
    }
  });

  return (
    <Box flexDirection="column">
      <Text wrap="truncate">{`${sanitize(prompt ?? DEFAULT_PROMPT)}${query}`}</Text>
      <Box>
        {/* `overflowX="hidden"` is load-bearing rather than defensive. A flex item's automatic
            minimum size is its min-content width while its overflow is visible, and a row's
            cells are sized from the whole row set — so on a narrow terminal the list would
            refuse to shrink into its 60%, push the seam right, and hand the caller a pane
            width wider than the cells it actually got. Hidden resolves that minimum to zero,
            which is what makes the split hold at every width rather than only wide ones. */}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} overflowX="hidden">
          {/* A filter that empties the list has to say so. Without this the frame collapses
              to the query line alone, which reads the same as a picker that stopped working
              — and Enter there resolves `null`, which a caller maps to a cancellation and
              prints nothing at all, so the mistyped query would end in silence. */}
          {matches.length === 0 && (
            <Text dimColor={COLOUR} wrap="truncate">{`${GUTTER[0]}${NO_MATCHES}`}</Text>
          )}
          {matches.slice(windowTop, windowTop + listRows).map((match, index) => (
            <Row
              key={match.row.key}
              row={match.row}
              positions={match.positions}
              selected={windowTop + index === cursor}
            />
          ))}
        </Box>
        {preview && (
          <Box
            flexDirection="column"
            // Yoga counts a border inside the width it is given, so the seam is added back
            // here to leave `previewWidth` cells for the text itself. Rigid, because that
            // number is what the caller rendered its text for: a pane squeezed narrower than
            // it asked for would show text wrapped for a width it never had.
            width={previewWidth + SEAM}
            flexShrink={0}
            borderStyle="single"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderDimColor={COLOUR}
          >
            {previewLines.slice(paneTop, paneTop + listRows).map((line) => (
              <Text key={line.key} wrap="truncate">
                {line.text}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}

/**
 * Shows the picker and resolves what the user chose.
 *
 * The picker erases its own frame on the way out, the way `fzf` does. A `wrk wt` wrapped in
 * a shell function is run dozens of times a day, and a picker that left its list behind
 * would push the user's prompt down twenty lines on every one of them.
 *
 * The erase rides on {@link PickerProps.onDone}, so it covers Escape and Enter and **not**
 * `Ctrl-C`: Ink's own `exitOnCtrlC` unmounts directly, and by the time the log is finalised
 * `clear()` is a no-op. Routing `Ctrl-C` through this component instead would mean
 * `exitOnCtrlC: false` and a binding of its own — a change to how the picker exits, which is
 * not a packaging issue's to make. `README.md` states the gap for a consumer.
 *
 * @param options - See {@link PickOptions}.
 * @returns The chosen row's payload, or `null`. `null` covers all three ways a run ends
 *   without a choice: Escape, `Ctrl-C` (Ink's own `exitOnCtrlC`), and Enter on an empty
 *   result set. A caller mapping this onto a cancellation should map all three.
 * @throws {@link NotATerminal} if stdin or stderr is not a TTY — see this module's header
 *   for why that is a refusal rather than a fallback.
 */
export async function pick<T>(options: PickOptions<T>): Promise<T | null> {
  if (!process.stdin.isTTY) {
    throw new NotATerminal("stdin is not a terminal, so the picker cannot read a keystroke");
  }
  if (!process.stderr.isTTY) {
    throw new NotATerminal("stderr is not a terminal, so the picker cannot draw a frame");
  }

  let picked: T | null = null;

  // Chalk derives its own level from stdout; the frames go to stderr, and `chalkStderr` is
  // the instance chalk builds for that stream. Borrowed for the picker's lifetime and handed
  // back, because a library that permanently retunes a shared singleton surprises its host.
  // Taken as-is rather than floored: a level of zero on a TTY means `FORCE_COLOR=0`,
  // `TERM=dumb` or `--no-color`, each of which is a person saying no.
  const level = chalk.level;

  // A holder rather than a `let`, because the callback needs the instance that the call
  // creating it returns. `clear()` only erases while the app is still mounted — after
  // `waitUntilExit` the log has been finalised and it is a no-op — so it is called from the
  // keystroke that ends the run, not from around the await.
  const control = { clear: () => {} };

  try {
    chalk.level = COLOUR ? chalkStderr.level : 0;

    const instance = render(
      <Picker
        rows={options.rows}
        prompt={options.prompt}
        preview={options.preview}
        onOpen={options.onOpen}
        onDone={(payload) => {
          picked = payload;
          control.clear();
        }}
      />,
      // stderr, because stdout is the machine channel. `patchConsole: false` because a
      // library has no business rerouting its host's `console`, and `packages/wrk` writes its
      // human output through its own `note()` rather than through `console` anyway.
      //
      // `concurrent` is left at Ink's default of `false`, which is a decision rather than an
      // omission: the legacy root flushes a dispatch from a promise before the next stdin
      // event is read, so a row replacement cannot sit unrendered behind a keystroke. The
      // component survives that window anyway — see its header — but anyone turning
      // concurrent rendering on should re-read that section first.
      { stdout: process.stderr, patchConsole: false },
    );
    control.clear = instance.clear;

    await instance.waitUntilExit();
    return picked;
  } finally {
    chalk.level = level;
  }
}
