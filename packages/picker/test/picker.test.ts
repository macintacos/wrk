/**
 * The picker, driven in a real terminal.
 *
 * [`./inline-rendering.test.ts`](./inline-rendering.test.ts) settled that *Ink* can render
 * inline; this file settles that *the picker* does, and everything else the component
 * promises. Every case runs the component as a child process attached to a pty and reads
 * the bytes it wrote, because that is the only place the answers live: `isTTY` decides
 * whether raw mode is available and whether Ink renders interactively at all, the stream's
 * row count decides the height budget, and a highlight is an escape sequence or it is
 * nothing.
 *
 * A capture is still a log of bytes rather than a screen — the caveat
 * [`./fixtures/pty.ts`](./fixtures/pty.ts) states applies here unchanged. What is new is
 * that the sessions are *driven*: keys are typed and the window is resized while the picker
 * is running, so the claims are about the frames a user would actually provoke.
 *
 * @packageDocumentation
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  ERASE_SCREEN,
  frameHeight,
  frameLines,
  hasAbsoluteAddressing,
  hasColour,
  KEY,
  lastFrame,
  maxCursorRise,
  type PtyRun,
  type PtySession,
  runInPty,
} from "./fixtures/pty";

/** The viewport every scenario runs in, matching the spike's. */
const ROWS = 24;

/** One query line plus `floor(24 × 0.8) - 1` list rows — what the budget works out to. */
const FRAME = 19;

/** Switch to the alternate screen buffer, which the picker must never emit. */
const ALTERNATE_SCREEN = `${String.fromCodePoint(0x1b)}[?1049h`;

/** Written into the scrollback before each probe, standing in for a shell prompt. */
const PROMPT = "PROMPT-MARKER$";

/** Files this file writes, removed in `afterAll`. */
const written: string[] = [];

/** A control character by code point, for the rows that carry hostile ones. */
const ctrl = (code: number): string => String.fromCodePoint(code);

/** A row as the probe's JSON expects it. */
interface Row {
  payload: string;
  columns: { text: string; width?: number; color?: string }[];
}

/**
 * Writes rows to a JSON file and answers the path.
 *
 * Named per issue and purpose because the temp directory is shared: a fixed name is another
 * run's file silently overwritten.
 */
function rowsFile(purpose: string, rows: Row[]): string {
  const path = `${tmpdir()}/EXC-1011-${purpose}-${process.pid}.json`;
  writeFileSync(path, JSON.stringify(rows));
  written.push(path);
  return path;
}

/**
 * A pty session that looks like a real one: scrollback past the viewport, a prompt at the
 * bottom, then the picker rendering beneath it.
 *
 * The same shape [`./inline-rendering.test.ts`](./inline-rendering.test.ts) uses, and for
 * the same reason — a prompt left mid-line puts the cursor on it, so anything drawing from
 * there overwrites it as arithmetic rather than as a property of the component.
 *
 * **Stdout is redirected away from the terminal in every scenario**, `/dev/null` unless the
 * test wants to read the payload. Not tidiness: the probe writes its answer to stdout, and
 * a pty where both streams land keeps that answer in the capture, where `frameLines` counts
 * it as one more rendered row. It is also the shape the picker actually ships in — the
 * `cd`-wrapping and agent-facing invocations both capture stdout — so a suite that never
 * redirected it would be testing the one configuration nobody runs.
 */
function scenario(env = "", options: { stdout?: string; pipedStdin?: boolean } = {}): string {
  const probe = `"${process.execPath}" "${import.meta.dir}/fixtures/picker-probe.ts"`;
  const stdin = options.pipedStdin ? "< /dev/null" : "";

  return [
    `for i in $(seq 1 40); do echo "scrollback line $i"; done`,
    `printf '%s \\n' '${PROMPT}'`,
    `${env} ${probe} > "${options.stdout ?? "/dev/null"}" ${stdin}`,
  ].join("\n");
}

/** Where a scenario's stdout is sent when the test wants to read the chosen payload. */
function payloadPath(purpose: string): string {
  const path = `${tmpdir()}/EXC-1011-${purpose}-stdout-${process.pid}.txt`;
  written.push(path);
  return path;
}

/**
 * Waits for the picker's first frame, then lets it finish attaching to the keyboard.
 *
 * The frame is written from a commit; `useInput`'s raw-mode setup is an effect that runs
 * around it. A key sent the instant the frame appears can land in the gap and be dropped —
 * which fails as a picker that ignored an arrow key, several assertions later.
 */
