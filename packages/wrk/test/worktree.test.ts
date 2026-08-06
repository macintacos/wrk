/**
 * Contract of the `create` engine and of the `wrk agent create` command over it: where a run
 * worktree lands, what branch it is given, what it is branched from, what it refuses, and
 * which of the two stdout shapes each invocation produces.
 *
 * Every case drives the real `git` binary against real repositories built in temp
 * directories, in the actual bare-repo container shape. The acceptance criterion — the
 * branch keeps its slashes while only the directory folds them to `+` — is asserted by
 * reading HEAD back out of the created worktree with `git`, rather than by re-deriving the
 * name the engine used, which would only prove the engine agrees with itself.
 *
 * Fixtures are built with `execFileSync` rather than with this package's own wrappers, so a
 * broken wrapper cannot quietly build the repository that then proves it correct.
 *
 * The fixture helpers below are copied from `repo.test.ts` rather than lifted into a module
 * both suites import. A shared fixture-repo builder is the explicit scope of EXC-1003, and
 * extracting one here would settle that issue's design as a side effect of writing this
 * suite.
 *
 * The command cases run the real CLI in a child process, for `cli.test.ts`'s reason — `main`
 * assigns `process.exitCode` rather than calling `process.exit`, so asserting a status in
 * process would leave the test runner itself exiting nonzero. Here a child buys a second
 * thing the engine cases cannot give: stdout as an actual stream, which is the only way to
 * assert what this contract most needs asserted — that a *failed* run writes nothing to it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { CommandFailed, Refusal } from "../src/output";
import { type RunResult, run } from "../src/proc";
import { createWorktree } from "../src/worktree";

/** The CLI entry point, run as a script by the command cases below. */
const CLI = join(import.meta.dir, "../src/cli.ts");

/**
 * Runs `wrk agent create` in a child process, from `cwd`.
 *
 * `process.execPath` is the runtime already running this suite, so no toolchain lookup is
 * involved and the child is the same binary a user's `wrk` would be.
 */
function agentCreate(cwd: string, args: string[]): Promise<RunResult> {
  return run(process.execPath, [CLI, "agent", "create", ...args], { cwd });
}

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

/**
 * Runs `git` with any inherited repository binding shed, and returns its trimmed stdout.
 *
 * Shedding the environment is not a convenience. This suite runs under the repository's own
 * pre-push hook, and git exports `GIT_DIR` to every hook — under which `git init <dir>`
 * re-initialises *that* repository and leaves `<dir>` empty, so every fixture collapses.
 *
 * The return value is what the assertions read HEAD and the base commits back through;
 * fixture-building callers ignore it.
 */
function fixtureGit(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, env: FIXTURE_ENV, encoding: "utf8" }).trim();
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wrk-worktree-")));
  roots.push(dir);
  return dir;
}

/** Lands one empty commit, with an identity that does not depend on the runner's git config. */
function commit(repo: string, message: string): void {
  fixtureGit(
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      message,
    ],
    repo,
  );
}

/** A plain, non-bare repository on `branch` with exactly one commit. */
function makeRepo(branch = "main"): string {
  const dir = tempDir();
  fixtureGit(["init", "-q", "-b", branch, dir]);
  commit(dir, "init");
  return dir;
}

/**
 * Creates `branch` with a commit of its own and returns to `base`.
 *
 * The extra commit is the point: a base that shares the default branch's commit would let a
 * `base`-ignoring implementation pass every assertion about where a worktree started.
 */
function makeBranchAhead(repo: string, branch: string, base: string): void {
  fixtureGit(["checkout", "-q", "-b", branch], repo);
  commit(repo, branch);
  fixtureGit(["checkout", "-q", base], repo);
}

/**
 * A bare-repo container with no checkouts yet: a `.bare` clone plus the `.git` pointer file
 * the conversion writes.
 */
function makeContainer(source: string): string {
  const dir = tempDir();
  fixtureGit(["clone", "-q", "--bare", source, join(dir, ".bare")]);
  writeFileSync(join(dir, ".git"), "gitdir: ./.bare\n");
  return dir;
}

/** Adds a checkout of an existing branch to a container, as a sibling directory. */
function addCheckout(container: string, dirName: string, branch: string): string {
  const path = join(container, dirName);
  fixtureGit(["worktree", "add", "-q", path, branch], container);
  return path;
}

/**
 * A container in the shape `wrk` actually operates on: converted, with its default-branch
 * checkout in place.
 *
 * One per test rather than one for the suite. Each case creates worktrees and branches in
 * it, and a shared container would make every later case depend on which ones ran first.
 */
function makeConverted(): string {
  const container = makeContainer(seed);
  addCheckout(container, "main", "main");
  return container;
}

