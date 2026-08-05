/**
 * Contract of the git plumbing wrappers.
 *
 * Every case drives the real `git` binary against a real repository built in a temp
 * directory, because what is under test *is* git's behaviour — which exit code means "no",
 * which line of a porcelain record arrives when. A fake git would encode this module's
 * assumptions rather than check them, so the traps the issue names could not fail here.
 *
 * Fixtures are built with `execFileSync` rather than with this module's own wrappers, so a
 * broken wrapper cannot quietly build the repository that then proves it correct.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addWorktree,
  currentBranch,
  forEachRef,
  git,
  gitCommonDir,
  isInsideWorkTree,
  listWorktrees,
  pruneWorktrees,
  refExists,
  removeWorktree,
  showToplevel,
  statusPorcelain,
  symbolicRef,
} from "../src/git";

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wrk-git-")));
  roots.push(dir);
  return dir;
}

/** A repository on branch `main` with exactly one commit. */
function makeRepo(): string {
  const dir = tempDir();
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync(
    "git",
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
    { cwd: dir },
  );
  return dir;
}

/** A repository with no work tree, standing in for the bare-repo container's `.bare`. */
function makeBare(): string {
  const dir = tempDir();
  execFileSync("git", ["init", "-q", "--bare", dir]);
  return dir;
}

/**
 * A bare-repo container in the layout `wrk` itself uses: a `.bare` repository, a `.git`
 * file pointing at it, and each checkout a sibling directory.
 *
 * Reproduced rather than approximated because it is the only layout whose
 * `worktree list --porcelain` output contains a `bare` record at all — the entry the parser
 * has to drop, and one a plain repository never produces.
 */
function makeContainer(): string {
  const dir = tempDir();
  execFileSync("git", ["clone", "-q", "--bare", makeRepo(), join(dir, ".bare")]);
  writeFileSync(join(dir, ".git"), "gitdir: ./.bare\n");
  execFileSync("git", ["worktree", "add", "-q", join(dir, "main"), "main"], { cwd: dir });
  return dir;
}

let repo: string;
let bare: string;
let notARepo: string;