async function opened(pty: PtySession, marker: string): Promise<void> {
  await pty.waitFor(marker);
  await Bun.sleep(150);
}

afterAll(() => {
  for (const path of written) rmSync(path, { force: true });
});

describe("the picker renders inline", () => {
  /**
   * One driven session, shared by every claim about the ~80% frame.
   *
   * The claims compose, exactly as they do in the spike's own file: "it never erased the
   * screen **and** never rose above its own frame" is an argument about one terminal only
   * if both were observed in the same one. Typing before quitting is what makes the session
   * redraw at all — a first paint proves nothing about relative addressing.
   */
  let session: PtyRun;

  beforeAll(async () => {
    session = await runInPty(scenario(), {
      rows: ROWS,
      drive: async (pty) => {
        await opened(pty, "feature/thing-0");
        pty.write("thing");
        await pty.waitFor("thing-1");
        pty.write(KEY.escape);
      },
    });

    expect(session.exitCode).toBe(0);
  });

  test("it never takes the screen from the prompt above it", () => {
    expect(session.capture).not.toContain(ERASE_SCREEN);
    expect(session.capture).not.toContain(ALTERNATE_SCREEN);
    expect(hasAbsoluteAddressing(session.capture)).toBe(false);
  });

  test("redrawing walks the cursor up exactly its own frame, never further", () => {
    expect(maxCursorRise(session.capture)).toBe(FRAME);
  });

  test("the frame is the query line plus its list rows, strictly under the viewport", () => {
    expect(frameHeight(session.capture)).toBe(FRAME);
    expect(FRAME).toBeLessThan(ROWS);
  });

  test("a row far wider than the terminal still costs exactly one line", async () => {
    // The height-budget bug `ink-gotchas.test.ts` group three pins, arriving through the
    // data: a row that wraps is a frame one line taller than the budget allowed for.
    const path = rowsFile("wide", [
      { payload: "a", columns: [{ text: "x".repeat(400) }, { text: "y".repeat(400) }] },
      { payload: "b", columns: [{ text: "short" }, { text: "also short" }] },
    ]);

    const { capture } = await runInPty(scenario(`PROBE_ROWS_FILE="${path}"`), {
      rows: ROWS,
      cols: 40,
      drive: async (pty) => {
        await opened(pty, "short");
        pty.write(KEY.escape);
      },
    });

    // Query line plus the two rows, and not a line more.
    expect(frameHeight(capture)).toBe(3);
  });

  test("growing the viewport re-budgets the frame and disturbs nothing", async () => {
    // EXC-1009's third obligation. Nothing here handles SIGWINCH directly — Ink's
    // `useWindowSize` re-renders on the render stream's own `resize` event — so this is
    // the assertion that the budget is derived from that stream rather than read once.
    const { capture } = await runInPty(scenario(), {
      rows: ROWS,
      drive: async (pty) => {
        await opened(pty, "feature/thing-17");
        pty.resize(80, 30);
        await pty.waitFor("feature/thing-22");
        await Bun.sleep(200);
        pty.write(KEY.escape);
      },
    });

    // floor(30 × 0.8) - 1 = 23 list rows, plus the query line.
    expect(frameHeight(capture)).toBe(24);
    expect(capture).not.toContain(ERASE_SCREEN);
  });

  test("shrinking it re-budgets the frame too", async () => {
    // The frame settles inside the new budget, which is the criterion. What it does on the
    // way there is Ink's and not the picker's: `Ink.resized` re-lays out and writes the
    // *current* React tree synchronously, before the `useWindowSize` state update has been
    // processed, so a shrink puts one stale over-tall frame through
    // `shouldClearTerminalForFrame` and takes the screen for that one frame. It is a
    // property of any Ink app whose frame outgrows its viewport, not of this component, and
    // EXC-1009 left mid-session resize explicitly out of scope for that reason. Asserted as
    // "it comes back inline, correctly budgeted" rather than papered over.
    const { capture } = await runInPty(scenario(), {
      rows: ROWS,
      drive: async (pty) => {
        await opened(pty, "feature/thing-17");
        pty.resize(80, 12);
        await pty.waitFor("feature/thing-7");
        await Bun.sleep(200);
        pty.write(KEY.escape);
      },
    });

    // floor(12 × 0.8) - 1 = 8 list rows, plus the query line.
    expect(frameHeight(capture)).toBe(9);
  });

  test("frames go to stderr, leaving stdout for the payload", async () => {
    const stdout = payloadPath("streams");

    const { capture } = await runInPty(scenario("", { stdout }), {
      rows: ROWS,
      drive: async (pty) => {
        await opened(pty, "feature/thing-0");
        pty.write(KEY.enter);
      },
    });

    expect(capture).toContain("feature/thing-0");
    expect(await Bun.file(stdout).text()).toBe(`"/worktrees/wt-0"`);
  });
});

