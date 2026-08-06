/**
 * The pull-request picker, from both ends: the pure decisions, and the real command in a real
 * terminal.
 *
 * The pure half — which pull requests are offered, in what order, what each row says, and
 * which worktree already holds one — is a function of its arguments and is asserted directly.
 * The other half is only true of a process: the picker reads `isTTY` off stdin and stderr, the
 * `cd` protocol is a claim about stdout and an exit status at once, and "the worktree was
 * force-removed" is a claim about a directory. Those cases run the CLI as a child attached to a
 * pty, on [`./fixtures/repo.ts`](./fixtures/repo.ts)'s harness and
 * [`../../picker/test/fixtures/pty.ts`](../../picker/test/fixtures/pty.ts) — both existing, and
 * neither rebuilt here.
 *
 * **No case reaches the GitHub API, and none runs the real `gh`.** The rows arrive by seeding
 * the `pr-graph` cache entry the command reads through, which is the same door `wt.test.ts`
 * uses. `gh pr checkout` is a fake executable on a `PATH` holding it and `git` alone, logging
 * the cwd and argv it was called with — the shape `gh.test.ts` established — because the
 * acceptance criterion "checkout goes through the GitHub CLI" is invisible in the result and
 * observable only in what was run.
 *
 * @packageDocumentation
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  ERASE_SCREEN,
  frameLines,
  KEY,
  maxCursorRise,
  type PtySession,
  typeUntil,
} from "../../picker/test/fixtures/pty";
import { cachePath } from "../src/cache";
import type { PullRequest } from "../src/gh";
import type { Worktree } from "../src/git";
import { holderFor, openPullRequests, pullRequestRows } from "../src/prpick";
import {
  addRunWorktree,
  childEnv,
  cleanupFixtures,
  driveCli,
  fixtureGit,
  ghlessWith,
  makeContainer,
  makeUnconverted,
  quit,
  runCli,
  status,
  tempDir,
} from "./fixtures/repo";

afterAll(cleanupFixtures);

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

/** The rows keyed by head ref, as `pullRequests` returns them. */
function graph(...rows: PullRequest[]): Map<string, PullRequest> {
  return new Map(rows.map((row) => [row.headRefName, row]));
}

/** A worktree record as `listWorktrees` reports one: branch refs fully qualified. */
function worktree(path: string, branch: string | null, prunable: string | null = null): Worktree {
  return {
    path,
    head: "0f1e2d3c4b5a69788796a5b4c3d2e1f001122334",
    branch: branch === null ? null : `refs/heads/${branch}`,
    prunable,
  };
}

describe("openPullRequests", () => {
  test("drops merged pull requests, which are not somewhere to go", () => {
    const prs = graph(pull(1, "live"), pull(2, "landed", { state: "MERGED" }));

    expect(openPullRequests(prs).map((row) => row.number)).toEqual([1]);
  });

  test("orders most-recently-updated first", () => {
    // The map's own order is whatever `dedupe` folded on the way out of the cache, which is
    // not the order the acceptance criterion asks for — so the sort is explicit.
    const prs = graph(
      pull(1, "old", { updatedAt: "2026-01-01T00:00:00Z" }),
      pull(2, "newest", { updatedAt: "2026-03-01T00:00:00Z" }),
      pull(3, "middle", { updatedAt: "2026-02-01T00:00:00Z" }),
    );

    expect(openPullRequests(prs).map((row) => row.number)).toEqual([2, 3, 1]);
  });

  test("breaks a timestamp tie with the higher number, so the order is total", () => {
    // Without this the answer depends on which row the map happened to hold first, and two
    // runs of the same command would draw the same list in different orders.
    const prs = graph(pull(4, "a"), pull(9, "b"), pull(6, "c"));

    expect(openPullRequests(prs).map((row) => row.number)).toEqual([9, 6, 4]);
  });
});

describe("pullRequestRows", () => {
  test("renders the number, the title and the head branch, in that order", () => {
    const rows = pullRequestRows([pull(22, "EXC-1/thing")]);

    expect(rows[0]?.columns.map((column) => column.text)).toEqual([
      "#22",
      "the EXC-1/thing change",
      "EXC-1/thing",
    ]);
  });

  test("the payload is the number as a string, not the row's text and not an object", () => {
    // `PickerRow.payload` must be unique across the rows and compare `===` after a row-set
    // replacement. A pull-request number is both; an object rebuilt from a fresh query is
    // neither, and a title is not even unique.
    const rows = pullRequestRows([pull(22, "EXC-1/thing"), pull(23, "EXC-2/thing")]);

    expect(rows.map((row) => row.payload)).toEqual(["22", "23"]);
  });
});

