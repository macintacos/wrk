/**
 * The picker, run as a real process so a real terminal can be driven against it.
 *
 * `pick()` reads `process.stdin` and renders to `process.stderr`, and both of those answers
 * change with whether the stream is a TTY — so every claim worth making about the picker is
 * a claim about a child process attached to a pty. `test/fixtures/pty.ts` supplies the
 * terminal; this file supplies the thing running inside it, exactly as
 * [`./inline-probe.tsx`](./inline-probe.tsx) does for the spike.
 *
 * | Variable | Default | What it does |
 * | --- | --- | --- |
 * | `PROBE_ROWS_FILE` | unset | A JSON file holding the rows verbatim. Set it when the scenario is about *what a row contains* — hostile escapes, colour, a payload distinct from the text. |
 * | `PROBE_COUNT` | `200` | Rows to generate when no file is given, deliberately far longer than any window. |
 * | `PROBE_REPLACE_FILE` | unset | A JSON file of replacement rows, handed to `onOpen`'s `replace` the moment the file appears. |
 * | `PROBE_PREVIEW` | unset | Unset means no pane at all, which is what every scenario predating EXC-1012 wants. `1` gives the picker a callback answering {@link document}; `slow` makes the first row's answer late, so a stale one can be raced against a fresh one; `throw` gives it a callback that rejects. |
 *
 * **The chosen payload goes to stdout, as JSON.** That is the channel `packages/wrk`
 * reserves for answers, and it is also what makes "Enter yields the payload, not the row
 * text" assertable: the test reads the payload off a redirected stdout while the frames it
 * was chosen from stay on stderr.
 *
 * A refusal is reported as one line rather than a stack, because the refusal is the
 * behaviour under test — see {@link NotATerminal}.
 *
 * @packageDocumentation
 */

import { existsSync } from "node:fs";

import { NotATerminal, type PickerRow, pick } from "../../src/index";

/** Synthetic rows: a short first column and a long second one, both varying in width. */
function generated(count: number): PickerRow<string>[] {
  return Array.from({ length: count }, (_unused, index) => ({
    payload: `/worktrees/wt-${index}`,
    columns: [{ text: `wt-${index}` }, { text: `feature/thing-${index}` }],
  }));
}

/** Flipped once the picker has resolved, which is what bounds {@link landed}. */
let picked = false;

/**
 * Waits for the file the driving test will drop, then answers the rows inside it.
 *
 * A file rather than a delay inside this process, so the *test* decides when the
 * replacement lands relative to the keys it has already typed. A probe that swapped its
 * rows after a fixed interval could only be raced against, and the whole point of the
 * cases this serves is the ordering.
 *
 * The wait ends with the picker rather than on a timer: while the frame is up, a file that
 * has not arrived yet is simply a refresh still running, and there is nothing to give up
 * on. Once the user has chosen there is, and a poll that kept its timer referenced past
 * that point would hold the process open with its answer already written — surfacing as a
 * bare `bun test` timeout with nothing pointing at the cause.
 *
 * @returns The replacement rows, or nothing if the picker closed first.
 */
async function landed(path: string): Promise<PickerRow<string>[] | undefined> {
  while (!existsSync(path)) {
    if (picked) return undefined;
    await Bun.sleep(25);
  }

  return JSON.parse(await Bun.file(path).text());
}

/** A control character by code point, for the sequences the document carries deliberately. */
const ctrl = (code: number): string => String.fromCodePoint(code);

const ESC = ctrl(0x1b);
const BEL = ctrl(0x07);

/**
 * Lines of filler, numbered so a scroll is visible as *which* lines are on screen.
 *
 * Longer than any pane the suite renders, so there is always somewhere to scroll to.
 */
const FILLER = 60;

/**
 * What the preview callback answers: everything a pane case needs to assert, in one document.
 *
 * The first two lines state the arguments the callback was handed, short enough to survive
 * the pane's own truncation — `w=` is how a width-aware case reads the width back out, and
 * `p=` is how a follows-the-selection case reads the payload. Then a colour run, two
 * hyperlinks, and a line of sequences a terminal must never be handed, followed by numbered
 * filler.
 *
 * The second hyperlink is the one that is easy to miss: its scheme is fine and its *URI*
 * carries the hostile bytes, which is a path a line of raw escapes outside any link cannot
 * reach.
 */
function document(payload: string, width: number): string {
  return [
    `w=${width}`,
    `p=${payload}`,
    `${ESC}[31mcoloured${ESC}[39m`,
    `${ESC}]8;;https://example.com${BEL}linked${ESC}]8;;${BEL}`,
    `${ESC}]8;;https://example.com/${ctrl(0x9b)}2J${ctrl(0x202e)}${BEL}in-uri${ESC}]8;;${BEL}`,
    `${ESC}[2J${ESC}]0;pwned${BEL}${ctrl(0x202e)}hostile-kept`,
    ...Array.from(
      { length: FILLER },
      (_unused, index) => `n=${String(index + 1).padStart(3, "0")}`,
    ),
  ].join("\n");
}

/** What the picker's preview callback answers, and how slowly. */
async function preview(payload: string, width: number): Promise<string> {
  // Async on purpose: `previewPullRequest` is, and a pane that only ever saw a resolved
  // value would not exercise the load the component has to hold a frame through. Under
  // `slow` the first row answers late, which is what lets a test move off it and check that
  // the answer it left behind never lands on the row it moved to.
  await Bun.sleep(process.env.PROBE_PREVIEW === "slow" && payload.endsWith("wt-0") ? 500 : 0);

  if (process.env.PROBE_PREVIEW === "throw") throw new Error("preview exploded");
  return document(payload, width);
}

const file = process.env.PROBE_ROWS_FILE;
const rows: PickerRow<string>[] = file
  ? JSON.parse(await Bun.file(file).text())
  : generated(Number(process.env.PROBE_COUNT ?? 200));

const replaceFile = process.env.PROBE_REPLACE_FILE;

try {
  const chosen = await pick({
    rows,
    // Withheld rather than passed as `undefined`, so a scenario that wants no pane exercises
    // the same shape a caller with no preview to show does.
    ...(process.env.PROBE_PREVIEW ? { preview } : {}),
    onOpen: replaceFile
      ? (replace) => {
          landed(replaceFile).then((next) => {
            if (next) replace(next);
          });
        }
      : undefined,
  });

  picked = true;
  process.stdout.write(JSON.stringify(chosen));
} catch (error) {
  if (!(error instanceof NotATerminal)) throw error;
  process.stderr.write(`refused: ${error.message}\n`);
  process.exitCode = 1;
}
