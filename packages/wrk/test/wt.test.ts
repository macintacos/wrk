/**
 * The worktree picker, from both ends: the two pure decisions, and the real command in a
 * real terminal.
 *
 * The pure half — which worktrees are offered, and what each row says — is a function of its
 * arguments and is asserted directly. The other half is only true of a process: the picker
 * reads `isTTY` off stdin and stderr, the `cd` protocol is a claim about stdout and an exit
 * status, and `--help` reaching the wrong stream is invisible to anything that does not look
 * at the two channels separately. Those cases run the CLI as a child attached to a pty, on
 * [`../../picker/test/fixtures/pty.ts`](../../picker/test/fixtures/pty.ts) and
 * [`./fixtures/repo.ts`](./fixtures/repo.ts) — both existing harnesses, neither rebuilt here.
 *
 * **No case here touches the network, and most never run `gh` at all.** A fixture container's
 * remote is a path in `/tmp`, and the `PATH` these children run with holds `git` alone, so
 * `listPullRequests` reports its "could not answer" `null` — the un-annotated case, and
 * exactly the one an acceptance criterion asks about. The annotated case is reached from the
 * other side, by seeding the `pr-graph` cache entry the picker reads through.
 *
 * The annotation-timing cases are the one exception, and they run `gh` on purpose: proving the
 * rows are drawn *before* `gh` answers takes a `gh` that has demonstrably not answered yet. It
 * is a shell script on that same `PATH`, blocked on a gate the driver opens and answering from
 * a file when it does — see {@link gatedGh}.
 *
 * @packageDocumentation
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  ERASE_SCREEN,
  frameLines,
  KEY,
  maxCursorRise,
  type PtySession,
  SHOW_CURSOR,
  typeUntil,
} from "../../picker/test/fixtures/pty";
import { cachePath } from "../src/cache";
import { DEFAULTS } from "../src/config";
import type { PullRequest } from "../src/gh";
import type { Worktree } from "../src/git";
import { candidates, worktreeRows } from "../src/wt";
import {
  addRunWorktree,
  childEnv,
  cleanupFixtures,
  driveCli,
  ENDED,
  fixtureGit,
  makeContainer,
  quit,
  runCli,
  shedGh,
  status,
  tempDir,
} from "./fixtures/repo";

afterAll(cleanupFixtures);

/** A worktree record as `listWorktrees` reports one: branch refs fully qualified. */
function worktree(path: string, branch: string | null, prunable: string | null = null): Worktree {
  return {
    path,
    head: "0f1e2d3c4b5a69788796a5b4c3d2e1f001122334",
    branch: branch === null ? null : `refs/heads/${branch}`,
    prunable,
  };
}

