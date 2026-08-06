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
  gitOk,
  isInsideWorkTree,
  listWorktrees,
  parseWorktree,
  pruneWorktrees,
  refExists,
  removeWorktree,
  showToplevel,
  statusPorcelain,
  symbolicRef,
} from "../src/git";
import { CommandFailed } from "../src/output";

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
 * repository and leaves `<dir>` empty, so every fixture collapses. It is the same trap
 * `git.ts` exists to close, arriving from the other side.
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wrk-git-")));
  roots.push(dir);
  return dir;
}

/** Identity for fixture commits, so the suite does not depend on the machine's git config. */
const IDENTITY = ["-c", "user.email=t@example.com", "-c", "user.name=T"];

/** A repository on branch `main` with exactly one commit. */
function makeRepo(): string {
  const dir = tempDir();
  fixtureGit(["init", "-q", "-b", "main", dir]);
  fixtureGit([...IDENTITY, "commit", "-q", "--allow-empty", "-m", "init"], dir);
  return dir;
}

/**
 * A bare-repo container in the layout `wrk` itself uses: a `.bare` repository, a `.git`
 * file pointing at it, and each checkout a sibling directory named after its branch.
 *
 * Reproduced rather than approximated, because it is the shape every wrapper here has to
 * survive — and the only one whose `worktree list --porcelain` output contains a `bare`
 * record at all, which is the entry the parser must drop.
 */
function makeContainer(): string {
  const dir = tempDir();
  fixtureGit(["clone", "-q", "--bare", makeRepo(), join(dir, ".bare")]);
  writeFileSync(join(dir, ".git"), "gitdir: ./.bare\n");
  fixtureGit(["worktree", "add", "-q", join(dir, "main"), "main"], dir);
  return dir;
}

let repo: string;
let container: string;
let notARepo: string;