describe("holderFor", () => {
  test("finds the worktree standing on the pull request's head branch", () => {
    const here = worktree("/c/trunk", "trunk");
    const mine = worktree("/c/EXC-1+thing", "EXC-1/thing");

    expect(holderFor([here, mine], "EXC-1/thing")).toBe(mine);
  });

  test("answers nothing when no worktree holds it", () => {
    expect(holderFor([worktree("/c/trunk", "trunk")], "EXC-1/thing")).toBeUndefined();
  });

  test("answers a prunable record rather than skipping it", () => {
    // The opposite call to `wt.ts`'s `candidates`, and deliberately: there a stale record is a
    // destination that cannot be entered, here it is the thing standing between the caller and
    // the branch — git refuses to check it out anywhere else until the record is pruned. The
    // caller has to see it to confirm the prune.
    const gone = worktree("/c/EXC-1+thing", "EXC-1/thing", "gitdir file points to non-existent");

    expect(holderFor([gone], "EXC-1/thing")).toBe(gone);
  });

  test("never matches a detached worktree, which has no branch to join on", () => {
    expect(holderFor([worktree("/c/spike", null)], "EXC-1/thing")).toBeUndefined();
  });
});

/** Height of the pty every driven case runs in, matching `picker.test.ts`'s. */
const ROWS = 24;

/** The cache entry the command reads its rows out of, spelled as `pr.ts` files them. */
const ENTRY = "pr-graph";

/**
 * The confirmation's prompt, copied from `prpick.ts` rather than imported.
 *
 * The acceptance criterion is about what a *user reads*, so the assertion has to fail when the
 * wording changes rather than move with it. An import would make the two agree by construction
 * and pin nothing at all.
 */
const PRUNE_PROMPT = "prune every stale worktree record in this repository?";

/** What the fake `gh` renders for a preview, chosen to carry no `#` of its own. */
const PREVIEW = "PREVIEW-BODY-FOR";

/**
 * A fake `gh` on a `PATH` holding it and `git` alone, plus the log it appends to.
 *
 * One `<cwd>\t<argv>` line per invocation, which is where the "checkout goes through the
 * GitHub CLI" criterion actually lives: the resulting worktree looks the same whether `gh` or
 * `git switch` put the branch there, so only the argv distinguishes them. `gh.test.ts`
 * established this shape and this one is deliberately much smaller — it answers three
 * subcommands rather than asserting on the environment, which that suite already owns.
 *
 * The `read` is not decoration: `proc.ts` closes a child's stdin, so this returns at EOF. Were
 * stdin ever left as an open pipe, every call here would block until bun's timeout killed it,
 * which is how this suite would notice.
 *
 * @param checkoutExit - What `gh pr checkout` exits with. A nonzero value is deliberately not
 *   `1`, so a status that is *inherited* is distinguishable from one that was flattened.
 */
function fakeGh(checkoutExit = 0): { bin: string; log: string } {
  const log = join(tempDir(), "gh.log");
  const script = [
    "#!/bin/sh",
    `printf '%s\\t%s\\n' "$(pwd)" "$*" >> '${log}'`,
    "read -r _ignored",
    `if [ "$2" = view ]; then printf '${PREVIEW} %s\\n' "$3"; exit 0; fi`,
    `if [ "$2" = checkout ]; then`,
    `  printf 'the fake gh declined\\n' >&2`,
    `  exit ${checkoutExit}`,
    "fi",
    "printf '[]'",
    "",
  ].join("\n");

  return { bin: ghlessWith(script), log };
}

/** Every argv the fake `gh` was called with, cwd first. Absent log means it was never run. */
function ghCalls(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

/** Writes `rows` into the `pr-graph` entry the command will read, as `pr.ts` stores them. */
function seed(container: string, cacheHome: string, rows: readonly PullRequest[]): void {
  const entry = cachePath({ name: ENTRY, container, root: join(cacheHome, "wrk") });
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, JSON.stringify(rows));
}

/** What {@link repoWithPrs} built: a container, somewhere to run from, and the fake's log. */
interface Fixture {
  container: string;
  checkout: string;
  bin: string;
  log: string;
  cacheHome: string;
}

/**
 * A bare-repo container whose `pr-graph` entry already holds `rows`, and a fake `gh` beside it.
 *
 * The entry is written directly rather than through a `gh` that answers a listing, which is
 * what keeps the network out of every case: the command reads the cache, finds it fresh
 * against the default fifteen-minute threshold, and never asks `gh` for a list at all.
 */
