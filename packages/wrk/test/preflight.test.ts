/**
 * Contract of the preflight verdict — the most-depended-on answer `wrk` gives.
 *
 * Ten-plus skill files across two agent trees parse this object before every run and branch
 * on `.verdict`, so the cases below assert the **whole** nine-key envelope with `toEqual`
 * rather than the one field each case is about. A key that quietly went missing, or one that
 * appeared where the contract says `null`, is a broken caller rather than a cosmetic
 * difference.
 *
 * Every case drives the real `git` binary against real repositories built in temp
 * directories, in the actual bare-repo container shape. Verdict resolution is precisely the
 * code that passes against a mock and fails against a real `.bare` layout — and the
 * blocked-verdict cases assert that nothing on disk moved, which no mock could establish.
 *
 * Fixtures are built with `execFileSync` rather than with this module's own wrappers, so a
 * broken wrapper cannot quietly build the repository that then proves it correct.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Refusal } from "../src/errors";
import { type PreflightReport, preflight } from "../src/preflight";
import { type RunResult, run } from "../src/proc";

/**
 * The environment for fixture commands: this process's, minus everything binding git to a
 * repository.
 *
 * Read from git itself rather than from `../src/git`, so the fixtures stay independent of
 * the module they build repositories for, and stay complete if git grows another variable.
 */
const FIXTURE_ENV: Record<string, string | undefined> = {
  ...process.env,
  ...Object.fromEntries(
    execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" })
      .split("\n")
      .filter((name) => name !== "")
      .map((name) => [name, undefined]),
  ),
};

/** Identity for fixture commits, so the suite does not depend on the machine's git config. */
const AUTHOR = ["-c", "user.email=t@example.com", "-c", "user.name=T"];

/**
 * Runs `git` to build a fixture, with any inherited repository binding shed.
 *
 * Not a convenience. This suite runs under the repository's own pre-push hook, and git
 * exports `GIT_DIR` to every hook — under which `git init <dir>` re-initialises *that*
 * repository and leaves `<dir>` empty, so every fixture collapses.
 */
function fixtureGit(args: string[], cwd?: string): void {
  execFileSync("git", args, { cwd, env: FIXTURE_ENV });
}

/** Temp roots to delete once the suite finishes. */
const roots: string[] = [];

/**
 * A fresh temp directory, resolved through `realpathSync`.
 *
 * The resolution is load-bearing on macOS, where `tmpdir()` is `/var/folders/…`, a symlink
 * to `/private/var/folders/…`. Git answers with the resolved path, so an unresolved fixture
 * path fails every comparison for a reason that has nothing to do with the code.
 */
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wrk-preflight-")));
  roots.push(dir);
  return dir;
}

/** A plain, non-bare repository on `branch`, carrying one committed file. */
function makeRepo(branch = "main"): string {
  const dir = tempDir();
  fixtureGit(["init", "-q", "-b", branch, dir]);
  writeFileSync(join(dir, "tracked.txt"), "before\n");
  fixtureGit(["add", "tracked.txt"], dir);
  fixtureGit([...AUTHOR, "commit", "-q", "-m", "init"], dir);
  return dir;
}

/** A bare-repo container cloned from `seed`, with no checkouts yet. */
function makeContainer(seed: string): string {
  const dir = tempDir();
  fixtureGit(["clone", "-q", "--bare", seed, join(dir, ".bare")]);
  writeFileSync(join(dir, ".git"), "gitdir: ./.bare\n");
  return dir;
}

/** Adds a checkout of an existing branch to a container, as a sibling directory. */
function addCheckout(container: string, dirName: string, branch: string): string {
  const path = join(container, dirName);
  fixtureGit(["worktree", "add", "-q", path, branch], container);
  return path;
}

/** Adds a checkout on a newly created branch, since git refuses to check one out twice. */
function addNewCheckout(container: string, dirName: string, branch: string): string {
  const path = join(container, dirName);
  fixtureGit(["worktree", "add", "-q", "-b", branch, path], container);
  return path;
}

