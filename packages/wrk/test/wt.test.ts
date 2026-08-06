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
 * `gh` never runs in any of these cases, and it is not stubbed either. A fixture container's
 * remote is a path in `/tmp`, so `gh` has nothing to answer about and `listPullRequests`
 * reports its "could not answer" `null` — which is the un-annotated case, and exactly the one
 * an acceptance criterion asks about. The annotated case is reached from the other side, by
 * seeding the `pr-graph` cache entry the picker reads through, so no network and no `gh` are
 * involved in either direction.
 *
 * @packageDocumentation
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  ERASE_SCREEN,
  frameLines,
  KEY,
  maxCursorRise,
  type PtySession,
  runInPty,
} from "../../picker/test/fixtures/pty";
import { cachePath } from "../src/cache";
import { DEFAULTS } from "../src/config";
import type { PullRequest } from "../src/gh";
import type { Worktree } from "../src/git";
import { candidates, worktreeRows } from "../src/wt";
import {
  addRunWorktree,
  cleanupFixtures,
  fixtureGit,
  makeContainer,
  runCli,
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
 * A `PATH` holding `git` and nothing else, so a child cannot spawn `gh` at all.
 *
 * Every CLI child below runs with it, and that is a property of the suite rather than of one
 * case. `gh.ts` makes the spawn itself the presence gate, so an unreachable `gh` is answered
 * instantly and locally — where leaving the real `gh` reachable puts an authenticating,
 * possibly networked binary on the critical path of every one of these cases, with latency
 * nothing here can bound. It is also the more faithful fixture: "absent" is one of the four
 * conditions the un-annotated acceptance criterion names, and it is the only one of the four
 * that can be produced without a network.
 *
 * `git` is symlinked rather than the directory being prepended to the real `PATH`, because
 * prepending would leave `gh` findable further along it.
 */
const GHLESS: string = (() => {
  const dir = tempDir();
  const git = Bun.which("git");
  if (git === null) throw new Error("git is not on PATH, so no fixture can shed gh from it");
  symlinkSync(git, join(dir, "git"));

  return dir;
})();

/**
 * Environment for one `wrk wt` child: no `gh`, and a cache of its own.
 *
 * The private `XDG_CACHE_HOME` is not tidiness. Without it these runs read and write the
 * developer's real `~/.cache/wrk`, so a case would depend on what a previous *real* `wrk wt`
 * had left there — and would leave entries of its own behind.
 */
function childEnv(cacheHome: string = tempDir()): Record<string, string> {
  return { PATH: GHLESS, XDG_CACHE_HOME: cacheHome };
}

/** Height of the pty every driven case runs in, matching `picker.test.ts`'s. */
const ROWS = 24;

/** The CLI entry point, as `fixtures/repo.ts` resolves it. */
const CLI = join(import.meta.dir, "../src/cli.ts");

/** What the driving script echoes once the CLI has exited, whatever its status. */
const ENDED = "EXIT:";

/** How long one {@link quit} attempt waits for the run to end before typing again. */
const REACT_MS = 200;

/** How many times {@link quit} will re-type before calling the picker unresponsive. */
const ATTEMPTS = 12;

/**
 * Runs `wrk wt` inside a pty, from `cwd`, with stdout captured to a file.
 *
 * Stdout is redirected away from the terminal for the reason `picker.test.ts` gives: the
 * capture would otherwise hold the answer as well as the frames, and `frameLines` would count
 * it as a rendered row. It is also the shape the command actually ships in.
 *
 * The restricted `PATH` is applied inside the script rather than through `runInPty`'s `env`,
 * so it reaches the CLI child without also deciding where `bash` itself is found.
 */
async function driveWt(
  cwd: string,
  args: string[],
  drive: (session: PtySession) => Promise<void>,
  cacheHome?: string,
): Promise<{ capture: string; exitCode: number; stdout: string }> {
  const out = join(tempDir(), "stdout");
  const argv = args.map((argument) => `"${argument}"`).join(" ");
  const env = childEnv(cacheHome);
  const exports = `PATH="${env.PATH}" XDG_CACHE_HOME="${env.XDG_CACHE_HOME}"`;
  const script = `cd "${cwd}" && ${exports} "${process.execPath}" "${CLI}" wt ${argv} >"${out}"; echo "EXIT:$?"`;
  const run = await runInPty(script, { rows: ROWS, drive });

  return { ...run, stdout: await Bun.file(out).text() };
}

/**
 * Types `key` until the run reacts to it, rather than once and hopefully.
 *
 * A frame on screen does **not** mean the terminal is ready to be typed at. Ink enables raw
 * mode from an effect, and React runs effects after the frame they belong to has been
 * written — so between the list appearing and the line discipline going raw there is a window
 * in which a keystroke is not delivered to the application at all. An `ESC` sent inside it is
 * echoed back as `^[` and buffered, waiting for a newline that a picker's user never sends,
 * and the run hangs with its list still up. That was observed here, in about one driven run
 * in ten, and it is a property of driving a terminal faster than a person can — which is why
 * this belongs in the harness rather than in the picker.
 *
 * Re-typing closes it. The condition is the run *ending*, which both keys this is used with
 * cause and which the driving script says out loud, so nothing here has to know whether the
 * key chose a row or dismissed the list. A key that arrives after the run has already ended
 * lands on `bash`, which is running a `-c` script and never reads its stdin.
 *
 * @throws If the run never ended, which is the genuine hang this is not allowed to hide.
 */
async function quit(session: PtySession, key: string): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    session.write(key);
    try {
      await session.waitUntil((text) => text.includes(ENDED), REACT_MS);

      return;
    } catch {
      // Not yet raw, or not yet finished. Either way the answer is to type again.
    }
  }

  throw new Error(`the picker never ended after ${ATTEMPTS} keystrokes`);
}

/**
 * The picker's frame, read while it is still on screen, then dismissed.
 *
 * Snapshotting from inside the driver is the whole point. `frameLines` answers the **last**
 * frame in a capture, and the picker erases its own frame on the way out — so a capture read
 * after the run has ended reports the shell's next line, not the list.
 *
 * @param needle - Text whose appearance means the picker has drawn.
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
    cacheHome,
  );

  return { lines, capture };
}

/** `runCli`, with the same gh-less, private-cache environment the driven cases use. */
function wtCli(args: string[], cwd: string): ReturnType<typeof runCli> {
  return runCli(args, cwd, childEnv());
}

/** The exit status the driving script echoes, since the shell's own status is bash's. */
function status(capture: string): number {
  return Number(/EXIT:(\d+)/.exec(capture)?.[1] ?? Number.NaN);
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
    expect(result.stderr).toContain("only other worktree");
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

    const { lines } = await frameWhileOpen(checkout, "#12", cacheHome);

    const rendered = lines.join("\n");
    expect(rendered).toContain(`${DEFAULTS.glyphs.bottom} #11 1/2 the EXC-1/thing-1 change`);
    expect(rendered).toContain(`${DEFAULTS.glyphs.top} #12 2/2 the EXC-2/thing-2 change`);
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