beforeAll(() => {
  repo = makeRepo();
  bare = makeBare();
  notARepo = tempDir();
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("git", () => {
  test("honours cwd even when GIT_DIR points somewhere else entirely", async () => {
    // The reason this module has a runner at all. `GIT_DIR` in the inherited environment
    // silently overrides `cwd`, so without the scrub every wrapper here would answer for
    // whatever repository the parent process happened to be pointed at — and `wrk` is run
    // from inside git hooks and `git` subcommands, which is exactly where GIT_DIR is set.
    const other = makeRepo();
    process.env.GIT_DIR = join(other, ".git");
    try {
      const { stdout } = await git(
        ["rev-parse", "--path-format=absolute", "--show-toplevel"],
        repo,
      );

      expect(stdout.trim()).toBe(repo);
    } finally {
      delete process.env.GIT_DIR;
    }
  });

  test("resolves with git's exit code rather than throwing", async () => {
    const result = await git(["rev-parse", "--verify", "refs/heads/no-such-ref"], repo);

    expect(result.code).not.toBe(0);
  });
});

describe("showToplevel", () => {
  test("returns the absolute work-tree root", async () => {
    expect(await showToplevel(repo)).toBe(repo);
  });

  test("returns null where there is no work tree", async () => {
    // The container half of the three-state check EXC-993 builds on: no work tree here,
    // but `gitCommonDir` below still answers, and that pair is what distinguishes the
    // container from somewhere outside the repository entirely.
    expect(await showToplevel(bare)).toBeNull();
  });
});

describe("gitCommonDir", () => {
  test("returns the shared git dir, not the linked worktree's own gitdir", async () => {
    // The distinction the whole repo model hangs off: a linked worktree's `--git-dir` is
    // `<main>/.git/worktrees/<name>`, private to it, while `--git-common-dir` is the
    // repository's shared directory and so resolves identically from every checkout.
    const linked = join(tempDir(), "linked");
    execFileSync("git", ["worktree", "add", "-q", linked, "-b", "linked"], { cwd: repo });

    expect(await gitCommonDir(linked)).toBe(join(repo, ".git"));
    expect(await gitCommonDir(linked)).toBe(await gitCommonDir(repo));
  });

  test("returns null outside a repository", async () => {
    expect(await gitCommonDir(notARepo)).toBeNull();
  });
});

describe("isInsideWorkTree", () => {
  test("is true inside a checkout and false without a work tree", async () => {
    expect(await isInsideWorkTree(repo)).toBe(true);
    expect(await isInsideWorkTree(bare)).toBe(false);
  });

  test("is false outside a repository", async () => {
    // Git exits 128 here rather than printing `false`, so this is a distinct code path
    // from the bare case above, not a restatement of it.
    expect(await isInsideWorkTree(notARepo)).toBe(false);
  });
});

describe("currentBranch", () => {
  test("returns the checked-out branch", async () => {
    expect(await currentBranch(repo)).toBe("main");
  });

  test("returns null on a detached HEAD", async () => {
    // `rev-parse --abbrev-ref HEAD` answers with the literal string "HEAD" when detached,
    // which a caller would otherwise store and later look up as a branch name.
    const detached = join(tempDir(), "detached");
    execFileSync("git", ["worktree", "add", "-q", "--detach", detached], { cwd: repo });

    expect(await currentBranch(detached)).toBeNull();
  });

  test("returns null outside a repository", async () => {
    expect(await currentBranch(notARepo)).toBeNull();
  });
});

describe("forEachRef", () => {
  test("lists matching refs", async () => {
    expect(await forEachRef(["refs/heads/main"], undefined, repo)).toEqual(["refs/heads/main"]);
  });

  test("applies a custom format", async () => {
    expect(await forEachRef(["refs/heads/main"], "%(refname:short)", repo)).toEqual(["main"]);
  });

  test("returns an empty array when nothing matches", async () => {
    // Git exits 0 with empty stdout, and `"".split("\n")` is `[""]` rather than `[]` — so
    // this pins the filtering, not git.
    expect(await forEachRef(["refs/heads/no-such-prefix"], undefined, repo)).toEqual([]);
  });
});

describe("statusPorcelain", () => {
  test("is empty for a clean tree and lists entries for a dirty one", async () => {
    const dirty = makeRepo();
    expect(await statusPorcelain(dirty)).toEqual([]);

    writeFileSync(join(dirty, "untracked.txt"), "x");

    expect(await statusPorcelain(dirty)).toEqual(["?? untracked.txt"]);
  });
});

describe("symbolicRef", () => {
  test("resolves a symbolic ref to its target", async () => {
    expect(await symbolicRef("HEAD", repo)).toBe("refs/heads/main");
  });

  test("returns null for a ref that exists but is not symbolic", async () => {
    expect(await symbolicRef("refs/heads/main", repo)).toBeNull();
  });
});

describe("refExists", () => {
  test("distinguishes a ref that exists from one that does not", async () => {
    expect(await refExists("refs/heads/main", repo)).toBe(true);
    expect(await refExists("refs/heads/no-such-ref", repo)).toBe(false);
  });
});

describe("listWorktrees", () => {
  test("captures prunable on the same record as the branch it belongs to", async () => {
    // The trap the issue names, and the reason records are parsed whole. Git emits
    // `prunable` *after* `branch`, so a parser that emits a worktree the moment it sees a
    // branch line never sees the reason — and a stale worktree reads as live, which is how
    // `wrk` ends up handing a dead path to something that acts on it.
    const container = makeContainer();
    const gone = join(container, "gone");
    execFileSync("git", ["worktree", "add", "-q", gone, "-b", "gone"], { cwd: container });
    rmSync(gone, { recursive: true, force: true });

    const entry = (await listWorktrees(container)).find((wt) => wt.path === gone);

    expect(entry?.branch).toBe("refs/heads/gone");
    expect(entry?.prunable).not.toBeNull();
  });

  test("skips the bare entry and keeps the real checkouts", async () => {
    const container = makeContainer();

    const paths = (await listWorktrees(container)).map((wt) => wt.path);

    expect(paths).not.toContain(join(container, ".bare"));
    expect(paths).toEqual([join(container, "main")]);
  });

  test("reports path, head and branch for a live worktree", async () => {
    const container = makeContainer();

    const [entry] = await listWorktrees(container);

    expect(entry?.path).toBe(join(container, "main"));
    expect(entry?.branch).toBe("refs/heads/main");
    expect(entry?.head).toMatch(/^[0-9a-f]{40}$/);
    expect(entry?.prunable).toBeNull();
  });

  test("reports a detached worktree with a null branch", async () => {
    const container = makeContainer();
    const detached = join(container, "detached");
    execFileSync("git", ["worktree", "add", "-q", "--detach", detached], { cwd: container });

    const entry = (await listWorktrees(container)).find((wt) => wt.path === detached);

    expect(entry).toBeDefined();
    expect(entry?.branch).toBeNull();
  });
});

describe("addWorktree", () => {
  test("creates a worktree holding a new branch", async () => {
    const container = makeContainer();
    const added = join(container, "feature");

    await addWorktree(added, { branch: "feature" }, container);

    const entry = (await listWorktrees(container)).find((wt) => wt.path === added);
    expect(entry?.branch).toBe("refs/heads/feature");
  });

  test("starts the new branch at the given start point", async () => {
    const container = makeContainer();
    const added = join(container, "from-main");

    await addWorktree(added, { branch: "from-main", startPoint: "main" }, container);

    const list = await listWorktrees(container);
    expect(list.find((wt) => wt.path === added)?.head).toBe(
      list.find((wt) => wt.path === join(container, "main"))?.head,
    );
  });

  test("rejects with git's own message when git refuses", async () => {
    const container = makeContainer();

    // The main checkout already exists, so git declines — and the caller needs to be told
    // why, not handed a silent no-op.
    await expect(
      addWorktree(join(container, "main"), { branch: "dup" }, container),
    ).rejects.toThrow(/git worktree add/);
  });
});

describe("removeWorktree", () => {
  test("removes a clean worktree", async () => {
    const container = makeContainer();
    const added = join(container, "throwaway");
    await addWorktree(added, { branch: "throwaway" }, container);

    await removeWorktree(added, undefined, container);

    expect((await listWorktrees(container)).map((wt) => wt.path)).not.toContain(added);
  });

  test("refuses a dirty worktree unless forced", async () => {
    const container = makeContainer();
    const added = join(container, "dirty");
    await addWorktree(added, { branch: "dirty" }, container);
    writeFileSync(join(added, "untracked.txt"), "x");

    await expect(removeWorktree(added, undefined, container)).rejects.toThrow();

    await removeWorktree(added, { force: true }, container);

    expect((await listWorktrees(container)).map((wt) => wt.path)).not.toContain(added);
  });
});

describe("pruneWorktrees", () => {
  test("drops the administrative entry for a worktree whose directory is gone", async () => {
    const container = makeContainer();
    const gone = join(container, "gone");
    await addWorktree(gone, { branch: "gone" }, container);
    rmSync(gone, { recursive: true, force: true });

    await pruneWorktrees(container);

    expect((await listWorktrees(container)).map((wt) => wt.path)).not.toContain(gone);
  });
});
