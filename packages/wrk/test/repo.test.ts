/**
 * Contract of the repo model and its resolution rules.
 *
 * Every case drives the real `git` binary against real repositories built in temp
 * directories, in the actual bare-repo container shape — a `.bare` clone, a `.git` file
 * pointing at it, and each checkout a sibling directory. Container resolution is precisely
 * the code that passes against a mock and fails against a real `.bare` layout, so there is
 * no fake git here and no synthesised porcelain output.
 *
 * Fixtures are built with `execFileSync` rather than with this module's own wrappers, so a
 * broken wrapper cannot quietly build the repository that then proves it correct.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkoutFor, containerFor, isBareLayout, locate, resolveDefaultBranch } from "../src/repo";

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
 * to `/private/var/folders/…`. Git answers with the resolved path, so an unresolved
 * fixture path fails every comparison for a reason that has nothing to do with the code.
 */
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wrk-repo-")));
  roots.push(dir);
  return dir;
}

/** A plain, non-bare repository on `branch` with exactly one commit. */
function makeRepo(branch = "main"): string {
  const dir = tempDir();
  fixtureGit(["init", "-q", "-b", branch, dir]);
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
      "init",
    ],
    dir,
  );
  return dir;
}

/** Creates `branch` in a repository, without checking it out. */
function makeBranch(repo: string, branch: string): void {
  fixtureGit(["branch", branch], repo);
}

/**
 * A bare-repo container with no checkouts yet: a `.bare` clone plus the `.git` pointer file
 * the conversion writes.
 *
 * Built at `parent` when given, so the symlink case can place one under a symlinked path.
 */
