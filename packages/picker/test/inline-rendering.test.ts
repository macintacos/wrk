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
 * **The finding, in one line: a frame strictly shorter than the viewport renders inline; a
 * frame that reaches the viewport height takes the screen.** There is no third behaviour
 * and no gradual degradation — it is a threshold.
 *
 * Ink decides this per frame, in `shouldClearTerminalForFrame` (`ink/build/ink.js`), from
 * `outputHeight` against the rows of the stream it renders to. Under the threshold it
 * redraws through `log-update`, which only ever erases lines and steps the cursor up
 * relatively; at or over it, it writes an erase-screen and replays its own static output.
 * So "renders inline" is a property of the byte stream, and the tests below read it there
 * rather than inferring it.
 *
 * Measured in a 24-row pty, with 40 lines of scrollback and a prompt beneath them, over a
 * 200-item list:
 *
 * | Frame height | Screen erases | Deepest cursor rise | Absolute addressing |
 * | --- | --- | --- | --- |
 * | 19 rows (~80%) | 0 | 19 — its own frame, never a row above | no |
 * | 23 rows (96%) | 0 | 23 | no |
 * | 24 rows (100%) | 2 | 23 | yes |
 * | 30 rows (125%) | 3 | 0 — it stops redrawing relatively at all | yes |
 *
 * **The threshold is exactly `outputHeight >= viewportRows`.** 23 rows in a 24-row terminal
 * is still fully inline; 24 is not. So the ~80% budget is chosen headroom, not the boundary
 * — the margin exists because a picker's height is computed rather than constant, and every
 * border, padding row and status line spends some of it.
 *
 * **What this obliges the picker to do** (EXC-1011 onward): compute its height from the
 * rows of the stream it renders to, keep the total strictly under that number, and
 * recompute on `SIGWINCH`. A row budget derived from anything else, or a component whose
 * height can grow by one under some input, is the failure mode this threshold produces. The
 * third group of [`./ink-gotchas.test.ts`](./ink-gotchas.test.ts) covers the commonest way
 * it grows.
 *
 * **What is proven, precisely.** These are claims about the sequences Ink emits, read from
 * a real pty; nothing here emulates a terminal, so none of them is a claim about pixels.
 * "The prompt survives" is established as *Ink never emits a sequence capable of reaching
 * it* — it neither erases the screen nor walks the cursor above its own frame — rather than
 * by inspecting a rendered screen. Two cases stay deliberately out of scope: a resize
 * (`SIGWINCH`) mid-session, and another process writing to the same terminal while a frame
 * is resident. The second breaks every inline renderer that has ever existed and is not a
 * property of this substrate.
 *
 * The stderr requirement is asserted here too, since it is the same run: `packages/wrk`'s
 * output contract gives stdout to the machine, so the component is constructed against
 * stderr and stdout stays empty.
 *
 * @packageDocumentation
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  ERASE_SCREEN,
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

/** Where the stdout-separation case sends the probe's stdout. Removed by `afterAll`. */
const PAYLOAD = `${tmpdir()}/EXC-1009-stdout-${process.pid}.txt`;

/**
 * A pty session that looks like a real one: scrollback past the viewport, a prompt at the
 * bottom, then the probe rendering over a list far longer than the window it gets.
 *
 * The prompt line ends in a newline, so the frame starts on the line beneath it. That is
 * the shape a picker actually meets — a prompt left mid-line puts the cursor *on* it, and
 * anything drawing from there overwrites it as a matter of arithmetic rather than as a
 * property of Ink.
 */
function scenario(frameRows: number, redirectStdout = ""): string {
  const probe = `"${process.execPath}" "${import.meta.dir}/fixtures/inline-probe.tsx"`;

  return [
    `for i in $(seq 1 40); do echo "scrollback line $i"; done`,
    `printf '%s \\n' '${PROMPT}'`,
    `PROBE_ROWS=${frameRows} PROBE_ITEMS=200 ${probe}${redirectStdout && ` > "${redirectStdout}"`}`,
  ].join("\n");
}

describe("inline rendering under scrolling", () => {
  /**
   * One session, shared by every assertion about the ~80% frame.
   *
   * Not merely cheaper: the claims compose. "It never erased the screen **and** never rose
   * above its own frame" is only an argument about one terminal if both were observed in
   * the same one, and a spawn per test would leave each true of a different process.
   */
  let inline: string;

  beforeAll(async () => {
    const { capture, exitCode } = await runInPty(scenario(FRAME_ROWS), { rows: ROWS });

    expect(exitCode).toBe(0);
    inline = capture;
  });

  afterAll(() => rmSync(PAYLOAD, { force: true }));

  test("a frame under the viewport height never takes over the screen", () => {
    expect(inline).not.toContain(ERASE_SCREEN);
    // Absolute addressing is the other way a frame stops being cursor-relative.
    expect(hasAbsoluteAddressing(inline)).toBe(false);
  });

  test("a frame over the viewport height does take over the screen", async () => {
    // The control. Without it the assertion above is unfalsifiable, and it is also what
    // pins the threshold the picker has to stay under. Both properties are asserted
    // positively here, so neither negative above can pass by never having been exercised.
    const { capture } = await runInPty(scenario(ROWS + 6), { rows: ROWS });

    expect(capture).toContain(ERASE_SCREEN);
    expect(hasAbsoluteAddressing(capture)).toBe(true);
  });

  test("redrawing walks the cursor up exactly its own frame, never further", () => {
    // The mechanism by which an inline renderer eats the prompt is erasing more lines than
    // it drew, so the deepest walk in the session is the blast radius. Pinned to the exact
    // value rather than bounded above: Ink throttles at 30 fps and the probe ticks faster,
    // so redraws can coalesce — and had they all coalesced into one, an upper bound would
    // be satisfied by a session that never redrew at all.
    expect(maxCursorRise(inline)).toBe(FRAME_ROWS);
  });

  test("the cursor is hidden while rendering and visible again on exit", () => {
    // `indexOf`, not `lastIndexOf`: the capture ends with two show-cursor writes, so
    // slicing from the last would leave six bytes that trivially contain no movement. The
    // first show is emitted at unmount, so everything after it is real teardown.
    const teardown = inline.slice(inline.indexOf(SHOW_CURSOR));

    expect(inline).toContain(HIDE_CURSOR);
    expect(inline.indexOf(SHOW_CURSOR)).toBeGreaterThan(inline.indexOf(HIDE_CURSOR));
    // Nothing moves the cursor back up or elsewhere after the final frame, so it is left
    // on the line below the frame — where the shell expects to resume.
    expect(maxCursorRise(teardown)).toBe(0);
    expect(hasAbsoluteAddressing(teardown)).toBe(false);
  });

  test("what renders is a window onto a list far longer than it", () => {
    // "More rows than fit" is half the first criterion, and it is also what makes the
    // redraws above real work rather than a static frame Ink would dedupe away.
    expect(inline).toContain("item 0");
    expect(inline).toContain(`item ${FRAME_ROWS - 1}`);
    expect(inline).not.toContain("item 199");
  });

  test("frames go to stderr, leaving stdout free for the machine channel", async () => {
    // `packages/wrk/src/output.ts` promises stdout is one JSON document per run, so an
    // interactive component that renders there breaks every caller that pipes through jq.
    const { capture } = await runInPty(scenario(FRAME_ROWS, PAYLOAD), { rows: ROWS });

    expect(capture).toContain("item 0");
    expect(await Bun.file(PAYLOAD).text()).toBe("");
  });
});