/** A container holding only its default-branch checkout, plus that checkout's path. */
function makeLayout(seed: string): { container: string; checkout: string } {
  const container = makeContainer(seed);
  return { container, checkout: addCheckout(container, "main", "main") };
}

/**
 * A container built the way `convert.ts`'s recipe builds one, rather than the way
 * {@link makeContainer} does.
 *
 * The difference is the whole point for the concurrency cases below. `clone --bare`
 * configures no fetch refspec and leaves the branch with no upstream, so `pull --ff-only` is
 * never reached and the sync collapses to a lone `fetch`. The recipe adds the refspec, the
 * remote-tracking refs, `origin/HEAD` and the branch's upstream — which is what a converted
 * repository really looks like, and the only shape in which the sync runs in full.
 */
function makeConvertedLayout(seed: string): { container: string; checkout: string } {
  const container = makeContainer(seed);
  const bare = join(container, ".bare");
  fixtureGit(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], bare);
  fixtureGit(["fetch", "-q", "origin"], bare);
  fixtureGit(["remote", "set-head", "origin", "-a"], bare);

  const checkout = addCheckout(container, "main", "main");
  fixtureGit(["branch", "--quiet", "--set-upstream-to=origin/main", "main"], checkout);
  return { container, checkout };
}

/** Commits `name` to a seed repository, leaving every container cloned from it behind. */
function commitToSeed(seed: string, name: string): void {
  writeFileSync(join(seed, name), "later\n");
  fixtureGit(["add", name], seed);
  fixtureGit([...AUTHOR, "commit", "-q", "-m", name], seed);
}

/**
 * The real CLI entry point, run as a child.
 *
 * A child rather than `main(argv, program)` in process, because what the cases using this
 * are about is the exit status and which stream each byte reached — neither observable from
 * inside the process producing them — and, for the concurrency cases, because `FETCH_HEAD`
 * and `index.lock` are contended between operating-system processes.
 */
function wrk(args: string[], cwd: string): Promise<RunResult> {
  return run(process.execPath, [join(import.meta.dir, "../src/cli.ts"), ...args], { cwd });
}

/**
 * Every path under `root`, with its size and modification time, sorted.
 *
 * The evidence behind "a blocked verdict leaves the repository byte-identical". Comparing
 * this before and after catches every mutation preflight could make — a `FETCH_HEAD` written
 * by a fetch, a ref moved by a pull, a rewritten index, a switched work tree — where
 * asserting on `git status` alone would catch only the last of them. Directories are
 * included, and their mtime is what betrays a file appearing inside one.
 */
function manifest(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      const stats = lstatSync(path);
      return `${path} ${stats.isDirectory() ? "dir" : stats.size} ${stats.mtimeMs}`;
    })
    .sort();
}

/** The nine keys, in the order the contract fixes them. */
const KEYS = [
  "verdict",
  "reason",
  "repo_root",
  "default_branch",
  "base",
  "current_branch",
  "worktree_root",
  "current_worktree",
  "conversion_reference",
];

/**
 * A full nine-key report, with `overrides` applied over an all-`null` baseline.
 *
 * Written this way so each case below states only the fields it is about while still
 * asserting the whole object — which is what makes a key that went missing a failure.
 */
function expected(overrides: Partial<PreflightReport>): PreflightReport {
  return {
    verdict: "blocked",
    reason: null,
    repo_root: "",
    default_branch: null,
    base: null,
    current_branch: null,
    worktree_root: null,
    current_worktree: null,
    conversion_reference: null,
    ...overrides,
  };
}

let seed: string;
let notARepo: string;