describe("filtering is incremental and never re-ranks", () => {
  /** Two rows a scorer would order one way and insertion order the other. */
  const ORDERED = [
    { payload: "first", columns: [{ text: "zebra apple" }] },
    { payload: "second", columns: [{ text: "apple" }] },
    { payload: "third", columns: [{ text: "nothing here" }] },
  ];

  test("typing narrows the list, and only matching rows survive", async () => {
    const path = rowsFile("order", ORDERED);

    const { capture } = await runInPty(scenario(`PROBE_ROWS_FILE="${path}"`), {
      rows: ROWS,
      drive: async (pty) => {
        await opened(pty, "nothing here");
        pty.write("apple");
        await Bun.sleep(200);
        pty.write(KEY.escape);
      },
    });

    const lines = frameLines(capture);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("apple");
    expect(lines.join("\n")).not.toContain("nothing here");
  });

  test("the survivors keep their input order rather than their scores", async () => {
    // fzf scores a whole-string match above one buried behind a word, so a picker that
    // sorted would put `apple` first. This is the criterion that forbids that.
    const path = rowsFile("order", ORDERED);

    const { capture } = await runInPty(scenario(`PROBE_ROWS_FILE="${path}"`), {
      rows: ROWS,
      drive: async (pty) => {
        await opened(pty, "nothing here");
        pty.write("apple");
        await Bun.sleep(200);
        pty.write(KEY.escape);
      },
    });

    const [, first, second] = frameLines(capture);

    expect(first).toContain("zebra apple");
    expect(second).not.toContain("zebra");
  });

  test("backspace widens it again", async () => {
    const path = rowsFile("order", ORDERED);

    const { capture } = await runInPty(scenario(`PROBE_ROWS_FILE="${path}"`), {
      rows: ROWS,
      drive: async (pty) => {
        await opened(pty, "nothing here");
        pty.write("apple");
        await Bun.sleep(150);
        for (const _unused of "apple") {
          pty.write(KEY.backspace);
          await Bun.sleep(50);
        }
        await Bun.sleep(150);
        pty.write(KEY.escape);
      },
    });

    expect(frameLines(capture)).toHaveLength(4);
  });

  test("the matched characters are highlighted where they sit", async () => {
    const path = rowsFile("highlight", [{ payload: "a", columns: [{ text: "alpha" }] }]);

    const { capture } = await runInPty(scenario(`PROBE_ROWS_FILE="${path}"`), {
      rows: ROWS,
      drive: async (pty) => {
        await opened(pty, "alpha");
        pty.write("lph");
        await Bun.sleep(200);
        pty.write(KEY.escape);
      },
    });

    // Asserted as "some SGR sequence opens immediately before the matched run" rather than
    // as a specific colour code, so the claim is about the highlight existing in the right
    // place and not about which colour chalk picked for it.
    const highlighted = new RegExp(`${ctrl(0x1b)}\\[[\\d;]*mlph`);

    expect(lastFrame(capture)).toMatch(highlighted);
    // And the characters the query did not match are not inside that run.
    expect(lastFrame(capture)).not.toMatch(new RegExp(`${ctrl(0x1b)}\\[[\\d;]*malpha`));
  });
});

