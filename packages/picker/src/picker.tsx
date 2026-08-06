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
import { useCallback, useMemo, useState } from "react";

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

/** The colour a matched character is drawn in. */
const HIGHLIGHT = "cyan";

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

/** One aligned column of a row. */
export interface PickerColumn {
  /** The text to display. Sanitized before it reaches the terminal. */
  readonly text: string;
  /**
   * Column width, in characters.
   *
   * Optional, and normally omitted: a column nobody sizes is sized to its widest cell
   * across **all** rows — all, not the filtered ones, so a column cannot change width as
   * the user types. Supply it for a column whose width is a design decision rather than a
   * consequence, such as a one-glyph status gutter.
   */
  readonly width?: number;
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
  /** What precedes the query on the first line. Defaults to `"❯ "`. */
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
  /** Resolved width, in characters. */
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

/** Code points, since that is the unit {@link fuzzyMatch} reports positions in. */
const count = (text: string): number => Array.from(text).length;

/**
 * Sanitizes, measures and lays out every row once.
 *
 * Once, rather than per keystroke: the widths are a property of the whole row set, and the
 * sanitizer is a regex pass over every cell. Both would otherwise run on every frame.
 */
function prepare<T>(rows: readonly PickerRow<T>[]): Prepared<T>[] {
  const columnCount = Math.max(0, ...rows.map((row) => row.columns.length));

  const widths = Array.from({ length: columnCount }, (_unused, column) => {
    const cells = rows.map((row) => row.columns[column]);
    const supplied = cells.map((cell) => cell?.width).filter((width) => width !== undefined);

    // A column the caller sized keeps that size; one nobody sized is sized to fit.
    return supplied.length > 0
      ? Math.max(...supplied)
      : Math.max(1, ...cells.map((cell) => count(stripSgr(sanitize(cell?.text ?? "")))));
  });

  return rows.map((row, index) => {
    let offset = 0;
    const cells = row.columns.map((column, columnIndex): Cell => {
      const safe = sanitize(column.text);
      const plain = stripSgr(safe);
      const cell: Cell = {
        key: String(columnIndex),
        safe,
        plain,
        color: column.color,
        width: widths[columnIndex] ?? count(plain),
        offset,
        length: count(plain),
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
  const segments: Segment[] = [];

  Array.from(text).forEach((character, index) => {
    const matched = hit.has(index);
    const previous = segments.at(-1);

    if (previous && previous.matched === matched) {
      segments[segments.length - 1] = { ...previous, text: previous.text + character };
    } else {
      segments.push({ at: index, text: character, matched });
    }
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

  // A cell carrying its own colour renders whole and unhighlighted. Slicing it at code-point
  // offsets could cut an escape sequence in half, and half a sequence written to a terminal
  // is the garbage this component exists not to emit. Colour is kept; only the highlight is
  // given up, and only for a row no caller in this repository produces.
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

/** What {@link Picker} needs beyond {@link PickOptions}. */
interface PickerProps<T> extends PickOptions<T> {
  /** Called with the chosen payload, before the app unmounts. Not called on dismissal. */
  readonly onPick: (payload: T) => void;
}

/** The component itself. */
function Picker<T>({ rows, prompt, onPick }: PickerProps<T>): ReactElement {
  const { exit } = useApp();
  const { rows: viewportRows } = useWindowSize();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [top, setTop] = useState(0);

  const prepared = useMemo(() => prepare(rows), [rows]);
  const matches = useMatches(prepared, query);

  // One line for the query, and the rest of the budget for rows. `floor` of a fraction
  // below one is strictly under `viewportRows` for any viewport worth rendering in, which
  // is the threshold EXC-1009 measured.
  const listRows = Math.max(1, Math.floor(viewportRows * HEIGHT_BUDGET) - 1);

  // Derived rather than stored, so the cursor stays visible even when a resize has changed
  // `listRows` under a `top` that was correct for the old one.
  const windowTop = Math.min(Math.max(top, cursor - listRows + 1, 0), cursor);

  const retype = useCallback((next: string) => {
    setQuery(next);
    setCursor(0);
    setTop(0);
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      exit();
      return;
    }

    if (key.return) {
      const chosen = matches[cursor];
      if (chosen) onPick(chosen.row.payload);
      exit();
      return;
    }

    if (key.upArrow || key.downArrow) {
      const next = Math.min(
        Math.max(cursor + (key.upArrow ? -1 : 1), 0),
        Math.max(matches.length - 1, 0),
      );
      setCursor(next);
      setTop(Math.min(Math.max(windowTop, next - listRows + 1, 0), next));
      return;
    }

    if (key.backspace || key.delete) {
      retype(query.slice(0, -1));
      return;
    }

    if (input !== "" && !key.ctrl && !key.meta && !CONTROL.test(input)) {
      retype(query + input);
    }
  });

  return (
    <Box flexDirection="column">
      <Text wrap="truncate">{`${prompt ?? DEFAULT_PROMPT}${query}`}</Text>
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
 * @param options - The rows and the prompt; see {@link PickOptions}.
 * @returns The chosen row's payload, or `null` if the picker was dismissed with Escape.
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

  // Chalk's own level is derived from stdout; the frames go to stderr. Borrowed for the
  // picker's lifetime and handed back, because a library that permanently retunes a shared
  // singleton is a library that surprises its host.
  // The `?? 1` floor rather than `Math.max`: stderr is a TTY by the check above, so a
  // detected level of "none" is a detection that has already been wrong once — and
  // `Math.max` widens the union to `number`, which is not what `level` accepts.
  const level = chalk.level;
  chalk.level = COLOUR ? (chalkStderr.level === 0 ? 1 : chalkStderr.level) : 0;

  const instance = render(
    <Picker
      rows={options.rows}
      prompt={options.prompt}
      onPick={(payload) => {
        picked = payload;
      }}
    />,
    // stderr, because stdout is the machine channel. `patchConsole: false` because a
    // library has no business rerouting its host's `console`, and `packages/wrk` writes its
    // human output through its own `note()` rather than through `console` anyway.
    { stdout: process.stderr, patchConsole: false },
  );

  try {
    await instance.waitUntilExit();
    return picked;
  } finally {
    chalk.level = level;
  }
}