beforeAll(() => {
  seed = makeRepo();
  notARepo = tempDir();
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("the envelope", () => {
  test("carries all nine keys, in the contract's order", async () => {
    const { checkout } = makeLayout(seed);

    expect(Object.keys(await preflight("EXC-1", checkout))).toEqual(KEYS);
  });
});

describe("blocked / container-cwd", () => {
  test("is the verdict when the run is invoked from the container itself", async () => {
    // The container keeps the path the repository had before conversion, so stale bookmarks
    // and plain habit both land there — and a bare repository has no work tree, so every
    // later step would fail. It is a verdict rather than a crash for exactly that reason.
    const { container } = makeLayout(seed);

    expect(await preflight("EXC-1", container)).toEqual(
      expected({ reason: "container-cwd", repo_root: container }),
    );
  });

  test("is the verdict from inside the bare repository, not just from the container", async () => {
    const { container } = makeLayout(seed);
    const bare = join(container, ".bare");

    expect(await preflight("EXC-1", bare)).toEqual(
      expected({ reason: "container-cwd", repo_root: bare }),
    );
  });

  test("is not reported for a directory in no repository at all", async () => {
    // The distinction the probe is checked for. Both answer "there is no work tree here",
    // but only one has a checkout below it to be told to cd into, so reporting this verdict
    // for the other would hand the caller advice that cannot be followed. git's own 128
    // reaches the caller instead.
    const failure: unknown = await preflight("EXC-1", notARepo).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: number }).code).toBe(128);
  });
});

describe("blocked / unconverted-repo", () => {
  test("is the verdict for a plain repository, and the only one naming the conversion", async () => {
    const plain = makeRepo();

    expect(await preflight("EXC-1", plain)).toEqual(
      expected({
        reason: "unconverted-repo",
        repo_root: plain,
        current_branch: "main",
        conversion_reference: "repo-setup",
      }),
    );
  });

  test("names the skill as a bare name, never a path", async () => {
    // The two agent trees spell an invocation differently, so a name is the only form each
    // can render in its own idiom.
    const report = await preflight("EXC-1", makeRepo());

    expect(report.conversion_reference).toBe("repo-setup");
  });
});

describe("blocked / unrelated-worktree", () => {
  test("is the verdict inside somebody else's run worktree", async () => {
    const { container } = makeLayout(seed);
    const theirs = addNewCheckout(container, "EXC-2+other", "EXC-2/other");

    expect(await preflight("EXC-1", theirs)).toEqual(
      expected({
        reason: "unrelated-worktree",
        repo_root: theirs,
        current_branch: "EXC-2/other",
        current_worktree: theirs,
      }),
    );
  });

  test("does not mistake EXC-1 for EXC-10's worktree", async () => {
    // The trailing separator in `branchBelongsToIssue`, reached through preflight: without it
    // a run for EXC-1 would adopt EXC-10's worktree and commit into it.
    const { container } = makeLayout(seed);
    const theirs = addNewCheckout(container, "EXC-10+other", "EXC-10/other");

    expect((await preflight("EXC-1", theirs)).reason).toBe("unrelated-worktree");
  });
});

describe("resumed", () => {
  test("is the verdict inside this issue's own run worktree", async () => {
    const { container } = makeLayout(seed);
    const mine = addNewCheckout(container, "EXC-1+add-thing", "EXC-1/add-thing");

    expect(await preflight("EXC-1", mine)).toEqual(
      expected({
        verdict: "resumed",
        repo_root: mine,
        current_branch: "EXC-1/add-thing",
        current_worktree: mine,
      }),
    );
  });

  test("is not reported for a checkout merely parked on an issue branch", async () => {
    // Both halves of `isRunWorktree` matter: the directory has to be the one the branch would
    // have been given. A default-branch checkout someone switched to a feature branch is not
    // an isolated worktree, and treating it as one would skip the sync it still needs — so
    // this proceeds, having switched back to the default, rather than resuming.
    const own = makeContainer(seed);
    const parked = addNewCheckout(own, "not-the-folded-name", "EXC-1/add-thing");

    expect(await preflight("EXC-1", parked)).toEqual(
      expected({
        verdict: "proceed",
        repo_root: parked,
        default_branch: "main",
        base: "main",
        current_branch: "main",
        worktree_root: own,
      }),
    );
  });

  test("fails loudly, rather than answering, for a hand-made worktree under a stray name", async () => {
    // The residual hole this rule leaves, pinned because it looks like a bug and is not.
    // A worktree created by hand under a non-conforming directory name falls through to the
    // default-branch path, where the switch fails because the default branch is checked out
    // elsewhere. Closing it would mean asking `worktree list` which checkout holds the default
    // branch — a question that answers nothing whenever that checkout is itself parked on
    // something else, trading a loud failure in a rare case for a wrong answer in a less rare
    // one.
    const own = makeContainer(seed);
    addCheckout(own, "main", "main");
    const stray = addNewCheckout(own, "not-the-folded-name", "EXC-1/add-thing");

    await expect(preflight("EXC-1", stray)).rejects.toThrow(/already used by worktree/);
  });
});

