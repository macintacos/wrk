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
 * ## What is not here
 *
 * The preview pane (EXC-1012), replacing the row set while the picker is open (EXC-1013),
 * and the latency budget (EXC-1020) each belong to their own issue. The filter loop calls
 * {@link fuzzyMatch} once per row per keystroke and does not pre-compile the query; see the
 * `ponytail:` note on {@link useMatches} for when that stops being the right call.
 *
 * @packageDocumentation
 */

import chalk, { chalkStderr } from "chalk";
import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import type { ReactElement } from "react";
import { useMemo, useReducer } from "react";
import stringWidth from "string-width";

import { fuzzyMatch } from "./fuzzy";
import { sanitize, stripSgr } from "./sanitize";

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
 * per-row type has no coherent meaning when two rows disagree, and this is public surface
 * EXC-1014 has to bless; the smallest surface that answers the need wins.
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
   * back out of them. EXC-1013 restores a selection by this value across a row-set
   * replacement, which is only possible because it is not the text.
   */
  readonly payload: T;
  /** The row's columns, left to right. */
  readonly columns: readonly PickerColumn[];
}

/** Everything {@link pick} needs. */
export interface PickOptions<T> {
  /** The rows, in the order they will be shown. Filtering never reorders them. */
  readonly rows: readonly PickerRow<T>[];
  /**
   * What precedes the query on the first line. Defaults to `"❯ "`.
   *
   * Sanitized like row text is, even though a prompt comes from the calling program rather
   * than from a pull request: a newline here would cost the frame a line just as surely,
   * and one shared rule is easier to keep than two.
   */
  readonly prompt?: string;
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

/** Everything a keystroke can change. */
interface State {
  readonly query: string;
  readonly cursor: number;
  /** The first visible row, as a hint — {@link Picker} re-derives the real one each render. */
  readonly top: number;
}

/**
 * A keystroke's effect, expressed so it can be applied to a state it has not seen yet.
 *
 * This indirection is the whole reason there is a reducer here rather than three
 * `useState`s. Ink parses a stdin *chunk* into however many events it holds and calls the
 * `useInput` handler for each one **synchronously, in a loop** — its own parser splits
 * repeated bytes precisely because a held-down key arrives that way. React does not
 * re-render between those calls, so every handler in the batch closes over the same state
 * and a value-form `setState` makes N keystrokes behave as one: three backspaces delete one
 * character, three arrows move one row. A reducer applies each action to the result of the
 * last, which is the only shape that cannot regress into that.
 *
 * `last` and `listRows` ride along on a move because the reducer cannot derive them: the
 * match count depends on the filter and the row budget on the viewport. Both are constant
 * across a batch, since neither changes without a re-render.
 */
type Action =
  | { readonly type: "retype"; readonly edit: (query: string) => string }
  | {
      readonly type: "move";
      readonly delta: number;
      readonly last: number;
      readonly listRows: number;
    };

/** Applies one keystroke. See {@link Action} for why this is a reducer. */
function reduce(state: State, action: Action): State {
  if (action.type === "retype") {
    // A changed query invalidates the selection: the row under the cursor is probably not
    // in the new result set, and "wherever the cursor happened to be" is not a selection a
    // user made.
    return { query: action.edit(state.query), cursor: 0, top: 0 };
  }

  const cursor = Math.min(Math.max(state.cursor + action.delta, 0), Math.max(action.last, 0));

  return {
    ...state,
    cursor,
    top: Math.min(Math.max(state.top, cursor - action.listRows + 1, 0), cursor),
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
function Picker<T>({ rows, prompt, onDone }: PickerProps<T>): ReactElement {
  const { exit } = useApp();
  const { rows: viewportRows } = useWindowSize();
  const [{ query, cursor, top }, dispatch] = useReducer(reduce, { query: "", cursor: 0, top: 0 });

  const prepared = useMemo(() => prepare(rows), [rows]);
  const matches = useMatches(prepared, query);

  // One line for the query, and the rest of the budget for rows. `floor` of a fraction
  // below one is strictly under `viewportRows` for any viewport worth rendering in, which
  // is the threshold EXC-1009 measured.
  const listRows = Math.max(1, Math.floor(viewportRows * HEIGHT_BUDGET) - 1);

  // Derived rather than taken from state, so the cursor stays visible even when a resize has
  // changed `listRows` under a `top` that was correct for the old one.
  const windowTop = Math.min(Math.max(top, cursor - listRows + 1, 0), cursor);

  const finish = (payload: T | null) => {
    onDone(payload);
    exit();
  };

  useInput((input, key) => {
    if (key.escape) return finish(null);
    if (key.return) return finish(matches[cursor]?.row.payload ?? null);

    if (key.upArrow || key.downArrow) {
      dispatch({ type: "move", delta: key.upArrow ? -1 : 1, last: matches.length - 1, listRows });
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
      {/* A filter that empties the list has to say so. Without this the frame collapses to
          the query line alone, which reads the same as a picker that stopped working — and
          Enter there resolves `null`, which a caller maps to a cancellation and prints
          nothing at all, so the mistyped query would end in silence. */}
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
  );
}

/**
 * Shows the picker and resolves what the user chose.
 *
 * The picker erases its own frame on the way out, the way `fzf` does. A `wrk wt` wrapped in
 * a shell function is run dozens of times a day, and a picker that left its list behind
 * would push the user's prompt down twenty lines on every one of them.
 *
 * @param options - The rows and the prompt; see {@link PickOptions}.
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
        onDone={(payload) => {
          picked = payload;
          control.clear();
        }}
      />,
      // stderr, because stdout is the machine channel. `patchConsole: false` because a
      // library has no business rerouting its host's `console`, and `packages/wrk` writes its
      // human output through its own `note()` rather than through `console` anyway.
      { stdout: process.stderr, patchConsole: false },
    );
    control.clear = instance.clear;

    await instance.waitUntilExit();
    return picked;
  } finally {
    chalk.level = level;
  }
}
