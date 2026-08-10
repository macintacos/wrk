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

import { NotATerminal, type PickerRow, pick } from "../../src/index";

/** Synthetic rows: a short first column and a long second one, both varying in width. */
function generated(count: number): PickerRow<string>[] {
  return Array.from({ length: count }, (_unused, index) => ({
    payload: `/worktrees/wt-${index}`,
    columns: [{ text: `wt-${index}` }, { text: `feature/thing-${index}` }],
  }));
}

const file = process.env.PROBE_ROWS_FILE;
const rows: PickerRow<string>[] = file
  ? JSON.parse(await Bun.file(file).text())
  : generated(Number(process.env.PROBE_COUNT ?? 200));

try {
  process.stdout.write(JSON.stringify(await pick({ rows })));
} catch (error) {
  if (!(error instanceof NotATerminal)) throw error;
  process.stderr.write(`refused: ${error.message}\n`);
  process.exitCode = 1;
}