describe("blocked / dirty-checkout", () => {
  test("is the verdict when a tracked file is modified", async () => {
    const { checkout } = makeLayout(seed);
    writeFileSync(join(checkout, "tracked.txt"), "after\n");

    expect(await preflight("EXC-1", checkout)).toEqual(
      expected({
        reason: "dirty-checkout",
        repo_root: checkout,
        default_branch: "main",
        base: "main",
        current_branch: "main",
      }),
    );
  });

  test("is not the verdict for untracked files alone", async () => {
    // Scratch files and build output are normal in a working checkout and block neither the
    // switch nor the fast-forward pull, so they are deliberately not "dirty".
    const { checkout } = makeLayout(seed);
    writeFileSync(join(checkout, "scratch.txt"), "x\n");

    expect((await preflight("EXC-1", checkout)).verdict).toBe("proceed");
  });
});

describe("proceed", () => {
  test("reports the container as worktree_root, not the checkout", async () => {
    // The field name is misleading and frozen: callers read `worktree_root` to learn where a
    // *sibling* worktree goes, which is the container.
    const { container, checkout } = makeLayout(seed);

    expect(await preflight("EXC-1", checkout)).toEqual(
      expected({
        verdict: "proceed",
        repo_root: checkout,
        default_branch: "main",
        base: "main",
        current_branch: "main",
        worktree_root: container,
      }),
    );
  });

  test("switches a checkout parked on another branch back to the default", async () => {
    // The sync half of a proceed, and the only case that observes it: `current_branch` is
    // what the checkout is on *after* the switch, not what it was on when preflight started.
    // Its own container, since git refuses to check `main` out in two worktrees at once.
    const own = makeContainer(seed);
    const parked = addNewCheckout(own, "side-checkout", "side");

    expect((await preflight("EXC-1", parked)).current_branch).toBe("main");
  });

  test("syncs a repository with no origin, rather than failing on the fetch", async () => {
    // A container with no remote is ordinary in this layout — there is simply nothing to
    // fetch or fast-forward, and git reports both as errors, so each is guarded rather than
    // attempted.
    const own = makeContainer(seed);
    fixtureGit(["remote", "remove", "origin"], join(own, ".bare"));
    const checkout = addCheckout(own, "main", "main");

    expect((await preflight("EXC-1", checkout)).verdict).toBe("proceed");
  });
});

describe("--base", () => {
  test("skips the dirty check and the sync entirely, while still resolving the default", async () => {
    // The stacked path. A local feature branch is never fetched or pulled, so the whole
    // default-branch sync is skipped — but the layout and isolation checks still ran, and
    // `default_branch` is still reported.
    const { container, checkout } = makeLayout(seed);
    writeFileSync(join(checkout, "tracked.txt"), "after\n");

    expect(await preflight("EXC-1", checkout, { base: "EXC-0/parent" })).toEqual(
      expected({
        verdict: "proceed",
        repo_root: checkout,
        default_branch: "main",
        base: "EXC-0/parent",
        current_branch: "main",
        worktree_root: container,
      }),
    );
  });

  test("leaves the repository untouched, since it never syncs", async () => {
    // Manifested over the *container*, not the checkout: a linked worktree's `.git` is a file,
    // so a recursive walk of the checkout never descends into the common git dir — which is
    // exactly where a `fetch` writes `FETCH_HEAD`. And `FETCH_HEAD` is the only artifact this
    // fixture would produce, since the checkout is already on `main` (no switch) and a bare
    // clone leaves `main` with no upstream (no pull). Pointed at the checkout, this case would
    // pass an implementation that ignored the "no fetch" half of `--base` entirely.
    const { container, checkout } = makeLayout(seed);
    writeFileSync(join(checkout, "tracked.txt"), "after\n");
    const before = manifest(container);

    await preflight("EXC-1", checkout, { base: "EXC-0/parent" });

    expect(manifest(container)).toEqual(before);
  });
});