let seed: string;
let plainClone: string;
let notARepo: string;

beforeAll(() => {
  seed = makeRepo("main");
  makeBranchAhead(seed, "release", "main");
  plainClone = join(tempDir(), "work");
  fixtureGit(["clone", "-q", seed, plainClone]);
  notARepo = tempDir();
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("createWorktree", () => {
  test("places the worktree in the container and reports its absolute path", async () => {
    const container = makeConverted();

    const created = await createWorktree(join(container, "main"), { branch: "EXC-1/add-thing" });

    expect(created).toEqual({
      worktree_path: join(container, "EXC-1+add-thing"),
      branch: "EXC-1/add-thing",
    });
    // A directory at the right path is not yet a worktree; git saying it is one is.
    expect(fixtureGit(["rev-parse", "--show-toplevel"], created.worktree_path)).toBe(
      created.worktree_path,
    );
  });

  test("hands the branch to git verbatim while only the directory folds", async () => {
    // The acceptance criterion, and the one thing here git has to answer rather than the
    // engine: folding the branch too would mint a literal `EXC-2+fold-only` ref, and every
    // later lookup keyed off the issue prefix would still pass.
    const container = makeConverted();

    const created = await createWorktree(container, { branch: "EXC-2/fold-only" });

    expect(basename(created.worktree_path)).toBe("EXC-2+fold-only");
    expect(fixtureGit(["symbolic-ref", "HEAD"], created.worktree_path)).toBe(
      "refs/heads/EXC-2/fold-only",
    );
    expect(created.branch).toBe("EXC-2/fold-only");
  });

  test("starts the branch at an explicit base", async () => {
    const container = makeConverted();

    const created = await createWorktree(container, {
      branch: "EXC-3/off-release",
      base: "release",
    });

    expect(fixtureGit(["rev-parse", "HEAD"], created.worktree_path)).toBe(
      fixtureGit(["rev-parse", "release"], container),
    );
    expect(fixtureGit(["rev-parse", "HEAD"], created.worktree_path)).not.toBe(
      fixtureGit(["rev-parse", "main"], container),
    );
  });

  test("starts at the repository's default branch when no base is given", async () => {
    // Called from a worktree parked on `release`, so "the default branch" and "whatever the
    // caller had checked out" are different commits — which is what makes this a test of
    // resolution rather than of git's own HEAD default.
    const container = makeConverted();
    const onRelease = await createWorktree(container, {
      branch: "EXC-4/on-release",
      base: "release",
    });

    const created = await createWorktree(onRelease.worktree_path, { branch: "EXC-5/off-default" });

    expect(fixtureGit(["rev-parse", "HEAD"], created.worktree_path)).toBe(
      fixtureGit(["rev-parse", "main"], container),
    );
    expect(fixtureGit(["rev-parse", "HEAD"], created.worktree_path)).not.toBe(
      fixtureGit(["rev-parse", "release"], container),
    );
  });

  test("creates a sibling in the container when called from inside a run worktree", async () => {
    // The failure this rules out is a worktree nested inside the caller's — which git will
    // happily create, and which every `wrk` command that enumerates the container's siblings
    // would then miss.
    const container = makeConverted();
    const first = await createWorktree(container, { branch: "EXC-6/first" });

    const second = await createWorktree(first.worktree_path, { branch: "EXC-7/second" });

    expect(second.worktree_path).toBe(join(container, "EXC-7+second"));
  });

  test("works from the container, and from the .bare directory the editor hook passes", async () => {
    // Neither cwd has a work tree, and both are ordinary: the container keeps the path the
    // repository had before conversion, and the `WorktreeCreate` hook is handed `.bare`.
    const container = makeConverted();

    const fromContainer = await createWorktree(container, { branch: "EXC-8/from-container" });
    const fromBare = await createWorktree(join(container, ".bare"), {
      branch: "EXC-9/from-bare",
    });

    expect(fromContainer.worktree_path).toBe(join(container, "EXC-8+from-container"));
    expect(fromBare.worktree_path).toBe(join(container, "EXC-9+from-bare"));
    expect(fixtureGit(["symbolic-ref", "HEAD"], fromBare.worktree_path)).toBe(
      "refs/heads/EXC-9/from-bare",
    );
  });

  test("refuses an unconverted clone, which has no container to hold a sibling", async () => {
    // A refusal rather than a verdict: `create`'s contract is that the worktree now exists,
    // so there is no partial answer to hand back and nothing was changed.
    const failure: unknown = await createWorktree(plainClone, { branch: "EXC-10/x" }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Refusal);
    expect((failure as Refusal).message).toMatch(/repo-setup skill/);
  });

  test("refuses a directory in no repository at all, and does not tell it to convert", async () => {
    // The two refusals carry different remedies on purpose. Advising a user standing in an
    // empty directory to "convert it first" names a repository that is not there; the only
    // useful thing to say is that there is none.
    const failure: unknown = await createWorktree(notARepo, { branch: "EXC-11/x" }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Refusal);
    expect((failure as Refusal).message).toMatch(/not a git repository/);
    expect((failure as Refusal).message).not.toMatch(/convert/);
  });

  test("reads a HEAD-relative base from the checkout, not from the bare repository", async () => {
    // The one case that pins `checkoutFor` on the first line, and it needs to be this
    // specific: plain ref names, tags and shas resolve identically from `.bare` and from a
    // checkout, because refs are shared. Only `HEAD` differs — so without that resolution
    // this reads the bare repository's HEAD, and every other test in this file still passes.
    const container = makeConverted();
    fixtureGit(["symbolic-ref", "HEAD", "refs/heads/release"], join(container, ".bare"));

    const created = await createWorktree(join(container, ".bare"), {
      branch: "EXC-12/head-relative",
      base: "HEAD",
    });

    expect(fixtureGit(["rev-parse", "HEAD"], created.worktree_path)).toBe(
      fixtureGit(["rev-parse", "main"], container),
    );
    expect(fixtureGit(["rev-parse", "HEAD"], created.worktree_path)).not.toBe(
      fixtureGit(["rev-parse", "release"], container),
    );
  });

  test("lets git's own failure through, carrying its exit status, when the branch exists", async () => {
    // `release` exists as a branch but has no directory in the container, so the only thing
    // git can be refusing is the branch — and `wrk` exits with git's status rather than
    // inventing one, so the code has to survive as a value.
    const container = makeConverted();

    const failure: unknown = await createWorktree(container, { branch: "release" }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CommandFailed);
    expect((failure as CommandFailed).code).not.toBe(0);
  });
});

describe("wrk agent create", () => {
  test("emits the envelope, carrying worktree_path first", async () => {
    const container = makeConverted();

    const result = await agentCreate(container, ["--branch", "EXC-20/envelope"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      worktree_path: join(container, "EXC-20+envelope"),
      branch: "EXC-20/envelope",
    });
    // Key order is part of the contract, not an accident of the serializer: two runs of the
    // same command have to diff cleanly.
    expect(Object.keys(JSON.parse(result.stdout))).toEqual(["worktree_path", "branch"]);
  });

  test("prints the worktree path alone under --hook, with no JSON around it", async () => {
    // What the editor's WorktreeCreate hook consumes: it enters whatever the last non-empty
    // stdout line names, so a brace or a quote anywhere in it is a directory that cannot be
    // entered.
    const container = makeConverted();

    const result = await agentCreate(container, ["--branch", "EXC-21/hook", "--hook"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${join(container, "EXC-21+hook")}\n`);
  });

  test("writes nothing to stdout when it refuses, so `jq -er` fails rather than exiting 0", async () => {
    // The whole reason the failure shape is specified. `jq -er` exits 0 on *empty* input, so
    // a run that failed while still exiting 0 would be read as a success with no path — and
    // an envelope emitted before the failure would be read as a success outright.
    const result = await agentCreate(plainClone, ["--branch", "EXC-22/nope"]);

    expect(result.stdout).toBe("");
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^wrk: not a bare-repo container.*repo-setup skill\n$/);
  });

  test("writes nothing to stdout when it refuses under --hook either", async () => {
    // Distinct from the case above rather than a restatement of it: --hook takes a different
    // write path, and it is the mode where a stray line is worst — the editor would enter it.
    const result = await agentCreate(plainClone, ["--branch", "EXC-23/nope", "--hook"]);

    expect(result.stdout).toBe("");
    expect(result.code).toBe(1);
  });

  test("exits with git's own status, and still says nothing on stdout, when git refuses", async () => {
    const container = makeConverted();

    const result = await agentCreate(container, ["--branch", "release"]);

    expect(result.stdout).toBe("");
    // Not a literal: git picks this status and does not pick it consistently — 255 for a
    // branch that already exists, 128 for a taken path or an unresolvable base, on the same
    // git. What the exit rule promises is that the child's status is *inherited* rather than
    // flattened, so the assertion is that it is neither success nor the refusal code.
    expect(result.code).not.toBe(0);
    expect(result.code).not.toBe(1);
    expect(result.stderr).toMatch(/^wrk: git worktree add/);
  });

  test("rejects a missing --branch on stderr, before anything reaches stdout", async () => {
    const result = await agentCreate(makeConverted(), []);

    expect(result.stdout).toBe("");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/required option/);
  });
});
