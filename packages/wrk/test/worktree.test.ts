/**
 * Contract of the `create` engine: where a run worktree lands, what branch it is given, what
 * it is branched from, and what it refuses.
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
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { CommandFailed, Refusal } from "../src/output";
import { createWorktree } from "../src/worktree";

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

  test("refuses a directory in no repository at all", async () => {
    const failure: unknown = await createWorktree(notARepo, { branch: "EXC-11/x" }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Refusal);
    expect((failure as Refusal).message).toMatch(/repo-setup skill/);
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