function repoWithPrs(rows: readonly PullRequest[], checkoutExit = 0): Fixture {
  const { container, checkout } = makeContainer("trunk");
  const cacheHome = tempDir();
  const { bin, log } = fakeGh(checkoutExit);
  seed(container, cacheHome, rows);

  return { container, checkout, bin, log, cacheHome };
}

/** `driveCli`, with `pr` already in the argv and this fixture's shielded environment. */
function drivePr(
  fixture: Fixture,
  args: string[],
  drive: (session: PtySession) => Promise<void>,
): ReturnType<typeof driveCli> {
  return driveCli(
    fixture.checkout,
    ["pr", ...args],
    drive,
    childEnv(fixture.cacheHome, fixture.bin),
    ROWS,
  );
}

/** `runCli`, with the same fixture-private cache, config and `PATH` the driven cases use. */
function prCli(fixture: Fixture, args: string[]): ReturnType<typeof runCli> {
  return runCli(args, fixture.checkout, childEnv(fixture.cacheHome, fixture.bin));
}

/**
 * The picker's frame, read while it is still on screen, then dismissed.
 *
 * Snapshotting from inside the driver is the whole point: `frameLines` answers the **last**
 * frame in a capture and the picker erases its own frame on the way out, so a capture read
 * after the run has ended reports the shell's next line rather than the list.
 *
 * The wait is on the preview's text as well as the list's, because the pane arrives on a frame
 * of its own — `previewPullRequest` is async — and a snapshot taken between the two would
 * report a list with no pane beside it and pass the "no pane" assertions for free.
 */
async function frameWhileOpen(fixture: Fixture, lastRow: string): Promise<string[]> {
  let lines: string[] = [];
  await drivePr(fixture, ["--print-path"], async (session) => {
    await session.waitUntil((text) => text.includes(lastRow) && text.includes(PREVIEW));
    lines = frameLines(session.capture());
    await quit(session, KEY.escape);
  });

  return lines;
}

describe("wrk pr — the cd protocol", () => {
  test("a dismissed pick exits 130 with stdout empty", async () => {
    const fixture = repoWithPrs([pull(1, "feat/one")]);
    const { capture, stdout } = await drivePr(fixture, ["--print-path"], async (session) => {
      await session.waitFor("#1");
      await quit(session, KEY.escape);
    });

    expect(status(capture)).toBe(130);
    expect(stdout).toBe("");
  });

  test("the frame stays inline, never taking the screen", async () => {
    const fixture = repoWithPrs([pull(1, "feat/one"), pull(2, "feat/two")]);
    let capture = "";
    await drivePr(fixture, ["--print-path"], async (session) => {
      await session.waitUntil((text) => text.includes("#1") && text.includes(PREVIEW));
      capture = session.capture();
      await quit(session, KEY.escape);
    });

    expect(capture).not.toContain(ERASE_SCREEN);
    expect(maxCursorRise(capture)).toBeLessThan(ROWS);
  });
});