/** A pull-request row as `gh` reports one. */
function pull(number: number, head: string, extra: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    title: `the ${head} change`,
    headRefName: head,
    baseRefName: "trunk",
    state: "OPEN",
    updatedAt: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

/** The rows keyed as `pr.ts` returns them. */
function graph(...rows: PullRequest[]): Map<string, PullRequest> {
  return new Map(rows.map((row) => [row.headRefName, row]));
}

/**
 * The first row's column texts, which is what a reader sees left to right.
 *
 * Takes the whole array and indexes it here rather than at each call site, so a row set that
 * came back empty reads as `[]` in the diff instead of needing a non-null assertion per case.
 */
function texts(rows: readonly { columns: readonly { text: string }[] }[]): string[] {
  return rows[0]?.columns.map((column) => column.text) ?? [];
}

describe("candidates", () => {
  test("drops the worktree the caller is standing in", () => {
    const here = worktree("/c/trunk", "trunk");
    const other = worktree("/c/EXC-1+thing", "EXC-1/thing");

    expect(candidates([here, other], "/c/trunk")).toEqual([other]);
  });

  test("keeps every worktree when the caller is in none of them", () => {
    // Standing in the container rather than a checkout: nothing is filtered, because nothing
    // is where the caller already is.
    const all = [worktree("/c/trunk", "trunk"), worktree("/c/EXC-1+thing", "EXC-1/thing")];

    expect(candidates(all, null)).toEqual(all);
  });

  test("drops a prunable record, whose directory no longer exists", () => {
    // A destination that cannot be entered is not a destination. `checkoutFor` excludes these
    // for the same reason.
    const live = worktree("/c/trunk", "trunk");
    const gone = worktree("/c/EXC-1+thing", "EXC-1/thing", "gitdir file points to non-existent");

    expect(candidates([live, gone], null)).toEqual([live]);
  });
});

describe("worktreeRows — the plain picker", () => {
  test("a branch with no pull request renders as one column, and nothing else", () => {
    const rows = worktreeRows([worktree("/c/EXC-1+thing", "EXC-1/thing")], new Map(), DEFAULTS);

    expect(texts(rows)).toEqual(["EXC-1/thing"]);
  });

  test("the payload is the worktree's path, not its text and not an object", () => {
    // `PickerRow.payload` has to compare `===` across a row-set replacement and be unique
    // across the rows. A path is both; an object rebuilt from a fresh `git worktree list`
    // would be neither.
    const rows = worktreeRows([worktree("/c/EXC-1+thing", "EXC-1/thing")], new Map(), DEFAULTS);

    expect(rows[0]?.payload).toBe("/c/EXC-1+thing");
  });

  test("a detached head is rendered rather than skipped", () => {
    const rows = worktreeRows([worktree("/c/spike", null)], new Map(), DEFAULTS);

    expect(texts(rows)).toEqual(["(detached 0f1e2d3)"]);
  });

  test("an unborn branch renders its branch name, having no commit to show", () => {
    const unborn: Worktree = { ...worktree("/c/fresh", "trunk"), head: null };

    expect(texts(worktreeRows([unborn], new Map(), DEFAULTS))).toEqual(["trunk"]);
  });
});

describe("worktreeRows — the stack annotation", () => {
  /** A three-layer stack: `bottom` → `middle` → `top`, each on the one below. */
  const stack = graph(
    pull(1, "bottom"),
    pull(2, "middle", { baseRefName: "bottom" }),
    pull(3, "top", { baseRefName: "middle" }),
  );

  const rowFor = (branch: string, prs = stack): string[] =>
    texts(worktreeRows([worktree(`/c/${branch}`, branch)], prs, DEFAULTS));

  test("the bottom unmerged layer takes the bottom marker and position 1 of 3", () => {
    expect(rowFor("bottom")).toEqual([
      "bottom",
      DEFAULTS.glyphs.bottom,
      "#1",
      "1/3",
      "the bottom change",
    ]);
  });

  test("a middle layer takes its position but no marker, being neither end", () => {
    expect(rowFor("middle")).toEqual(["middle", "", "#2", "2/3", "the middle change"]);
  });

  test("the top layer takes the top marker", () => {
    expect(rowFor("top")).toEqual(["top", DEFAULTS.glyphs.top, "#3", "3/3", "the top change"]);
  });

  test("a one-layer stack gets neither a position nor a marker", () => {
    // The issue's constraint: there is no "where am I" to answer, and marking it both top and
    // bottom would say nothing.
    expect(rowFor("solo", graph(pull(9, "solo")))).toEqual([
      "solo",
      "",
      "#9",
      "",
      "the solo change",
    ]);
  });

  test("a merged branch takes the merged marker and no position", () => {
    // `stackGraph` builds its edges from open rows only, so a merged branch is in no stack —
    // which is why the marker comes off the row's own state rather than off a position.
    const merged = graph(pull(7, "landed", { state: "MERGED" }));

    expect(rowFor("landed", merged)).toEqual([
      "landed",
      DEFAULTS.glyphs.merged,
      "#7",
      "",
      "the landed change",
    ]);
  });

  test("only the marker is coloured, and it takes the colour its position names", () => {
    const [row] = worktreeRows([worktree("/c/top", "top")], stack, DEFAULTS);

    expect(row?.columns.map((column) => column.color)).toEqual([
      undefined,
      DEFAULTS.colours.top,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("a detached head is never annotated, having no branch to join on", () => {
    expect(texts(worktreeRows([worktree("/c/spike", null)], stack, DEFAULTS))).toEqual([
      "(detached 0f1e2d3)",
    ]);
  });

  test("an annotated row and an un-annotated one coexist, the short one simply ending early", () => {
    const rows = worktreeRows(
      [worktree("/c/top", "top"), worktree("/c/nothing", "nothing")],
      stack,
      DEFAULTS,
    );

    expect(rows.map((row) => row.columns.length)).toEqual([5, 1]);
  });
});

/**
 * A container with `count` run worktrees beside its default-branch checkout.
 *
 * @returns The container, the checkout to run the CLI from, and the run worktrees' paths.
 */
function repoWith(count: number): { container: string; checkout: string; worktrees: string[] } {
  const { container, checkout } = makeContainer("trunk");
  const worktrees = Array.from({ length: count }, (_unused, index) =>
    addRunWorktree(container, `EXC-${index + 1}/thing-${index + 1}`),
  );

  return { container, checkout, worktrees };
}

/**
 * A `PATH` whose `gh` answers `rows` — but not until the returned `open` is called.
 *
 * The cases below are about *ordering*: a frame on screen while `gh` has not answered is the
 * whole claim, and a `gh` that merely sleeps would make that claim a bet on how long the
 * picker takes to draw. A gate makes it a fact — nothing is racing, so nothing is flaky, which
 * is `fixtures/pty.ts`'s condition-over-interval rule applied to the child instead of the
 * keyboard.
 *
 * The script is deliberately its own binary rather than a stub inside the CLI: the seam this
 * issue moves is `gh` on the critical path, and a fixture that replaced the call rather than
 * the process would not exercise it. No network is touched either way — the rows are handed
 * over from disk, per the suite's standing rule that `gh` is never really run.
 *
 * The wait is **bounded**, and that is not defensiveness. `runInPty` propagates a driver's
 * failure without awaiting or killing the child, so a case that throws before opening the gate
 * leaves this script polling — and an unbounded loop would poll until the whole test process
 * exits. Giving up answers as a `gh` that could not answer, which is an outcome `gh.ts` already
 * has a meaning for, rather than a hang.
 *
 * `sleep` and `cat` are symlinked in beside `git` rather than spelled as absolute paths: the
 * script's own `PATH` is this directory, and `/bin` is where they live on this machine rather
 * than everywhere.
 *
 * @param rows - What the `--state open` query answers with. The merged query answers `[]`,
 *   which is `gh` saying "none" rather than "could not answer" — the distinction `gh.ts`
 *   documents, and the one that lets the entry be written at all.
 * @returns The directory to run with as `PATH`, and the call that lets `gh` answer.
 */
function gatedGh(rows: readonly PullRequest[]): { path: string; open: () => void } {
  const dir = shedGh("sleep", "cat");
  const gate = join(dir, "gate");
  const answer = join(dir, "open.json");
  writeFileSync(answer, JSON.stringify(rows));
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      // Ten seconds, well past the picker's own 3 s waits: reaching the bound means the case
      // failed. Counted with shell arithmetic rather than `seq`, which is not on this `PATH`.
      "n=0",
      `while [ ! -f "${gate}" ] && [ "$n" -lt 500 ]; do sleep 0.02; n=$((n + 1)); done`,
      `[ -f "${gate}" ] || exit 1`,
      'case "$*" in',
      `  *"--state open"*) cat "${answer}" ;;`,
      "  *) echo '[]' ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return { path: dir, open: () => writeFileSync(gate, "") };
}

/** Height of the pty every driven case runs in, matching `picker.test.ts`'s. */
const ROWS = 24;

/** `driveCli`, with `wt` already in the argv and this suite's viewport. */
function driveWt(
  cwd: string,
  args: string[],
  drive: (session: PtySession) => Promise<void>,
  options: { cacheHome?: string; path?: string } = {},
): ReturnType<typeof driveCli> {
  return driveCli(cwd, ["wt", ...args], drive, { ...options, rows: ROWS });
}

/**
 * Whether the gutter marks the row beginning with `label`.
 *
 * Over `frameLines` rather than the raw capture, because the gutter and the row it marks are
 * separated by the escape sequences that colour them — the same reading `picker.test.ts` makes
 * of the same glyph.
 */
function selects(label: string): (capture: string) => boolean {
  return (capture) => frameLines(capture).some((line) => line.startsWith(`▌ ${label}`));
}

/** Whether the last frame carries `text`, which a cumulative capture cannot be asked. */
function drawn(text: string): (capture: string) => boolean {
  return (capture) => frameLines(capture).join("\n").includes(text);
}

/**
 * The picker's frame, read while it is still on screen, then dismissed.
 *
 * Snapshotting from inside the driver is the whole point. `frameLines` answers the **last**
 * frame in a capture, and the picker erases its own frame on the way out — so a capture read
 * after the run has ended reports the shell's next line, not the list.
 *
 * @param needle - Text whose appearance means the frame is **complete**, which is why every
 *   caller passes something from the *last* row rather than the first: a needle drawn earlier
 *   would let the snapshot catch a frame still being written, and it is the assertions about
 *   what a frame does *not* contain that a short frame passes for free.
 * @returns The frame's non-empty lines, and the whole capture for the escape-sequence claims.
 */
async function frameWhileOpen(
  cwd: string,
  needle: string,
  cacheHome?: string,
): Promise<{ lines: string[]; capture: string }> {
  let lines: string[] = [];
  const { capture } = await driveWt(
    cwd,
    ["--print-path"],
    async (session) => {
      await session.waitFor(needle);
      lines = frameLines(session.capture());
      await quit(session, KEY.escape);
    },
    { cacheHome },
  );

  return { lines, capture };
}

/** `runCli`, with the same gh-less, private-cache environment the driven cases use. */
function wtCli(args: string[], cwd: string): ReturnType<typeof runCli> {
  return runCli(args, cwd, childEnv());
}

describe("wrk wt — the cd protocol", () => {
  test("a dismissed pick exits 130 with stdout empty", async () => {
    // The conformance-level cancellation rule: EXC-1015 could map `Cancelled` to 130 but had no
    // picker command to prove the mapping end to end. This is that proof.
    const { checkout } = repoWith(2);
    const { capture, stdout } = await driveWt(checkout, ["--print-path"], async (session) => {
      await session.waitFor("EXC-1/thing-1");
      await quit(session, KEY.escape);
    });

    expect(status(capture)).toBe(130);
    expect(stdout).toBe("");
  });

  test("a chosen row exits 0 with the path alone on stdout", async () => {
    const { checkout, worktrees } = repoWith(2);
    const { capture, stdout } = await driveWt(checkout, ["--print-path"], async (session) => {
      await session.waitFor("EXC-1/thing-1");
      await quit(session, KEY.enter);
    });

    expect(status(capture)).toBe(0);
    // Exactly the path and a newline — the same equality that rules an envelope, a stray
    // progress line or a trailing space out of `agent create --hook`'s stdout.
    expect(stdout).toBe(`${worktrees[0]}\n`);
  });

  test("the frame stays inline, never taking the screen", async () => {
    const { checkout } = repoWith(3);
    const { capture } = await frameWhileOpen(checkout, "EXC-3/thing-3");

    expect(capture).not.toContain(ERASE_SCREEN);
    expect(maxCursorRise(capture)).toBeLessThan(ROWS);
  });
});

describe("wrk wt — what it offers", () => {
  test("the checkout it is run from is not among the rows", async () => {
    const { checkout } = repoWith(2);
    const { lines } = await frameWhileOpen(checkout, "EXC-2/thing-2");

    expect(lines.join("\n")).not.toContain("trunk");
  });

  test("a single candidate skips the picker, goes there, and says why", async () => {
    const { checkout, worktrees } = repoWith(1);
    const result = await wtCli(["wt", "--print-path"], checkout);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${worktrees[0]}\n`);
    expect(result.stderr).toContain("wrk: ");
    expect(result.stderr).toContain("only worktree on offer");
  });

  test("no other worktree is a refusal, not an empty pick", async () => {
    const { checkout } = repoWith(0);
    const result = await wtCli(["wt", "--print-path"], checkout);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("wrk: ");
    expect(result.stderr).not.toMatch(/^\s+at /m);
  });

  test("a detached worktree is offered, rendered by its commit", async () => {
    const { container, checkout } = makeContainer("trunk");
    const spike = addRunWorktree(container, "EXC-9/spike");
    fixtureGit(["checkout", "-q", "--detach"], spike);
    const head = fixtureGit(["rev-parse", "HEAD"], spike);
    const result = await wtCli(["wt"], checkout);

    // One candidate, so the picker is skipped and the answer is printed — which is what makes
    // a detached worktree's *offerability* assertable without a terminal at all. The envelope
    // shape rather than `--print-path`, because `branch` is the field a detached HEAD decides.
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ worktree_path: spike, branch: null });
    expect(result.stderr).toContain(`detached ${head.slice(0, 7)}`);
  });
});

describe("wrk wt — degrading without gh", () => {
  test("rows render un-annotated, and nothing is said about it", async () => {
    const { checkout } = repoWith(2);
    const { lines, capture } = await frameWhileOpen(checkout, "EXC-2/thing-2");

    expect(lines.some((line) => line.includes("EXC-1/thing-1"))).toBe(true);
    // No `#`, no marker, no position: identical to a picker that never looked for one.
    expect(lines.join("\n")).not.toContain("#");
    expect(capture).not.toContain("wrk: ");
  });
});

describe("wrk wt — the stack annotation, end to end", () => {
  test("a seeded pr-graph entry puts marker, number, position and title in the frame", async () => {
    const { container, checkout } = repoWith(2);
    const cacheHome = tempDir();
    const rows = [
      pull(11, "EXC-1/thing-1"),
      pull(12, "EXC-2/thing-2", { baseRefName: "EXC-1/thing-1" }),
    ];
    const entry = cachePath({ name: "pr-graph", container, root: join(cacheHome, "wrk") });
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, JSON.stringify(rows));

    // The last row's title, not its `#12`: the needle has to be the last thing drawn.
    const { lines } = await frameWhileOpen(checkout, "the EXC-2/thing-2 change", cacheHome);

    const rendered = lines.join("\n");
    expect(rendered).toContain(`${DEFAULTS.glyphs.bottom} #11 1/2 the EXC-1/thing-1 change`);
    expect(rendered).toContain(`${DEFAULTS.glyphs.top} #12 2/2 the EXC-2/thing-2 change`);
  });
});

describe("wrk wt — the annotation arrives behind the draw", () => {
  /** A two-layer stack, one pull request per worktree, so both markers and both positions draw. */
  const stacked = [
    pull(11, "EXC-1/thing-1"),
    pull(12, "EXC-2/thing-2", { baseRefName: "EXC-1/thing-1" }),
  ];

  test("the rows are on screen before gh answers, and take the annotation once it does", async () => {
    // A cold cache and a `gh` that has not answered, so this wait is the claim in full: an
    // annotation reached in front of the draw leaves the terminal blank until `gh` speaks, and
    // there would be no frame here to read.
    const { checkout } = repoWith(2);
    const gh = gatedGh(stacked);
    let opening: string[] = [];
    let annotated: string[] = [];

    await driveWt(
      checkout,
      ["--print-path"],
      async (session) => {
        await session.waitFor("EXC-2/thing-2");
        opening = frameLines(session.capture());

        gh.open();
        await session.waitUntil(drawn("#11"));
        annotated = frameLines(session.capture());
        await quit(session, KEY.escape);
      },
      { path: gh.path },
    );

    // Drawn from the worktrees alone: every branch, and not one pull-request column.
    expect(opening.some((line) => line.includes("EXC-1/thing-1"))).toBe(true);
    expect(opening.join("\n")).not.toContain("#");

    // The same frame, replaced in place rather than a second picker appearing — which is what
    // reading the *last* frame is worth, since the capture still holds the un-annotated one.
    const rendered = annotated.join("\n");
    expect(rendered).toContain(`${DEFAULTS.glyphs.bottom} #11 1/2 the EXC-1/thing-1 change`);
    expect(rendered).toContain(`${DEFAULTS.glyphs.top} #12 2/2 the EXC-2/thing-2 change`);
  });

  test("the selection stays on the worktree it was on when the annotation lands", async () => {
    // The criterion `PickerRow.payload` is a path for: the cursor is restored by matching the
    // payload with `===`, so a row set rebuilt around the same worktrees keeps it, even though
    // every row grew four columns underneath it.
    // Two worktrees, so the row moved onto is the **last** one: `typeUntil` may send a second
    // arrow after the first has landed, and only at the end of the list does the reducer clamp
    // that into a no-op instead of carrying the cursor past the row being aimed at.
    const { checkout, worktrees } = repoWith(2);
    const gh = gatedGh(stacked);
    let beforeSwap: string[] = [];
    let afterSwap = "";

    const { capture, stdout } = await driveWt(
      checkout,
      ["--print-path"],
      async (session) => {
        await session.waitFor("EXC-2/thing-2");
        await typeUntil(session, KEY.down, selects("EXC-2/thing-2"), "moved");
        beforeSwap = frameLines(session.capture());

        gh.open();
        await session.waitUntil(drawn("#12"));
        afterSwap = session.capture();
        await quit(session, KEY.enter);
      },
      { path: gh.path },
    );

    // The move really did happen while the rows were still bare, so the swap this asserts about
    // is a swap rather than a redraw of something already annotated.
    expect(beforeSwap.join("\n")).not.toContain("#");
    expect(selects("EXC-2/thing-2")(afterSwap)).toBe(true);
    expect(status(capture)).toBe(0);
    expect(stdout).toBe(`${worktrees[1]}\n`);
  });

  test("a refresh still running when the picker closes is not an error", async () => {
    // Dismissed with `gh` still blocked, so the replacement lands on a picker that has already
    // unmounted. React makes that dispatch a no-op; nothing here may report it as a fault.
    const { checkout } = repoWith(2);
    const gh = gatedGh(stacked);

    const { capture, stdout } = await driveWt(
      checkout,
      ["--print-path"],
      async (session) => {
        await session.waitFor("EXC-2/thing-2");
        // The run cannot end while `gh` is blocked, so the condition is the picker letting the
        // cursor back — Ink's unmount — rather than the script's own exit line.
        await typeUntil(session, KEY.escape, (text) => text.includes(SHOW_CURSOR), "closed");
        gh.open();
        await session.waitFor(ENDED);
      },
      { path: gh.path },
    );

    expect(status(capture)).toBe(130);
    expect(stdout).toBe("");
    expect(capture).not.toContain("wrk: ");
    expect(capture).not.toMatch(/^\s+at /m);
  });
});

describe("wrk wt — the two stdout shapes and --help", () => {
  test("without --print-path the answer is the envelope", async () => {
    const { checkout, worktrees } = repoWith(1);
    const result = await wtCli(["wt"], checkout);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      worktree_path: worktrees[0],
      branch: "EXC-1/thing-1",
    });
    // `toEqual` is indifferent to key order, and order is one of the envelope's two
    // guarantees — the same assertion `conformance.test.ts` makes for `agent create`.
    expect(Object.keys(JSON.parse(result.stdout))).toEqual(["worktree_path", "branch"]);
  });

  test("--help writes nothing to stdout, because stdout is a path the shim cds into", async () => {
    // Commander renders help to stdout by design, which is right for every other command and
    // wrong for this one: the documented shim feeds this stdout straight to `cd`.
    const { checkout } = repoWith(1);
    const result = await wtCli(["wt", "--help"], checkout);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--print-path");
  });

  test("the rest of the tree keeps its help on stdout", async () => {
    // The carve-out is one command wide. `output.ts` documents help-on-stdout as correct
    // because a caller asking for help is a human, and that stays true everywhere else.
    const { checkout } = repoWith(0);
    const result = await wtCli(["agent", "create", "--help"], checkout);

    expect(result.stdout).toContain("--branch");
    expect(result.stderr).toBe("");
  });

  test("a non-terminal is a refusal, not a hang and not a dismissal", async () => {
    // `runCli` gives the child pipes, so the picker's door check fires. Exit 1 rather than
    // 130: nobody dismissed anything, there was nowhere to draw.
    const { checkout } = repoWith(2);
    const result = await wtCli(["wt", "--print-path"], checkout);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("wrk: ");
    expect(result.stderr).toContain("not a terminal");
  });
});