describe("rows carry columns and an identity of their own", () => {
  test("columns align on a width derived from the widest cell", async () => {
    const path = rowsFile("align", [
      { payload: "a", columns: [{ text: "wt" }, { text: "alpha" }] },
      { payload: "b", columns: [{ text: "worktree" }, { text: "beta" }] },
    ]);

    const { capture } = await runInPty(scenario(`PROBE_ROWS_FILE="${path}"`), {
      rows: ROWS,
      drive: async (pty) => {
        await opened(pty, "beta");
        pty.write(KEY.escape);
      },
    });

    const [, first, second] = frameLines(capture);

    expect(first?.indexOf("alpha")).toBe(second?.indexOf("beta") ?? -1);
    expect(first?.indexOf("alpha")).toBeGreaterThan(0);
  });

  test("Enter resolves the payload, which never appeared on screen", async () => {
    const stdout = payloadPath("payload");
    const path = rowsFile("payload", [
      { payload: "/worktrees/alpha", columns: [{ text: "alpha" }] },
      { payload: "/worktrees/beta", columns: [{ text: "beta" }] },
    ]);

    const { capture } = await runInPty(scenario(`PROBE_ROWS_FILE="${path}"`, { stdout }), {
      rows: ROWS,
      drive: async (pty) => {
        await opened(pty, "beta");
        pty.write(KEY.down);
        await Bun.sleep(150);
        pty.write(KEY.enter);
      },
    });

    expect(await Bun.file(stdout).text()).toBe(`"/worktrees/beta"`);
    // The identity is not the displayed text — the criterion this row shape exists for.
    expect(capture).not.toContain("/worktrees/");
  });

  test("Escape resolves nothing", async () => {
    const stdout = payloadPath("cancel");

    const { capture, exitCode } = await runInPty(scenario("", { stdout }), {
      rows: ROWS,
      drive: async (pty) => {
        await opened(pty, "feature/thing-0");
        pty.write(KEY.escape);
      },
    });

    expect(exitCode).toBe(0);
    expect(capture).toContain("feature/thing-0");
    expect(await Bun.file(stdout).text()).toBe("null");
  });
});

describe("it degrades rather than crashing or hanging", () => {
  test("piped stdin is refused, with nothing drawn and nothing waiting", async () => {
    // The decision `ink-gotchas.test.ts` group one demanded and deliberately left open.
    // Both wrong answers are asserted against: the unguarded crash, and the guard that
    // renders a picker which accepts no key.
    const { capture, exitCode } = await runInPty(scenario("", { pipedStdin: true }), {
      rows: ROWS,
    });

    expect(exitCode).not.toBe(0);
    expect(capture).toContain("refused:");
    expect(capture).not.toContain("Raw mode is not supported");
    expect(capture).not.toContain("feature/thing-0");
  });

  test("a row given a colour is coloured", async () => {
    // The control. Without it the next case passes on a picker that never styles anything.
    const path = rowsFile("colour", [
      { payload: "a", columns: [{ text: "alpha", color: "green" }] },
    ]);

    const { capture } = await runInPty(scenario(`PROBE_ROWS_FILE="${path}"`), {
      rows: ROWS,
      drive: async (pty) => {
        await opened(pty, "alpha");
        pty.write(KEY.escape);
      },
    });

    expect(hasColour(capture)).toBe(true);
  });

  test("NO_COLOR switches every escape of its own off", async () => {
    // Gotcha two: the variable does not reach chalk under Bun, so honouring it is the
    // picker's own work. A row carrying colour in its *text* is in the fixture because
    // that colour is still colour — passing it through would honour the letter and break
    // the setting.
    const path = rowsFile("no-colour", [
      { payload: "a", columns: [{ text: `${ctrl(0x1b)}[31malpha${ctrl(0x1b)}[39m` }] },
      { payload: "b", columns: [{ text: "beta", color: "green" }] },
    ]);

    const { capture } = await runInPty(scenario(`NO_COLOR=1 PROBE_ROWS_FILE="${path}"`), {
      rows: ROWS,
      drive: async (pty) => {
        await opened(pty, "beta");
        pty.write("a");
        await Bun.sleep(200);
        pty.write(KEY.escape);
      },
    });

    expect(hasColour(capture)).toBe(false);
    expect(capture).toContain("alpha");
  });

  test("hostile row text never reaches the terminal", async () => {
    const path = rowsFile("hostile", [
      {
        payload: "a",
        columns: [
          {
            text: [
              "fix",
              `${ctrl(0x1b)}[2J`,
              `${ctrl(0x1b)}]0;pwned${ctrl(0x07)}`,
              `${ctrl(0x9b)}10;1H`,
              ctrl(0x0a),
              "the-bug",
            ].join(""),
          },
        ],
      },
    ]);

    const { capture } = await runInPty(scenario(`PROBE_ROWS_FILE="${path}"`), {
      rows: ROWS,
      drive: async (pty) => {
        await opened(pty, "fixthe-bug");
        pty.write(KEY.escape);
      },
    });

    expect(capture).not.toContain(ERASE_SCREEN);
    expect(capture).not.toContain("pwned");
    expect(hasAbsoluteAddressing(capture)).toBe(false);
    // The visible characters survive; only the instructions are gone.
    expect(frameLines(capture)[1]).toContain("fixthe-bug");
  });
});