function makeContainer(seed: string, parent?: string): string {
  const dir = parent ?? tempDir();
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

/**
 * Adds a checkout on a newly created branch.
 *
 * Separate from {@link addCheckout} because git refuses to check the same branch out twice,
 * so every fixture beyond the first checkout needs a branch of its own.
 */
function addNewCheckout(container: string, dirName: string, branch: string): string {
  const path = join(container, dirName);
  fixtureGit(["worktree", "add", "-q", "-b", branch, path], container);
  return path;
}

let seed: string;
let container: string;
let checkout: string;
let notARepo: string;

beforeAll(() => {
  seed = makeRepo("main");
  container = makeContainer(seed);
  checkout = addCheckout(container, "main", "main");
  notARepo = tempDir();
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("containerFor", () => {
  test("resolves identically from the container, a checkout, and a linked worktree", async () => {
    // The property the whole repo model hangs off: one stable key for the repository, from
    // anywhere inside it. `--show-toplevel` cannot do this — under this layout its basename
    // is a *branch* name, so it re-keys the moment a run worktree is created.
    const worktree = addNewCheckout(container, "EXC-1+add-thing", "EXC-1/add-thing");

    expect(await containerFor(container)).toBe(container);
    expect(await containerFor(checkout)).toBe(container);
    expect(await containerFor(worktree)).toBe(container);
  });

  test("resolves from a nested subdirectory of a checkout", async () => {
    const nested = join(checkout, "a", "b");
    mkdirSync(nested, { recursive: true });

    expect(await containerFor(nested)).toBe(container);
  });

  test("returns null outside a repository", async () => {
    expect(await containerFor(notARepo)).toBeNull();
  });

  test("answers the physical path when the container is reached through a symlink", async () => {
    // The acceptance criterion's "a symlinked temp dir cannot defeat a match". macOS makes
    // this the default rather than the exotic case: `/var` is a symlink to `/private/var`,
    // so every temp-dir path is symlinked before anyone tries to be clever.
    const base = tempDir();
    const physical = join(base, "physical");
    mkdirSync(physical);
    symlinkSync(physical, join(base, "link"));

    const real = makeContainer(seed, physical);
    addCheckout(real, "main", "main");
    const viaLink = join(base, "link");

    expect(await containerFor(viaLink)).toBe(physical);
    expect(await containerFor(join(viaLink, "main"))).toBe(physical);
    expect(await containerFor(join(viaLink, "main"))).toBe(
      await containerFor(join(physical, "main")),
    );
  });
});

describe("isBareLayout", () => {
  test("is true in a converted container and from a checkout inside it", async () => {
    expect(await isBareLayout(container)).toBe(true);
    expect(await isBareLayout(checkout)).toBe(true);
  });

  test("is false for a plain repository", async () => {
    expect(await isBareLayout(seed)).toBe(false);
  });

  test("is false for the <name>.git convention, where core.bare is true but no .git exists", async () => {
    // The half `core.bare` alone cannot decide. Here the derived container is a directory of
    // *other repositories*, so treating it as a container would scatter worktrees among
    // them. The `.git` pointer file is what makes a container a container.
    const parent = tempDir();
    fixtureGit(["clone", "-q", "--bare", seed, join(parent, "project.git")]);

    expect(await isBareLayout(join(parent, "project.git"))).toBe(false);
  });

  test("is false when the container's .git is a directory rather than a file", async () => {
    // Pins `isFile()` specifically rather than mere existence — a normal repository's `.git`
    // is a directory, and the conversion's is a file.
    const parent = tempDir();
    fixtureGit(["clone", "-q", "--bare", seed, join(parent, "project.git")]);
    mkdirSync(join(parent, ".git"));

    expect(await isBareLayout(join(parent, "project.git"))).toBe(false);
  });

  test("is false outside a repository", async () => {
    expect(await isBareLayout(notARepo)).toBe(false);
  });
});

describe("resolveDefaultBranch", () => {
  test("prefers origin/HEAD over the conventional names", async () => {
    // The clone carries a local `main` too, so a fallback-first implementation would answer
    // `main` here. Only reading origin/HEAD gives `release`.
    const upstream = makeRepo("release");
    makeBranch(upstream, "main");
    const clone = tempDir();
    fixtureGit(["clone", "-q", upstream, join(clone, "work")]);

    expect(await resolveDefaultBranch(join(clone, "work"))).toBe("release");
  });

  test("falls back to main first when origin/HEAD is absent", async () => {
    // `clone --bare` creates no remote-tracking refs at all, so origin/HEAD genuinely does
    // not exist in the layout wrk actually uses — this is the common path, not the edge.
    const upstream = makeRepo("main");
    makeBranch(upstream, "master");
    makeBranch(upstream, "trunk");

    expect(await resolveDefaultBranch(makeContainer(upstream))).toBe("main");
  });

  test("falls back to master before trunk", async () => {
    const upstream = makeRepo("master");
    makeBranch(upstream, "trunk");

    expect(await resolveDefaultBranch(makeContainer(upstream))).toBe("master");
  });

  test("falls back to trunk when it is the only conventional name", async () => {
    expect(await resolveDefaultBranch(makeContainer(makeRepo("trunk")))).toBe("trunk");
  });

  test("falls back to the current branch when no conventional name exists", async () => {
    expect(await resolveDefaultBranch(makeRepo("develop"))).toBe("develop");
  });

  test("returns null on a detached HEAD with no conventional branch to fall back to", async () => {
    const repo = makeRepo("develop");
    const detached = join(tempDir(), "detached");
    fixtureGit(["worktree", "add", "-q", "--detach", detached], repo);

    expect(await resolveDefaultBranch(detached)).toBeNull();
  });

  test("returns null outside a repository", async () => {
    expect(await resolveDefaultBranch(notARepo)).toBeNull();
  });
});

describe("checkoutFor", () => {
  test("returns the checkout root when cwd already sits in a work tree", async () => {
    expect(await checkoutFor(checkout)).toBe(checkout);
  });

  test("returns the checkout root, not cwd, from a nested subdirectory", async () => {
    const nested = join(checkout, "c", "d");
    mkdirSync(nested, { recursive: true });

    expect(await checkoutFor(nested)).toBe(checkout);
  });

  test("finds the default-branch checkout from the container", async () => {
    expect(await checkoutFor(container)).toBe(checkout);
  });

  test("finds it by the branch it holds, not by its directory name", async () => {
    // The criterion's whole point: the hand-run conversion recipe leaves the directory name
    // to whoever runs it, so a name-based implementation resolves the wrong checkout — or
    // none. The decoy sorts first and is named exactly what a name-based lookup would want.
    const own = makeContainer(seed);
    addNewCheckout(own, "main", "some-other-branch");
    const real = addCheckout(own, "zzz-nothing-like-the-branch", "main");

    expect(await checkoutFor(own)).toBe(real);
  });

  test("returns null when no worktree holds the default branch", async () => {
    const own = makeContainer(seed);
    addNewCheckout(own, "side", "some-other-branch");

    expect(await checkoutFor(own)).toBeNull();
  });

  test("returns null from a container with no checkouts at all", async () => {
    expect(await checkoutFor(makeContainer(seed))).toBeNull();
  });

  test("returns null outside a repository", async () => {
    // Distinct code path from the two above: `listWorktrees` throws outside a repository, so
    // this pins that the "not a repository" case is settled before it is ever called.
    expect(await checkoutFor(notARepo)).toBeNull();
  });
});

describe("locate", () => {
  test("reports a checkout with its root and its container", async () => {
    expect(await locate(checkout)).toEqual({ kind: "checkout", root: checkout, container });
  });

  test("reports the checkout root from a nested subdirectory", async () => {
    const nested = join(checkout, "e", "f");
    mkdirSync(nested, { recursive: true });

    expect(await locate(nested)).toEqual({ kind: "checkout", root: checkout, container });
  });

  test("reports the container, which has no work tree", async () => {
    // The middle state, and the reason the check is three-way rather than two-way: the
    // container answers no toplevel but a perfectly good common dir.
    expect(await locate(container)).toEqual({ kind: "container", container });
  });

  test("reports outside for a directory in no repository", async () => {
    expect(await locate(notARepo)).toEqual({ kind: "outside" });
  });

  test("reports a plain repository as a checkout of its own container", async () => {
    // Nothing here is bare-layout-specific: an unconverted clone is still a checkout, and its
    // "container" is simply the directory holding its `.git`. `isBareLayout` is the predicate
    // that tells the two apart; `locate` does not conflate them.
    expect(await locate(seed)).toEqual({ kind: "checkout", root: seed, container: seed });
  });
});