describe("the refusal path", () => {
  test("refuses, rather than reporting a verdict, with no default branch to sync", async () => {
    // Not one of the four block reasons and deliberately so: there is nothing to sync to, so
    // there is no answer to give. The two things a caller sees are exit 1 and an empty stdout,
    // which is what a future refactor into a fourth verdict would silently break.
    const own = makeContainer(makeRepo("weird"));
    fixtureGit(["worktree", "add", "-q", "--detach", join(own, "co"), "HEAD"], own);

    await expect(preflight("EXC-1", join(own, "co"))).rejects.toBeInstanceOf(Refusal);
  });

  test("is skipped under --base, which needs no default branch", async () => {
    const own = makeContainer(makeRepo("weird"));
    fixtureGit(["worktree", "add", "-q", "--detach", join(own, "co"), "HEAD"], own);

    expect(await preflight("EXC-1", join(own, "co"), { base: "EXC-0/parent" })).toEqual(
      expected({
        verdict: "proceed",
        repo_root: join(own, "co"),
        base: "EXC-0/parent",
        worktree_root: own,
      }),
    );
  });
});

describe("a blocked verdict leaves the repository byte-identical", () => {
  // The criterion every other case rests on: every check precedes the first mutation of the
  // repository, so a caller told "blocked" can act on it knowing the repository did not move.
  // Asserted per reason rather than once, because each stops at a different point in the
  // sequence. The one thing preflight does write on a blocked path is the sync lock, which
  // lives in the container rather than in the repository and is gone before it returns.

  test("container-cwd", async () => {
    const { container } = makeLayout(seed);
    const before = manifest(container);

    expect((await preflight("EXC-1", container)).verdict).toBe("blocked");
    expect(manifest(container)).toEqual(before);
  });

  test("unconverted-repo", async () => {
    const plain = makeRepo();
    const before = manifest(plain);

    expect((await preflight("EXC-1", plain)).verdict).toBe("blocked");
    expect(manifest(plain)).toEqual(before);
  });

  test("unrelated-worktree", async () => {
    const { container } = makeLayout(seed);
    addNewCheckout(container, "EXC-2+other", "EXC-2/other");
    const before = manifest(container);

    expect((await preflight("EXC-1", join(container, "EXC-2+other"))).verdict).toBe("blocked");
    expect(manifest(container)).toEqual(before);
  });

  test("dirty-checkout", async () => {
    // The one that would fail an implementation that fetched before checking: the fetch
    // writes FETCH_HEAD into the common git dir, which the manifest sees.
    const { container, checkout } = makeLayout(seed);
    writeFileSync(join(checkout, "tracked.txt"), "after\n");
    const before = manifest(container);

    expect((await preflight("EXC-1", checkout)).verdict).toBe("blocked");
    expect(manifest(container)).toEqual(before);
  });
});

describe("wrk agent preflight", () => {
  test("exits 0 on proceed and prints one parseable object on stdout", async () => {
    const { container, checkout } = makeLayout(seed);
    const result = await wrk(["agent", "preflight", "--issue", "EXC-1"], checkout);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      expected({
        verdict: "proceed",
        repo_root: checkout,
        default_branch: "main",
        base: "main",
        current_branch: "main",
        worktree_root: container,
      }),
    );
  });

  test("exits 0 on a blocked verdict too", async () => {
    // The rule callers depend on and the one most likely to be got wrong: a well-formed
    // "stop" is a successful run, because they branch on `.verdict` and never on the status.
    const { container } = makeLayout(seed);
    const result = await wrk(["agent", "preflight", "--issue", "EXC-1"], container);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).reason).toBe("container-cwd");
  });

  test("emits the nine keys in order, so `jq` reads any of them unconditionally", async () => {
    const { checkout } = makeLayout(seed);
    const result = await wrk(["agent", "preflight", "--issue", "EXC-1"], checkout);

    expect(Object.keys(JSON.parse(result.stdout))).toEqual(KEYS);
  });

  test("takes --base and reports it", async () => {
    const { checkout } = makeLayout(seed);
    const result = await wrk(
      ["agent", "preflight", "--issue", "EXC-1", "--base", "EXC-0/parent"],
      checkout,
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).base).toBe("EXC-0/parent");
  });

  test("requires --issue, and writes nothing to stdout when it is missing", async () => {
    // Nothing on stdout is the half that matters: consumers pipe through `jq -er`, which
    // exits 0 on empty input, so a partial write here would swallow their failure path.
    const { checkout } = makeLayout(seed);
    const result = await wrk(["agent", "preflight"], checkout);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  test("exits with git's own status outside a repository, printing no envelope", async () => {
    const result = await wrk(["agent", "preflight", "--issue", "EXC-1"], notARepo);

    expect(result.code).toBe(128);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("wrk: ");
  });
});

