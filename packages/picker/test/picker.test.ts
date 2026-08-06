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
import { renameSync, rmSync, writeFileSync } from "node:fs";
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
  columns: { text: string; color?: string }[];
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

/**
 * Reserves the path a probe waits on for its replacement rows, and makes sure it is absent.
 *
 * The probe treats the file's *existence* as the cue, so a leftover from an earlier run
 * would fire the replacement before the test typed anything.
 */
function replacePath(purpose: string): string {
  const path = `${tmpdir()}/EXC-1013-${purpose}-replace-${process.pid}.json`;
  rmSync(path, { force: true });
  written.push(path);
  return path;
}

/**
 * Drops the replacement rows where the probe is waiting, atomically.
 *
 * Written beside the target and renamed onto it, because a plain write is visible to the
 * probe's `existsSync` the instant it is created and would be read back half-formed.
 */
function landRows(path: string, rows: Row[]): void {
  writeFileSync(`${path}.part`, JSON.stringify(rows));
  renameSync(`${path}.part`, path);
}

/** Where a scenario's stdout is sent when the test wants to read the chosen payload. */
function payloadPath(purpose: string): string {
  const path = `${tmpdir()}/EXC-1011-${purpose}-stdout-${process.pid}.txt`;
  written.push(path);
  return path;
}

/** A driven run, plus the frame as it stood before the picker erased it on the way out. */
interface Session {
  /** Everything the terminal received. */
  readonly capture: string;
  /** The last frame drawn while the picker was up — what a viewer was looking at. */
  readonly frame: string;
  readonly exitCode: number;
}

/**
 * Runs a scenario, drives it, snapshots the frame, and quits.
 *
 * The snapshot is why this exists rather than a bare {@link runInPty}. `pick()` erases its
 * own frame on the way out, so a capture read after the process exits has no frame left in
 * it — every assertion about what was *displayed* has to be taken while the picker is still
 * up, and taking it in one place is what keeps that from being remembered eleven times.
 *
 * @param script - A {@link scenario}.
 * @param options - `act` drives the session and returns once the frame under test has
 *   settled; `quit` is the key that ends it, Escape unless a test needs Enter.
 */