describe("wrk pr — what it draws", () => {
  test("lists open pull requests most-recently-updated first", async () => {
    const fixture = repoWithPrs([
      pull(1, "feat/old", { updatedAt: "2026-01-01T00:00:00Z" }),
      pull(2, "feat/newest", { updatedAt: "2026-03-01T00:00:00Z" }),
      pull(3, "feat/middle", { updatedAt: "2026-02-01T00:00:00Z" }),
    ]);

    const rendered = (await frameWhileOpen(fixture, "#1")).join("\n");

    expect(rendered.indexOf("#2")).toBeLessThan(rendered.indexOf("#3"));
    expect(rendered.indexOf("#3")).toBeLessThan(rendered.indexOf("#1"));
  });

  test("a merged pull request is not offered, having nowhere to go and nothing to review", async () => {
    const fixture = repoWithPrs([
      pull(1, "feat/live"),
      pull(2, "feat/landed", { state: "MERGED" }),
    ]);

    const rendered = (await frameWhileOpen(fixture, "#1")).join("\n");

    expect(rendered).toContain("#1");
    expect(rendered).not.toContain("#2");
  });

  test("the preview pane renders gh's own answer beside the list", async () => {
    const fixture = repoWithPrs([pull(7, "feat/one")]);

    const lines = await frameWhileOpen(fixture, "#7");

    // Beside, not below: the same rendered line carries the row and the pane's first line, so
    // a pane that had become a second list would fail this while a substring search would not.
    expect(lines.some((line) => line.includes("#7") && line.includes(`${PREVIEW} 7`))).toBe(true);
  });

  test("no open pull request is a refusal, not an empty picker", async () => {
    // Refused before anything is drawn, so a pipe is enough to observe it.
    const fixture = repoWithPrs([pull(2, "feat/landed", { state: "MERGED" })]);
    const result = await prCli(fixture, ["pr", "--print-path"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    // Naming the sentence is what makes this falsifiable: offering the merged row instead
    // would reach `pick`, be refused for the pipe, and produce an identically-shaped exit 1
    // with an empty stdout and one `wrk: ` line.
    expect(result.stderr).toContain("no open pull requests");
    expect(result.stderr).not.toMatch(/^\s+at /m);
  });
});

describe("wrk pr — a branch that already has a worktree", () => {
  test("goes there, and never runs gh pr checkout", async () => {
    const fixture = repoWithPrs([pull(5, "EXC-1/thing")]);
    const live = addRunWorktree(fixture.container, "EXC-1/thing");

    const { capture, stdout } = await drivePr(fixture, ["--print-path"], async (session) => {
      await session.waitFor("#5");
      await quit(session, KEY.enter);
    });

    expect(status(capture)).toBe(0);
    expect(stdout).toBe(`${live}\n`);
    expect(ghCalls(fixture.log).some((line) => line.includes("pr checkout"))).toBe(false);
  });

  test("without --print-path the answer is the envelope", async () => {
    const fixture = repoWithPrs([pull(5, "EXC-1/thing")]);
    const live = addRunWorktree(fixture.container, "EXC-1/thing");

    const { stdout } = await drivePr(fixture, [], async (session) => {
      await session.waitFor("#5");
      await quit(session, KEY.enter);
    });

    expect(JSON.parse(stdout)).toEqual({ worktree_path: live, number: 5 });
    // `toEqual` is indifferent to key order, and order is one of the envelope's two guarantees
    // — the same assertion `conformance.test.ts` makes for `agent create`.
    expect(Object.keys(JSON.parse(stdout))).toEqual(["worktree_path", "number"]);
  });
});

describe("wrk pr — a branch that has none", () => {
  test("creates the worktree detached and checks the pull request out into it", async () => {
    const fixture = repoWithPrs([pull(8, "feat/fresh")]);
    const expected = join(fixture.container, "feat+fresh");

    const { capture, stdout } = await drivePr(fixture, ["--print-path"], async (session) => {
      await session.waitFor("#8");
      await quit(session, KEY.enter);
    });

    expect(status(capture)).toBe(0);
    expect(stdout).toBe(`${expected}\n`);
    expect(existsSync(expected)).toBe(true);
    // The constraint the issue states outright, and the only place it is observable: the argv,
    // and the directory it was run in.
    expect(ghCalls(fixture.log)).toContain(`${expected}\tpr checkout 8`);
    // Detached, not on a branch git's DWIM named after the directory. The fake `gh` touches
    // no refs, so without `{ detach: true }` a `feat+fresh` branch exists here and every
    // other assertion in this case still passes.
    expect(fixtureGit(["branch", "--list", "feat+fresh"], fixture.container)).toBe("");
  });

  test("a failed checkout force-removes the worktree and inherits gh's status", async () => {
    const fixture = repoWithPrs([pull(8, "feat/fresh")], 4);
    const expected = join(fixture.container, "feat+fresh");

    const { capture, stdout } = await drivePr(fixture, ["--print-path"], async (session) => {
      await session.waitFor("#8");
      await quit(session, KEY.enter);
    });

    expect(status(capture)).toBe(4);
    // Nothing on stdout is what keeps the shim from moving anyone, which is the whole of "the
    // original working directory is restored" at the level a shell can see.
    expect(stdout).toBe("");
    expect(existsSync(expected)).toBe(false);
    expect(capture).toContain("wrk: ");
  });
});

describe("wrk pr — a worktree record whose directory is gone", () => {
  /** A fixture whose chosen pull request's branch is held by a prunable record. */
  function repoWithStaleRecord(): { fixture: Fixture; gone: string } {
    const fixture = repoWithPrs([pull(9, "feat/gone")]);
    const gone = addRunWorktree(fixture.container, "feat/gone");
    rmSync(gone, { recursive: true, force: true });

    return { fixture, gone };
  }

  test("asks before pruning, and says the prune is repo-wide", async () => {
    const { fixture, gone } = repoWithStaleRecord();
    let confirm: string[] = [];

    const { capture, stdout } = await drivePr(fixture, ["--print-path"], async (session) => {
      await session.waitFor("#9");
      await typeUntil(session, KEY.enter, (text) => text.includes(PRUNE_PROMPT));
      confirm = frameLines(session.capture());
      await quit(session, KEY.escape);
    });

    // The disclosure is in the prompt, and the record it is about is named on the line above.
    expect(confirm.some((line) => line.includes(PRUNE_PROMPT))).toBe(true);
    expect(capture).toContain(gone);
    // Declining is a dismissal, not a failure: nothing was pruned and nobody moved.
    expect(status(capture)).toBe(130);
    expect(stdout).toBe("");
  });

  test("declining leaves the record standing", async () => {
    const { fixture, gone } = repoWithStaleRecord();

    await drivePr(fixture, ["--print-path"], async (session) => {
      await session.waitFor("#9");
      await typeUntil(session, KEY.enter, (text) => text.includes(PRUNE_PROMPT));
      await quit(session, KEY.escape);
    });

    // Read from git rather than from `wrk`, so the assertion is about the repository itself.
    expect(existsSync(gone)).toBe(false);
    expect(
      Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
        cwd: fixture.container,
      }).stdout.toString(),
    ).toContain(gone);
  });

  test("an unconverted repository refuses before asking to prune, not after", async () => {
    // The prune is repo-wide and irreversible-ish; the refusal that follows it is certain.
    // Asking first would spend the user's consent on a run that could never have succeeded, so
    // the layout is settled ahead of the question rather than inside the step after it.
    const clone = makeUnconverted("trunk");
    const cacheHome = tempDir();
    const { bin, log } = fakeGh();
    seed(clone, cacheHome, [pull(9, "feat/gone")]);

    const gone = join(clone, "feat+gone");
    fixtureGit(["worktree", "add", "-q", "-b", "feat/gone", gone], clone);
    rmSync(gone, { recursive: true, force: true });

    const { capture, stdout } = await driveCli(
      clone,
      ["pr", "--print-path"],
      async (session) => {
        await session.waitFor("#9");
        await quit(session, KEY.enter);
      },
      childEnv(cacheHome, bin),
      ROWS,
    );

    expect(status(capture)).toBe(1);
    expect(stdout).toBe("");
    expect(capture).toContain("not a bare-repo container");
    expect(capture).not.toContain(PRUNE_PROMPT);
    expect(ghCalls(log).some((line) => line.includes("pr checkout"))).toBe(false);
  });

  test("accepting prunes, then creates the worktree and checks the pull request out", async () => {
    const { fixture, gone } = repoWithStaleRecord();

    const { capture, stdout } = await drivePr(fixture, ["--print-path"], async (session) => {
      await session.waitFor("#9");
      await typeUntil(session, KEY.enter, (text) => text.includes(PRUNE_PROMPT));
      // The gutter is the only cue that the cursor moved, and it survives `frameLines`'
      // escape-stripping because it is a character rather than a code.
      await typeUntil(session, KEY.down, (text) =>
        frameLines(text).some((line) => line.includes("▌ prune")),
      );
      await quit(session, KEY.enter);
    });

    expect(status(capture)).toBe(0);
    expect(stdout).toBe(`${gone}\n`);
    expect(existsSync(gone)).toBe(true);
    expect(ghCalls(fixture.log)).toContain(`${gone}\tpr checkout 9`);
  });
});

describe("wrk pr — the help carve-out and the non-terminal refusal", () => {
  test("--help writes nothing to stdout, because stdout is a path the shim cds into", async () => {
    const fixture = repoWithPrs([pull(1, "feat/one")]);
    const result = await prCli(fixture, ["pr", "--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--print-path");
  });

  test("the rest of the tree keeps its help on stdout", async () => {
    // The carve-out is now two commands wide rather than one, and no wider.
    const fixture = repoWithPrs([pull(1, "feat/one")]);
    const result = await prCli(fixture, ["agent", "create", "--help"]);

    expect(result.stdout).toContain("--branch");
    expect(result.stderr).toBe("");
  });

  test("a non-terminal is a refusal, not a hang and not a dismissal", async () => {
    // `runCli` gives the child pipes, so the picker's door check fires. Exit 1 rather than 130:
    // nobody dismissed anything, there was nowhere to draw.
    const fixture = repoWithPrs([pull(1, "feat/one")]);
    const result = await prCli(fixture, ["pr", "--print-path"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("wrk: ");
    expect(result.stderr).toContain("not a terminal");
  });
});
