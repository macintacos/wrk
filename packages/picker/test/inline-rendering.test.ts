/**
 * The load-bearing assumption behind the picker substrate, held down by assertions.
 *
 * The whole substrate choice rested on one unproven claim: that Ink can render **inline**,
 * at roughly 80% of terminal height, near the bottom of a terminal that has already
 * scrolled, without seizing the screen or destroying the prompt above it. Inline rendering
 * is cursor-relative by nature and a scroll is exactly what breaks relative addressing, so
 * if the claim were false the substrate was to be reopened rather than worked around. It
 * holds, and this file is why.
 *
 * **The finding, in one line: a frame strictly shorter than the viewport renders inline;
 * a frame that reaches the viewport height takes the screen.** There is no third
 * behaviour and no gradual degradation — it is a threshold, and the ~80% budget is the
 * headroom that keeps a picker on the safe side of it.
 *
 * Ink decides this per frame, in `shouldClearTerminalForFrame` (`ink/build/ink.js`), from
 * `outputHeight` against the rows of the stream it renders to. Under the threshold it
 * redraws through `log-update`, which only ever erases lines and steps the cursor up
 * relatively; at or over it, it writes `clearTerminal` and replays its own static output —
 * losing everything the shell had put on screen, the prompt included. So "renders inline"
 * is a property of the byte stream, and the tests below read it there rather than
 * inferring it.
 *
 * Measured in a 24-row pty, with 40 lines of scrollback and a prompt beneath them, over a
 * 200-item list:
 *
 * | Frame height | Screen clears | Deepest cursor rise |
 * | --- | --- | --- |
 * | 19 rows (~80%) | 0 | 19 rows — its own frame, never a row above |
 * | 30 rows (125%) | 3 | 0 rows — it does not redraw relatively at all |
 *
 * The 19-row row is the answer to the spike. The 30-row row is what makes it an answer
 * rather than an assumption: the same harness detects the failure it is claiming not to
 * see, and the bound in the third column is tight, so a picker that grows to 20 rows in a
 * 24-row terminal fails this file rather than failing on a user's screen.
 *
 * **What this obliges the picker to do** (EXC-1011 onward): compute its height from the
 * rows of the stream it renders to, keep the total — every border, padding row and status
 * line included — strictly under that number, and recompute on `SIGWINCH`. A row budget
 * derived from anything else, or a component whose height can grow by one under some
 * input, is the failure mode this threshold produces. `fixed-width` in
 * [`./ink-gotchas.test.ts`](./ink-gotchas.test.ts) covers the commonest way it grows.
 *
 * The stderr requirement is asserted here too, since it is the same run: `packages/wrk`'s
 * output contract gives stdout to the machine, so the component is constructed against
 * stderr and stdout stays empty.
 *
 * @packageDocumentation
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

import {
  CLEAR_TERMINAL,
  HIDE_CURSOR,
  hasAbsoluteAddressing,
  maxCursorRise,
  runInPty,
  SHOW_CURSOR,
} from "./fixtures/pty";

/** The viewport every scenario below runs in. */
const ROWS = 24;

/** ~80% of {@link ROWS} — the height the picker is specified to occupy. */
const FRAME_ROWS = 19;

/** Written into the scrollback before the probe starts, standing in for a shell prompt. */
const PROMPT = "PROMPT-MARKER$";

/**
 * A pty session that looks like a real one: scrollback past the viewport, a prompt at the
 * bottom, then the probe rendering over a list far longer than the window it gets.
 */
function scenario(frameRows: number, redirectStdout = ""): string {
  const probe = `${process.execPath} ${import.meta.dir}/fixtures/inline-probe.tsx`;

  return [
    `for i in $(seq 1 40); do echo "scrollback line $i"; done`,
    `printf '%s \\n' '${PROMPT}'`,
    `PROBE_ROWS=${frameRows} PROBE_ITEMS=200 ${probe}${redirectStdout && ` > ${redirectStdout}`}`,
  ].join("\n");
}

describe("inline rendering under scrolling", () => {
  test("a frame under the viewport height never takes over the screen", async () => {
    const { capture, exitCode } = await runInPty(scenario(FRAME_ROWS), { rows: ROWS });

    expect(exitCode).toBe(0);
    expect(capture).not.toContain(CLEAR_TERMINAL);
    // Absolute addressing is the other way a frame stops being cursor-relative.
    expect(hasAbsoluteAddressing(capture)).toBe(false);
  });

  test("a frame over the viewport height does take over the screen", async () => {
    // The control. Without it the assertion above is unfalsifiable, and this is also what
    // pins the threshold the picker has to stay under: strictly fewer rows than the
    // viewport, which is the whole reason the height budget is ~80% and not ~100%.
    const { capture } = await runInPty(scenario(ROWS + 6), { rows: ROWS });

    expect(capture).toContain(CLEAR_TERMINAL);
  });

  test("redrawing never walks the cursor above its own frame", async () => {
    // The mechanism by which an inline renderer eats the prompt: erasing more lines than
    // it drew. Every redraw is a relative walk up, so the deepest walk in the whole
    // session is the blast radius.
    const { capture } = await runInPty(scenario(FRAME_ROWS), { rows: ROWS });

    expect(maxCursorRise(capture)).toBeLessThanOrEqual(FRAME_ROWS);
  });

  test("the prompt is written once and never reprinted", async () => {
    // A frame that stayed inline cannot have destroyed the prompt: it never erased above
    // itself (the test above), and it never cleared the screen (the first test). The
    // remaining way to lose it is the clear-and-replay path, which reprints Ink's own
    // static output and drops the shell's — so a second occurrence, or none, is the
    // signature of that path having run.
    const { capture } = await runInPty(scenario(FRAME_ROWS), { rows: ROWS });

    expect(capture.split(PROMPT).length - 1).toBe(1);
  });

  test("the cursor is hidden while rendering and visible again on exit", async () => {
    const { capture, exitCode } = await runInPty(scenario(FRAME_ROWS), { rows: ROWS });

    expect(exitCode).toBe(0);
    expect(capture).toContain(HIDE_CURSOR);
    expect(capture.lastIndexOf(SHOW_CURSOR)).toBeGreaterThan(capture.lastIndexOf(HIDE_CURSOR));
    // Nothing moves the cursor back up after the final frame, so it lands below it.
    expect(maxCursorRise(capture.slice(capture.lastIndexOf(SHOW_CURSOR)))).toBe(0);
  });

  test("frames go to stderr, leaving stdout free for the machine channel", async () => {
    // `packages/wrk/src/output.ts` promises stdout is one JSON document per run, so an
    // interactive component that renders there breaks every caller that pipes through jq.
    const payload = `${tmpdir()}/EXC-1009-stdout-${process.pid}.txt`;
    const { capture } = await runInPty(scenario(FRAME_ROWS, payload), { rows: ROWS });

    expect(capture).toContain("item 0");
    expect(await Bun.file(payload).text()).toBe("");
  });
});