beforeAll(() => {
  repo = makeRepo();
  container = makeContainer();
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
    // from inside git hooks and aliases, which is exactly where git exports them.
    const other = makeRepo();
    process.env.GIT_DIR = join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    try {
      const { stdout } = await git(
        ["rev-parse", "--path-format=absolute", "--show-toplevel"],
        repo,
      );

      expect(stdout.trim()).toBe(repo);
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
    }
  });

  test("sheds the GIT_INDEX_FILE git exports to every hook", async () => {
    // The variable that makes an incomplete scrub dangerous rather than merely incomplete:
    // it is set in every hook's environment, it survives a GIT_DIR-only scrub, and it makes
    // a clean checkout report as dirty — a wrong answer rather than a failure.
    const probe = makeRepo();
    const side = join(tempDir(), "side");
    fixtureGit(["worktree", "add", "-q", side, "-b", "side"], probe);
    writeFileSync(join(side, "staged.txt"), "x");
    fixtureGit(["add", "staged.txt"], side);

    process.env.GIT_INDEX_FILE = join(probe, ".git", "worktrees", "side", "index");
    try {
      expect(await statusPorcelain(probe)).toEqual([]);
    } finally {
      delete process.env.GIT_INDEX_FILE;
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

  test("returns null in the container, which has no work tree", async () => {
    // The container half of the three-state check EXC-993 builds on: no work tree here,
    // but `gitCommonDir` below still answers, and that pair is what distinguishes the
    // container from somewhere outside the repository entirely.
    expect(await showToplevel(container)).toBeNull();
    expect(await gitCommonDir(container)).toBe(join(container, ".bare"));
  });
});

describe("gitCommonDir", () => {
  test("returns the shared git dir, not the linked worktree's own gitdir", async () => {
    // The distinction the whole repo model hangs off: a linked worktree's `--git-dir` is
    // `<main>/.git/worktrees/<name>`, private to it, while `--git-common-dir` is the
    // repository's shared directory and so resolves identically from every checkout.
    const checkout = join(container, "main");

    expect(await gitCommonDir(checkout)).toBe(join(container, ".bare"));
    expect(await gitCommonDir(checkout)).toBe(await gitCommonDir(container));
  });

  test("returns null outside a repository", async () => {
    expect(await gitCommonDir(notARepo)).toBeNull();
  });
});

describe("isInsideWorkTree", () => {
  test("is true inside a checkout and false in the container", async () => {
    expect(await isInsideWorkTree(join(container, "main"))).toBe(true);
    expect(await isInsideWorkTree(container)).toBe(false);
  });

  test("is false outside a repository", async () => {
    // Git exits 128 here rather than printing `false`, so this is a distinct code path
    // from the container case above, not a restatement of it.
    expect(await isInsideWorkTree(notARepo)).toBe(false);
  });
});

describe("currentBranch", () => {
  test("returns the checked-out branch", async () => {
    expect(await currentBranch(repo)).toBe("main");
  });

  test("is not confused by a tag that shadows the branch name", async () => {
    // `rev-parse --abbrev-ref HEAD` shortens ambiguously and answers `heads/main` here,
    // which is not a name any caller can use and does not match the fully qualified refs
    // `listWorktrees` reports.
    const shadowed = makeRepo();
    fixtureGit(["tag", "main", "HEAD"], shadowed);

    expect(await currentBranch(shadowed)).toBe("main");
  });

  test("returns the branch a first commit would land on in an empty repository", async () => {
    const unborn = tempDir();
    fixtureGit(["init", "-q", "-b", "main", unborn]);

    expect(await currentBranch(unborn)).toBe("main");
  });

  test("returns null on a detached HEAD", async () => {
    const detached = join(tempDir(), "detached");
    fixtureGit(["worktree", "add", "-q", "--detach", detached], repo);

    expect(await currentBranch(detached)).toBeNull();
  });

  test("returns null outside a repository", async () => {
    expect(await currentBranch(notARepo)).toBeNull();
  });
});

describe("forEachRef", () => {
  test("lists matching refs", async () => {
    expect(await forEachRef(["refs/heads/main"], repo)).toEqual(["refs/heads/main"]);
  });

  test("applies a custom format", async () => {
    expect(await forEachRef(["refs/heads/main"], repo, "%(refname:short)")).toEqual(["main"]);
  });

  test("returns an empty array when nothing matches", async () => {
    // Git exits 0 with empty stdout, and `"".split("\n")` is `[""]` rather than `[]` — so
    // this pins the filtering, not git.
    expect(await forEachRef(["refs/heads/no-such-prefix"], repo)).toEqual([]);
  });
});

describe("statusPorcelain", () => {
  test("is empty for a clean tree and lists entries for a dirty one", async () => {
    const dirty = makeRepo();
    expect(await statusPorcelain(dirty)).toEqual([]);

    writeFileSync(join(dirty, "untracked.txt"), "x");

    expect(await statusPorcelain(dirty)).toEqual(["?? untracked.txt"]);
  });

  test("omits untracked files under { untracked: false } while still reporting tracked ones", async () => {
    // The distinction `preflight`'s dirty check is built on: scratch files and build output
    // block neither a `switch` nor a fast-forward `pull`, so they are not "dirty". Filtering
    // `??` at a call site would pass this too — passing the flag is what keeps porcelain-format
    // knowledge inside this module.
    const dirty = makeRepo();
    writeFileSync(join(dirty, "tracked.txt"), "before");
    fixtureGit(["add", "tracked.txt"], dirty);
    fixtureGit([...IDENTITY, "commit", "-q", "-m", "add"], dirty);

    writeFileSync(join(dirty, "untracked.txt"), "x");
    expect(await statusPorcelain(dirty, { untracked: false })).toEqual([]);

    writeFileSync(join(dirty, "tracked.txt"), "after");
    expect(await statusPorcelain(dirty, { untracked: false })).toEqual([" M tracked.txt"]);
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

describe("the throwing half of the contract", () => {
  test("a query with no honest empty answer throws instead of returning one", async () => {
    // Without this, swapping `gitOk` back to `git` in any of the three would return `[]`
    // for "not a repository" and pass the entire rest of the suite.
    await expect(listWorktrees(notARepo)).rejects.toThrow(/worktree list/);
    await expect(statusPorcelain(notARepo)).rejects.toThrow(/status/);
    await expect(forEachRef(["refs/heads"], notARepo)).rejects.toThrow(/for-each-ref/);
  });

  test("gitOk is exported for a one-off command, and throws the same way", async () => {
    // The escape hatch's throwing twin. `preflight` needs `fetch`, `switch` and `pull` to
    // fail loudly, and this module's own rule is that one caller does not earn a wrapper —
    // so the helper every throwing wrapper here already routes through is the one it uses.
    expect((await gitOk(["rev-parse", "--abbrev-ref", "HEAD"], repo)).trim()).toBe("main");

    const failure: unknown = await gitOk(["rev-parse", "--git-dir"], notARepo).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CommandFailed);
    expect((failure as CommandFailed).code).toBe(128);
  });

  test("what it throws carries git's own exit status", async () => {
    // The half a message cannot express: `wrk` exits with the status of the command that
    // failed underneath it, so the code has to survive as a value rather than as prose in
    // an Error's text. 128 is git's "not a repository".
    const failure: unknown = await listWorktrees(notARepo).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CommandFailed);
    expect((failure as CommandFailed).code).toBe(128);
  });
});

describe("parseWorktree", () => {
  // Driven with hand-built bytes rather than through `listWorktrees`, because the records
  // that matter here are ones real git does not emit — which is the whole reason the parser
  // has to decide what to do with them. Everything git *does* emit is covered by the
  // `listWorktrees` cases below, against a real repository.
  const record = (...attributes: string[]): string => attributes.join("\0");

  test("rejects a record with no worktree attribute", () => {
    // `removeWorktree` deletes the directory it is handed, so an entry with no path must
    // not be constructible — a caller iterating the list would delete the process cwd.
    expect(() => parseWorktree(record("HEAD 0123456789abcdef", "branch refs/heads/x"))).toThrow(
      /unreadable record/,
    );
  });

  test("rejects a record whose worktree attribute carries no path", () => {
    expect(() => parseWorktree(record("worktree", "branch refs/heads/x"))).toThrow(
      /unreadable record/,
    );
  });

  test("carries the offending record in the message rather than a schema dump", () => {
    // Git's stderr says nothing about a record git printed successfully, so the record is
    // the only thing that locates the failure.
    expect(() => parseWorktree(record("branch refs/heads/x"))).toThrow(/branch refs\/heads\/x/);
  });

  test("answers null for the bare entry", () => {
    expect(parseWorktree(record("worktree /repo/.bare", "bare"))).toBeNull();
  });

  test("drops attributes it does not model", () => {
    // `locked` and `detached` are real attributes this module has no field for. They must
    // be ignored rather than rejected, or a locked worktree takes the whole list down.
    expect(parseWorktree(record("worktree /repo/wt", "detached", "locked being moved"))).toEqual({
      path: "/repo/wt",
      head: null,
      branch: null,
      prunable: null,
    });
  });
});

describe("listWorktrees", () => {
  test("captures prunable on the same record as the branch it belongs to", async () => {
    // The trap the issue names, and the reason records are parsed whole. Git emits
    // `prunable` *after* `branch`, so a parser that emits a worktree the moment it sees a
    // branch line never sees the reason — and a stale worktree reads as live, which is how
    // `wrk` ends up handing a dead path to something that acts on it.
    const own = makeContainer();
    const gone = join(own, "gone");
    fixtureGit(["worktree", "add", "-q", gone, "-b", "gone"], own);
    rmSync(gone, { recursive: true, force: true });

    const entry = (await listWorktrees(own)).find((wt) => wt.path === gone);

    expect(entry?.branch).toBe("refs/heads/gone");
    expect(entry?.prunable).not.toBeNull();
  });

  test("keeps a record whose path contains a newline in one piece", async () => {
    // The whole reason for `-z`. Under plain `--porcelain` this record splits in two and
    // the tail reads as a worktree at "break" — a path `removeWorktree` would then act on.
    const own = makeContainer();
    const awkward = join(own, "line\nbreak");
    fixtureGit(["worktree", "add", "-q", awkward, "-b", "awkward"], own);

    const entry = (await listWorktrees(own)).find((wt) => wt.path === awkward);

    expect(entry?.branch).toBe("refs/heads/awkward");
  });

  test("skips the bare entry and keeps the real checkouts", async () => {
    const paths = (await listWorktrees(container)).map((wt) => wt.path);

    expect(paths).not.toContain(join(container, ".bare"));
    expect(paths).toEqual([join(container, "main")]);
  });

  test("reports path, head and branch for a live worktree", async () => {
    const [entry] = await listWorktrees(container);

    expect(entry?.path).toBe(join(container, "main"));
    expect(entry?.branch).toBe("refs/heads/main");
    expect(entry?.head).toMatch(/^[0-9a-f]{40}$/);
    expect(entry?.prunable).toBeNull();
  });

  test("reports a null head on a branch with no commit yet", async () => {
    // Git writes the all-zeros object id here, which is not a commit-ish a caller can hand
    // back to it — so the field would otherwise carry a value that looks usable and is not.
    const unborn = tempDir();
    fixtureGit(["init", "-q", "-b", "main", unborn]);

    const [entry] = await listWorktrees(unborn);

    expect(entry?.head).toBeNull();
    expect(entry?.branch).toBe("refs/heads/main");
  });

  test("reports a detached worktree with a null branch", async () => {
    const own = makeContainer();
    const detached = join(own, "detached");
    fixtureGit(["worktree", "add", "-q", "--detach", detached], own);

    const entry = (await listWorktrees(own)).find((wt) => wt.path === detached);

    expect(entry).toBeDefined();
    expect(entry?.branch).toBeNull();
  });
});

describe("addWorktree", () => {
  test("creates a worktree holding a new branch", async () => {
    const own = makeContainer();
    const added = join(own, "feature");

    await addWorktree(added, own, { branch: "feature" });

    const entry = (await listWorktrees(own)).find((wt) => wt.path === added);
    expect(entry?.branch).toBe("refs/heads/feature");
  });

  test("starts the new branch at the given start point", async () => {
    const own = makeContainer();
    const added = join(own, "from-main");

    await addWorktree(added, own, { branch: "from-main", startPoint: "main" });

    const list = await listWorktrees(own);
    expect(list.find((wt) => wt.path === added)?.head).toBe(
      list.find((wt) => wt.path === join(own, "main"))?.head,
    );
  });

  test("rejects with git's own message when git refuses", async () => {
    const own = makeContainer();

    // The main checkout already exists, so git declines — and the caller needs to be told
    // why, not handed a silent no-op.
    await expect(addWorktree(join(own, "main"), own, { branch: "dup" })).rejects.toThrow(
      /git worktree add/,
    );
  });
});

describe("removeWorktree", () => {
  test("removes a clean worktree", async () => {
    const own = makeContainer();
    const added = join(own, "throwaway");
    await addWorktree(added, own, { branch: "throwaway" });

    await removeWorktree(added, own);

    expect((await listWorktrees(own)).map((wt) => wt.path)).not.toContain(added);
  });

  test("refuses a dirty worktree unless forced", async () => {
    const own = makeContainer();
    const added = join(own, "dirty");
    await addWorktree(added, own, { branch: "dirty" });
    writeFileSync(join(added, "untracked.txt"), "x");

    await expect(removeWorktree(added, own)).rejects.toThrow();

    await removeWorktree(added, own, { force: true });

    expect((await listWorktrees(own)).map((wt) => wt.path)).not.toContain(added);
  });
});

describe("pruneWorktrees", () => {
  test("drops the administrative entry for a worktree whose directory is gone", async () => {
    const own = makeContainer();
    const gone = join(own, "gone");
    await addWorktree(gone, own, { branch: "gone" });
    rmSync(gone, { recursive: true, force: true });

    await pruneWorktrees(own);

    expect((await listWorktrees(own)).map((wt) => wt.path)).not.toContain(gone);
  });
});