describe("concurrent runs against one container", () => {
  /**
   * How many preflights race. Two is what the issue asks for; four makes the collision
   * reliable enough to fail a regression rather than to flake into passing one.
   */
  const RACERS = 4;

  /**
   * A converted container whose checkout is genuinely behind its remote, so the sync has real
   * work to do.
   *
   * Every collision this suite is about needs the sync to reach its end: `FETCH_HEAD` is
   * written by the fetch, and the index and the work tree are rewritten by the fast-forward.
   * A checkout already up to date exercises none of it, so the seed gains a commit *after*
   * the container is cloned from it.
   */
  function makeBehindLayout(): { container: string; checkout: string } {
    const seed = makeRepo();
    const layout = makeConvertedLayout(seed);
    commitToSeed(seed, "later.txt");
    return layout;
  }

  test("all of them proceed, and none is told the checkout is dirty", async () => {
    // The regression, against the collisions `preflight.ts`'s header lists. The whole
    // envelope is asserted rather than the exit status, because the collision that matters
    // most produces a wrong *answer* rather than a crash: a concurrent sync makes `git status`
    // report a clean checkout as dirty, and a caller that branches on `.verdict` acts on it.
    const { container, checkout } = makeBehindLayout();

    const results = await Promise.all(
      Array.from({ length: RACERS }, () =>
        wrk(["agent", "preflight", "--issue", "EXC-1"], checkout),
      ),
    );

    for (const result of results) {
      expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual(
        expected({
          verdict: "proceed",
          repo_root: checkout,
          default_branch: "main",
          base: "main",
          current_branch: "main",
          worktree_root: container,
        }),
      );
    }
  });

  test("the checkout really was fast-forwarded, so the race window was real", async () => {
    // Guards the fixture rather than the code. A container whose sync had nothing to do would
    // pass the case above while contending for nothing at all, leaving the regression
    // permanently green and permanently meaningless.
    const { checkout } = makeBehindLayout();

    await Promise.all(
      Array.from({ length: RACERS }, () =>
        wrk(["agent", "preflight", "--issue", "EXC-1"], checkout),
      ),
    );

    expect(existsSync(join(checkout, "later.txt"))).toBe(true);
  });

  test("leaves no lock behind once the runs are over", async () => {
    // The lock is `wrk`'s own file in the container, so it is `wrk`'s to remove. One left
    // behind would be invisible for a full staleness window and then silently stop
    // serialising anything.
    const { container, checkout } = makeBehindLayout();

    await Promise.all(
      Array.from({ length: RACERS }, () =>
        wrk(["agent", "preflight", "--issue", "EXC-1"], checkout),
      ),
    );

    expect(readdirSync(container).filter((entry) => entry.includes("lock"))).toEqual([]);
  });

  test("--base never waits on the sync lock", async () => {
    // The stacked path syncs nothing, so it has no reason to queue behind a sync somebody
    // else is running — and every stacked run in a burst would otherwise wait its turn for a
    // critical section it never enters. Without the skip this case does not fail, it hangs
    // until the planted lock goes stale.
    const { container, checkout } = makeLayout(seed);
    mkdirSync(join(container, ".wrk-sync.lock"));

    expect((await preflight("EXC-1", checkout, { base: "EXC-0/parent" })).verdict).toBe("proceed");
  });
});
