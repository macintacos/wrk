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

const file = process.env.PROBE_ROWS_FILE;
const rows: PickerRow<string>[] = file
  ? JSON.parse(await Bun.file(file).text())
  : generated(Number(process.env.PROBE_COUNT ?? 200));

const replaceFile = process.env.PROBE_REPLACE_FILE;

try {
  const chosen = await pick({
    rows,
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