async function driven(
  script: string,
  options: {
    rows?: number;
    cols?: number;
    quit?: string;
    act: (pty: PtySession) => Promise<void>;
  },
): Promise<Session> {
  let frame = "";

  const run = await runInPty(script, {
    rows: options.rows ?? ROWS,
    cols: options.cols,
    drive: async (pty) => {
      await options.act(pty);
      frame = pty.capture();
      pty.write(options.quit ?? KEY.escape);
    },
  });

  return { ...run, frame };
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

/** Waits until the last frame is exactly `count` lines tall. */
function tall(count: number): (capture: string) => boolean {
  return (capture) => frameLines(capture).length === count;
}

/**
 * Waits until the gutter marks the row beginning with `label`.
 *
 * Over `frameLines` rather than the raw frame, because the gutter and the row it marks are
 * separated by the escape sequences that colour them: `▌ beta` is what a viewer sees and
 * never what the bytes say.
 */
function selects(label: string): (capture: string) => boolean {
  return (capture) => frameLines(capture).some((line) => line.startsWith(`▌ ${label}`));
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
  let session: Session;

  beforeAll(async () => {
    session = await driven(scenario(), {
      act: async (pty) => {
        await opened(pty, "feature/thing-0");
        pty.write("thing-1");
        await pty.waitUntil(tall(FRAME));
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
    expect(frameHeight(session.frame)).toBe(FRAME);
    expect(FRAME).toBeLessThan(ROWS);
  });

  test("it erases its own frame on the way out", () => {
    // `fzf` does this, and a `cd`-wrapping shell function is run dozens of times a day: a
    // picker that left nineteen lines behind would push the prompt down the screen on every
    // invocation. Erasing is not clearing — the assertion above that no erase-screen was
    // ever emitted covers the same session.
    expect(frameLines(session.capture)).toHaveLength(0);
  });

  test("a row far wider than the terminal still costs exactly one line", async () => {
    // The height-budget bug `ink-gotchas.test.ts` group three pins, arriving through the
    // data: a row that wraps is a frame one line taller than the budget allowed for.
    const path = rowsFile("wide", [
      { payload: "a", columns: [{ text: "x".repeat(400) }, { text: "y".repeat(400) }] },
      { payload: "b", columns: [{ text: "short" }, { text: "also short" }] },
    ]);

    const { frame } = await driven(scenario(`PROBE_ROWS_FILE="${path}"`), {
      cols: 40,
      act: (pty) => opened(pty, "short"),
    });

    // Query line plus the two rows, and not a line more.
    expect(frameHeight(frame)).toBe(3);
  });

  test("growing the viewport re-budgets the frame and disturbs nothing", async () => {
    // EXC-1009's third obligation. Nothing here handles SIGWINCH directly — Ink's
    // `useWindowSize` re-renders on the render stream's own `resize` event — so this is
    // the assertion that the budget is derived from that stream rather than read once.
    const { frame, capture } = await driven(scenario(), {
      act: async (pty) => {
        await opened(pty, "feature/thing-17");
        pty.resize(80, 30);
        // floor(30 × 0.8) - 1 = 23 list rows, plus the query line.
        await pty.waitUntil(tall(24));
      },
    });

    expect(frameHeight(frame)).toBe(24);
    expect(capture).not.toContain(ERASE_SCREEN);
  });

  test("shrinking it re-budgets the frame too", async () => {
    // The frame settles inside the new budget, which is the criterion. What it does on the
    // way there is Ink's rather than the picker's — see `picker.tsx`'s module header, which
    // records why a shrink puts one stale over-tall frame through the fullscreen path and
    // why EXC-1009 left mid-session resize out of scope. Asserted as "it comes back inline,
    // correctly budgeted" rather than papered over.
    const { frame } = await driven(scenario(), {
      act: async (pty) => {
        await opened(pty, "feature/thing-17");
        pty.resize(80, 12);
        // floor(12 × 0.8) - 1 = 8 list rows, plus the query line.
        await pty.waitUntil(tall(9));
      },
    });

    expect(frameHeight(frame)).toBe(9);
  });

  test("frames go to stderr, leaving stdout for the payload", async () => {
    const stdout = payloadPath("streams");

    const { capture } = await driven(scenario("", { stdout }), {
      quit: KEY.enter,
      act: (pty) => opened(pty, "feature/thing-0"),
    });

    expect(capture).toContain("feature/thing-0");
    expect(await Bun.file(stdout).text()).toBe(`"/worktrees/wt-0"`);
  });
});

describe("filtering is incremental and never re-ranks", () => {
  /** Three rows a scorer would order one way and insertion order the other. */
  const ORDERED = [
    { payload: "first", columns: [{ text: "zebra apple" }] },
    { payload: "second", columns: [{ text: "apple" }] },
    { payload: "third", columns: [{ text: "nothing here" }] },
  ];

  /** Types `apple` into the three-row list and waits for the two survivors. */
  async function filtered(purpose: string): Promise<Session> {
    const path = rowsFile(purpose, ORDERED);

    return driven(scenario(`PROBE_ROWS_FILE="${path}"`), {
      act: async (pty) => {
        await opened(pty, "nothing here");
        pty.write("apple");
        await pty.waitUntil(tall(3));
      },
    });
  }

  test("typing narrows the list, and only matching rows survive", async () => {
    const { frame } = await filtered("order");
    const lines = frameLines(frame);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("❯ apple");
    expect(lines.join("\n")).not.toContain("nothing here");
  });

  test("the survivors keep their input order rather than their scores", async () => {
    // fzf scores a whole-string match above one buried behind a word, so a picker that
    // sorted would put `apple` first. This is the criterion that forbids that.
    const [, first, second] = frameLines((await filtered("order")).frame);

    expect(first).toContain("zebra apple");
    expect(second).not.toContain("zebra");
  });

  test("a query that matches nothing says so", async () => {
    const path = rowsFile("order", ORDERED);

    const { frame } = await driven(scenario(`PROBE_ROWS_FILE="${path}"`), {
      act: async (pty) => {
        await opened(pty, "nothing here");
        pty.write("zzzz");
        await pty.waitUntil(tall(2));
      },
    });

    // An empty list under a query line reads the same as a picker that stopped working, and
    // Enter there resolves `null`, which a caller maps to a cancellation and prints nothing.
    expect(frameLines(frame)[1]).toContain("no matches");
  });

  test("backspace widens it again", async () => {
    // From a query that matches nothing back to one that matches two, on one keystroke —
    // the filter has to run on the way out as well as on the way in.
    const path = rowsFile("order", ORDERED);

    const { frame } = await driven(scenario(`PROBE_ROWS_FILE="${path}"`), {
      act: async (pty) => {
        await opened(pty, "nothing here");
        pty.write("applez");
        await pty.waitUntil(tall(2));
        pty.write(KEY.backspace);
        await pty.waitUntil(tall(3));
      },
    });

    const lines = frameLines(frame);

    expect(lines[0]).toBe("❯ apple");
    expect(lines[1]).toContain("zebra apple");
  });

  test("a burst of keys in one chunk is a burst of keys, not one", async () => {
    // Ink parses a stdin chunk into every event it holds and calls the `useInput` handler
    // for each one synchronously, without a re-render in between — which is what a held-down
    // key and ordinary fast typing both look like on the wire. Written as a single `write`
    // for exactly that reason: spacing the keys out is what hides a handler that reads stale
    // state, and every other case in this file spaces them out.
    const path = rowsFile("order", ORDERED);

    const { frame } = await driven(scenario(`PROBE_ROWS_FILE="${path}"`), {
      act: async (pty) => {
        await opened(pty, "nothing here");
        pty.write("apple");
        await pty.waitUntil(tall(3));
        pty.write(KEY.backspace.repeat(5));
        await pty.waitUntil((capture) => frameLines(capture)[0] === "❯");
      },
    });

    const lines = frameLines(frame);

    expect(lines[0]).toBe("❯");
    expect(lines).toHaveLength(4);
  });

  test("the matched characters are highlighted where they sit", async () => {
    const path = rowsFile("highlight", [{ payload: "a", columns: [{ text: "alpha" }] }]);

    const { frame } = await driven(scenario(`PROBE_ROWS_FILE="${path}"`), {
      act: async (pty) => {
        await opened(pty, "alpha");
        pty.write("lph");
        await pty.waitUntil((capture) => frameLines(capture)[0] === "❯ lph");
      },
    });

    // Asserted as "some SGR sequence opens immediately before the matched run" rather than
    // as a specific colour code, so the claim is about the highlight existing in the right
    // place and not about which colour chalk picked for it.
    const highlighted = new RegExp(`${ctrl(0x1b)}\\[[\\d;]*mlph`);

    expect(lastFrame(frame)).toMatch(highlighted);
    // And the characters the query did not match are not inside that run.
    expect(lastFrame(frame)).not.toMatch(new RegExp(`${ctrl(0x1b)}\\[[\\d;]*malpha`));
  });
});

describe("rows carry columns and an identity of their own", () => {
  test("columns align on a width derived from the widest cell", async () => {
    const path = rowsFile("align", [
      { payload: "a", columns: [{ text: "wt" }, { text: "alpha" }] },
      { payload: "b", columns: [{ text: "worktree" }, { text: "beta" }] },
    ]);

    const { frame } = await driven(scenario(`PROBE_ROWS_FILE="${path}"`), {
      act: (pty) => opened(pty, "beta"),
    });

    const [, first, second] = frameLines(frame);

    expect(first?.indexOf("alpha")).toBe(second?.indexOf("beta") ?? -1);
    expect(first?.indexOf("alpha")).toBeGreaterThan(0);
  });

  test("a column is measured in terminal cells, not code points", async () => {
    // A CJK title is half as many code points as it is columns wide. Sizing the box by code
    // points would cut the far half off every cell in the column and misplace everything
    // after it — and PR titles are exactly where this input arrives.
    const path = rowsFile("wide-glyphs", [
      { payload: "a", columns: [{ text: "日本語のタイトル" }, { text: "second" }] },
      { payload: "b", columns: [{ text: "ascii" }, { text: "second" }] },
    ]);

    const { frame } = await driven(scenario(`PROBE_ROWS_FILE="${path}"`), {
      act: (pty) => opened(pty, "ascii"),
    });

    const [, first] = frameLines(frame);

    expect(first).toContain("日本語のタイトル");
  });

  test("Enter resolves the payload, which never appeared on screen", async () => {
    const stdout = payloadPath("payload");
    const path = rowsFile("payload", [
      { payload: "/worktrees/alpha", columns: [{ text: "alpha" }] },
      { payload: "/worktrees/beta", columns: [{ text: "beta" }] },
    ]);

    const { capture } = await driven(scenario(`PROBE_ROWS_FILE="${path}"`, { stdout }), {
      quit: KEY.enter,
      act: async (pty) => {
        await opened(pty, "beta");
        pty.write(KEY.down);
        await pty.waitUntil(selects("beta"));
      },
    });

    expect(await Bun.file(stdout).text()).toBe(`"/worktrees/beta"`);
    // The identity is not the displayed text — the criterion this row shape exists for.
    expect(capture).not.toContain("/worktrees/");
  });

  test("a burst of arrows moves that many rows", async () => {
    // The selection half of the batched-keystroke case above: three downs in one chunk are
    // three rows, not one.
    const stdout = payloadPath("burst");

    const { exitCode } = await driven(scenario("", { stdout }), {
      quit: KEY.enter,
      act: async (pty) => {
        await opened(pty, "feature/thing-0");
        pty.write(KEY.down.repeat(3));
        await pty.waitUntil(selects("wt-3"));
      },
    });

    expect(exitCode).toBe(0);
    expect(await Bun.file(stdout).text()).toBe(`"/worktrees/wt-3"`);
  });

  test("Escape resolves nothing", async () => {
    const stdout = payloadPath("cancel");

    const { capture, exitCode } = await driven(scenario("", { stdout }), {
      act: (pty) => opened(pty, "feature/thing-0"),
    });

    expect(exitCode).toBe(0);
    expect(capture).toContain("feature/thing-0");
    expect(await Bun.file(stdout).text()).toBe("null");
  });
});

describe("the row set can be replaced while the picker is open", () => {
  /** Three worktrees as `wrk wt` first draws them, straight from a stale cache. */
  const PLAIN: Row[] = [
    { payload: "/wt/alpha", columns: [{ text: "wt-alpha" }] },
    { payload: "/wt/beta", columns: [{ text: "wt-beta" }] },
    { payload: "/wt/gamma", columns: [{ text: "wt-gamma" }] },
  ];

  /**
   * The same three annotated from the stack graph, plus a fourth the refresh discovered.
   *
   * Every way a replacement can move a row is in here at once, because each one on its own
   * would let an index-restoring picker keep passing: a new row above shifts the indices, a
   * longer name in column one widens it so the annotations sit further right, and a second
   * column appears where there was none. This is the shape EXC-1017 will actually deliver.
   */
  const ANNOTATED: Row[] = [
    { payload: "/wt/delta", columns: [{ text: "wt-delta-refreshed" }, { text: "#7 bottom" }] },
    { payload: "/wt/alpha", columns: [{ text: "wt-alpha" }, { text: "#41" }] },
    { payload: "/wt/beta", columns: [{ text: "wt-beta" }, { text: "#42" }] },
    { payload: "/wt/gamma", columns: [{ text: "wt-gamma" }, { text: "#43 top" }] },
  ];

  /** {@link ANNOTATED} minus the worktree that was removed while the picker was up. */
  const WITHOUT_GAMMA: Row[] = ANNOTATED.filter((row) => row.payload !== "/wt/gamma");

  /** A scenario wired for both files, since every case here needs the pair. */
  function replaceable(purpose: string, rows: Row[], stdout?: string): [string, string] {
    const replace = replacePath(purpose);
    const env = `PROBE_ROWS_FILE="${rowsFile(purpose, rows)}" PROBE_REPLACE_FILE="${replace}"`;

    return [scenario(env, { stdout }), replace];
  }

  /**
   * Waits until the replacement is fully drawn: `count` lines tall, and carrying `text`.
   *
   * Both halves are load-bearing. Height alone cannot see a replacement that keeps the row
   * count, and text alone is satisfied by the first line of a frame still being written —
   * which is a capture read one line short, several assertions later.
   *
   * Over `frameLines` for the same reason {@link selects} is: a query highlights the
   * characters it matched, so an annotation the query runs through is a dozen SGR sequences
   * on the wire and only reads as its own text once they are stripped.
   */
  function replaced(count: number, text: string): (capture: string) => boolean {
    return (capture) => {
      const lines = frameLines(capture);
      return lines.length === count && lines.some((line) => line.includes(text));
    };
  }

  test("the whole row set can be swapped from outside the render loop", async () => {
    const [script, replace] = replaceable("swap", PLAIN);

    const { frame } = await driven(script, {
      act: async (pty) => {
        await opened(pty, "wt-gamma");
        landRows(replace, ANNOTATED);
        await pty.waitUntil(replaced(5, "wt-delta-refreshed"));
      },
    });

    const lines = frameLines(frame);

    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain("wt-delta-refreshed");
    expect(lines.join("\n")).toContain("#43 top");
  });

  test("the cursor rides the payload it was on, not the index", async () => {
    const stdout = payloadPath("cursor");
    const [script, replace] = replaceable("cursor", PLAIN, stdout);

    const { frame } = await driven(script, {
      quit: KEY.enter,
      act: async (pty) => {
        await opened(pty, "wt-gamma");
        pty.write(KEY.down);
        await pty.waitUntil(selects("wt-beta"));
        landRows(replace, ANNOTATED);
        await pty.waitUntil(replaced(5, "wt-delta-refreshed"));
      },
    });

    // `wt-beta` was the second row and is now the third. A picker that restored the index
    // would leave the gutter one line higher, on `wt-alpha` — which is the row the user
    // would then choose without ever having moved onto it.
    expect(frameLines(frame)[3]).toMatch(/^▌ wt-beta/);
    expect(await Bun.file(stdout).text()).toBe(`"/wt/beta"`);
  });

  test("a replacement that drops the selected row sends the cursor to the top", async () => {
    const stdout = payloadPath("dropped");
    const [script, replace] = replaceable("dropped", PLAIN, stdout);

    const { frame } = await driven(script, {
      quit: KEY.enter,
      act: async (pty) => {
        await opened(pty, "wt-gamma");
        pty.write(KEY.down.repeat(2));
        await pty.waitUntil(selects("wt-gamma"));
        landRows(replace, WITHOUT_GAMMA);
        await pty.waitUntil(replaced(4, "wt-delta-refreshed"));
      },
    });

    expect(frameLines(frame)[1]).toMatch(/^▌ wt-delta-refreshed/);
    expect(await Bun.file(stdout).text()).toBe(`"/wt/delta"`);
  });

  test("a standing query survives the replacement and filters what arrived", async () => {
    // Deliberately sequential — the keystroke's frame has settled before the rows land, and
    // the claim is that the replacement leaves the query standing and re-runs it over what
    // arrived. `beta-stack` is an annotation that makes a row the query had already rejected
    // start matching it, so a query that was merely *kept* would not be enough.
    //
    // Two writers in one React batch is the other half of this, and no driven terminal can
    // schedule that on purpose; [`./reducer.test.ts`](./reducer.test.ts) applies the actions
    // directly for it.
    const stacked: Row[] = [
      { payload: "/wt/alpha", columns: [{ text: "wt-alpha" }, { text: "beta-stack" }] },
      { payload: "/wt/beta", columns: [{ text: "wt-beta" }, { text: "solo" }] },
      { payload: "/wt/gamma", columns: [{ text: "wt-gamma" }, { text: "none" }] },
    ];

    const [script, replace] = replaceable("query", PLAIN);

    const { frame } = await driven(script, {
      act: async (pty) => {
        await opened(pty, "wt-gamma");
        pty.write("beta");
        await pty.waitUntil((capture) => frameLines(capture)[0] === "❯ beta");
        landRows(replace, stacked);
        await pty.waitUntil(replaced(3, "beta-stack"));
      },
    });

    const lines = frameLines(frame);

    expect(lines[0]).toBe("❯ beta");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("beta-stack");
  });
});

describe("the preview pane sits beside the list", () => {
  /** The seam between the two panes — one column, and the only glyph that marks the split. */
  const SEAM = "│";

  /** The pane's share of the terminal, which the component splits 60/40. */
  const SHARE = 0.4;

  /**
   * The frame as one searchable string, list column and pane alike.
   *
   * Deliberately not pane-scoped: the two columns share every rendered line, so nothing short
   * of splitting on the seam separates them, and none of the markers below (`w=`, `p=`, `n=`)
   * can appear in a generated row.
   */
  const frameText = (frame: string): string => frameLines(frame).join("\n");

  /** The width the pane reported having been rendered at, read back off its own first line. */
  function reportedWidth(frame: string): number {
    const stated = /w=(\d+)/.exec(frameText(frame));
    if (!stated?.[1]) throw new Error(`the pane never stated a width; frame: ${frameText(frame)}`);
    return Number(stated[1]);
  }

  /** The document's first filler line, which is the sixth thing the pane shows. */
  const FIRST_FILLER = "n=001";

  /**
   * The filler line that reaches the pane's top after one PageDown.
   *
   * `listRows` is 18 and the document opens with six header lines, so a page starts at
   * document line 19 — the thirteenth filler line.
   */
  const AFTER_A_PAGE = "n=013";

  /** Opens a picker with a preview pane and waits for the pane's first line to arrive. */
  function withPane(
    options: {
      env?: string;
      cols?: number;
      quit?: string;
      act?: (pty: PtySession) => Promise<void>;
    } = {},
  ): Promise<Session> {
    return driven(scenario(`PROBE_PREVIEW=1 ${options.env ?? ""}`), {
      cols: options.cols,
      quit: options.quit,
      act: async (pty) => {
        // `wt-0` rather than the second column, which the narrow cases truncate away.
        await opened(pty, "wt-0");
        await pty.waitFor("w=");
        await options.act?.(pty);
      },
    });
  }

  test("the split is roughly 60/40, at whatever width the terminal is", async () => {
    // Asserted as a ratio at four widths rather than as one column count, so the claim is
    // about the split being proportional and not about 80 columns happening to divide well.
    // 40 and 30 are the ones that earn their place: a row's cells are sized from the whole
    // row set, so below roughly 60 columns the list is wider than its share and only the
    // list Box's `overflowX` keeps it from pushing the seam right and shrinking the pane
    // below the width the caller was told it had.
    for (const cols of [30, 40, 80, 120]) {
      const { frame } = await withPane({ cols });
      const seam = frameLines(frame)[1]?.indexOf(SEAM) ?? -1;

      expect(reportedWidth(frame) / cols).toBeCloseTo(SHARE, 1);
      expect(seam / cols).toBeCloseTo(1 - SHARE, 1);
    }
  });

  test("a resize re-renders the pane at the new width", async () => {
    // The width-aware criterion. `previewPullRequest` keys its cache on the width it is
    // handed, so a pane that kept asking for the old one would replay text wrapped for a
    // terminal that no longer exists.
    const { frame } = await withPane({
      act: async (pty) => {
        pty.resize(120, ROWS);
        await pty.waitUntil((capture) => /w=4\d/.test(frameText(capture)));
      },
    });

    expect(reportedWidth(frame) / 120).toBeCloseTo(SHARE, 1);
  });

  test("a resize that shortens the document brings the scrolled pane back into it", async () => {
    // A widened pane wraps into fewer lines, so an offset that was inside the old document
    // can be past the end of the new one — which renders as a pane gone blank with no cue,
    // on the same criterion the case above covers from the other side. The probe's document
    // is a fixed length, so the shortening here comes from the *rows* growing instead: a
    // taller viewport is a bigger `listRows` and therefore a smaller last offset.
    const { frame } = await withPane({
      act: async (pty) => {
        pty.write(KEY.pageDown.repeat(5));
        await pty.waitUntil((capture) => frameText(capture).includes("n=060"));
        pty.resize(80, 40);
        await pty.waitUntil((capture) => frameLines(capture).length === 32);
      },
    });

    // The last line of the document is still on screen; the pane did not scroll off its end.
    expect(frameText(frame)).toContain("n=060");
  });

  test("the pane follows the selection", async () => {
    const { frame } = await withPane({
      act: async (pty) => {
        pty.write(KEY.down);
        await pty.waitUntil((capture) => frameText(capture).includes("p=/worktrees/wt-1"));
      },
    });

    expect(frameText(frame)).toContain("p=/worktrees/wt-1");
    expect(frameText(frame)).not.toContain("p=/worktrees/wt-0");
  });

  test("a slow preview for a row the user has left never lands on the row they are on", async () => {
    // The stale-read guard. `wt-0`'s answer is held back half a second, so pressing Down
    // leaves a render in flight for a row that is no longer selected; the settled frame is
    // read well after it resolves.
    const { frame } = await withPane({
      env: "PROBE_PREVIEW=slow",
      act: async (pty) => {
        pty.write(KEY.down);
        await pty.waitUntil((capture) => frameText(capture).includes("p=/worktrees/wt-1"));
        await Bun.sleep(700);
      },
    });

    expect(frameText(frame)).toContain("p=/worktrees/wt-1");
    expect(frameText(frame)).not.toContain("p=/worktrees/wt-0");
  });

  test("the pane scrolls on its own, leaving the list where it was", async () => {
    // "Independently scrollable": the page keys move the document, the arrows move the
    // cursor, and neither reaches into the other.
    const { frame } = await withPane({
      act: async (pty) => {
        pty.write(KEY.pageDown);
        await pty.waitUntil((capture) => frameText(capture).includes(AFTER_A_PAGE));
      },
    });

    expect(frameText(frame)).toContain(AFTER_A_PAGE);
    expect(frameText(frame)).not.toContain("w=");
    // The list did not move with it.
    expect(frameLines(frame).some((line) => line.startsWith("▌ wt-0"))).toBe(true);
  });

  test("a burst of page keys in one chunk is a burst of pages, not one", async () => {
    // Why the offset is reducer state rather than a fourth `useState`: Ink calls the
    // `useInput` handler once per event in a chunk with no re-render between, so a value-form
    // setter would collapse three pages into one. Written as a single `write` for exactly
    // that reason — spacing them out is what hides it.
    const { frame } = await withPane({
      act: async (pty) => {
        pty.write(KEY.pageDown.repeat(3));
        await pty.waitUntil((capture) => frameText(capture).includes("n=049"));
      },
    });

    // Three pages of 18 from a six-line header: document line 55, the forty-ninth filler.
    expect(frameText(frame)).toContain("n=049");
  });

  test("and scrolls back", async () => {
    const { frame } = await withPane({
      act: async (pty) => {
        pty.write(KEY.pageDown);
        await pty.waitUntil((capture) => frameText(capture).includes(AFTER_A_PAGE));
        pty.write(KEY.pageUp);
        await pty.waitUntil((capture) => frameText(capture).includes("w="));
      },
    });

    expect(frameText(frame)).toContain(FIRST_FILLER);
  });

  test("the pane costs the frame no height at all", async () => {
    // EXC-1009's threshold is the one thing a second pane could quietly break: the list is
    // already budgeted to ~80% of the viewport, and a pane taller than it would push the
    // frame to `outputHeight >= viewportRows`, where Ink stops rendering inline.
    const { frame, capture } = await withPane();

    expect(frameHeight(frame)).toBe(FRAME);
    expect(capture).not.toContain(ERASE_SCREEN);
    expect(capture).not.toContain(ALTERNATE_SCREEN);
    expect(hasAbsoluteAddressing(capture)).toBe(false);
  });

  test("colour and hyperlinks reach the terminal; hostile sequences do not", async () => {
    // The third criterion, and the finding EXC-1011's review left for this issue: `sanitize`
    // drops all OSC, so a pane reusing it would take every hyperlink out of the document.
    const { frame, capture } = await withPane();

    // The trailing slash is `URL`'s: the pane re-emits a kept hyperlink from the parse rather
    // than echoing what arrived, which is what keeps a control character out of the URI.
    expect(lastFrame(frame)).toContain(`${ctrl(0x1b)}]8;;https://example.com/${ctrl(0x07)}`);
    expect(lastFrame(frame)).toMatch(new RegExp(`${ctrl(0x1b)}\\[[\\d;]*mcoloured`));
    expect(frameText(frame)).toContain("linked");

    expect(capture).not.toContain(ERASE_SCREEN);
    expect(capture).not.toContain("pwned");
    expect(capture).not.toContain(ctrl(0x202e));
    // The eight-bit CSI, which the probe hides inside a hyperlink's URI rather than in the
    // open — the one path a line of raw escapes cannot reach.
    expect(capture).not.toContain(ctrl(0x9b));
    expect(frameText(frame)).toContain("in-uri");
    expect(frameText(frame)).toContain("hostile-kept");
  });

  test("NO_COLOR reaches the pane's content too", async () => {
    // A caller's pre-rendered colour is still colour, exactly as a row's own is.
    const { capture, frame } = await withPane({ env: "NO_COLOR=1" });

    expect(hasColour(capture)).toBe(false);
    expect(frameText(frame)).toContain("coloured");
  });

  test("a preview that throws says so and leaves the picker working", async () => {
    // An unhandled rejection would take the process down with the terminal in raw mode,
    // which is the one failure a picker must not have.
    const stdout = payloadPath("preview-throws");

    const { frame, exitCode } = await driven(scenario("PROBE_PREVIEW=throw", { stdout }), {
      quit: KEY.enter,
      act: (pty) => opened(pty, "preview exploded"),
    });

    expect(exitCode).toBe(0);
    expect(frameLines(frame).join("\n")).toContain("preview exploded");
    expect(await Bun.file(stdout).text()).toBe(`"/worktrees/wt-0"`);
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

  test("a row given a colour is coloured, even with stdout piped", async () => {
    // The control, and a finding in its own right: chalk derives its level from stdout,
    // which every shipping invocation of this picker redirects. Without `pick()` pinning the
    // level from stderr this run would be colourless and the next case would pass for the
    // wrong reason.
    const path = rowsFile("colour", [
      { payload: "a", columns: [{ text: "alpha", color: "green" }] },
    ]);

    const { capture } = await driven(scenario(`PROBE_ROWS_FILE="${path}"`), {
      act: (pty) => opened(pty, "alpha"),
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

    const { capture } = await driven(scenario(`NO_COLOR=1 PROBE_ROWS_FILE="${path}"`), {
      act: async (pty) => {
        await opened(pty, "beta");
        pty.write("a");
        await pty.waitUntil((capture) => frameLines(capture)[0] === "❯ a");
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
              ctrl(0x202e),
              "the-bug",
            ].join(""),
          },
        ],
      },
    ]);

    const { capture, frame } = await driven(scenario(`PROBE_ROWS_FILE="${path}"`), {
      act: (pty) => opened(pty, "fixthe-bug"),
    });

    expect(capture).not.toContain(ERASE_SCREEN);
    expect(capture).not.toContain("pwned");
    expect(capture).not.toContain(ctrl(0x202e));
    expect(hasAbsoluteAddressing(capture)).toBe(false);
    // The visible characters survive; only the instructions are gone.
    expect(frameLines(frame)[1]).toContain("fixthe-bug");
  });
});
