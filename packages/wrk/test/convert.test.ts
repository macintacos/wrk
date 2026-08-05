/**
 * Contract of the printed bare-repo conversion recipe.
 *
 * Two halves, tested differently on purpose. {@link resolveConversion} reads a real
 * repository, so its cases drive the real `git` binary against repositories built in temp
 * directories — the same discipline `repo.test.ts` uses, and for the same reason: container
 * resolution is precisely the code that passes against a mock and fails against a real
 * layout. {@link renderConversion} takes a plain value and returns a string, so its cases
 * need no repository at all and assert the recipe's exact text.
 *
 * Fixtures are built with `execFileSync` rather than with this module's own wrappers, so a
 * broken wrapper cannot quietly build the repository that then proves it correct.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Conversion, renderConversion, resolveConversion } from "../src/convert";

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
function fixtureGit(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, env: FIXTURE_ENV, encoding: "utf8" });
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
function tempDir(prefix = "wrk-convert-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

/** A plain, non-bare repository on `branch` with exactly one commit, and no remote. */
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

/** A clone of `upstream` at `<fresh temp dir>/<name>`, carrying `origin`. */
function makeClone(upstream: string, name = "work"): string {
  const path = join(tempDir(), name);
  fixtureGit(["clone", "-q", upstream, path]);
  return path;
}

let upstream: string;
let clone: string;
let notARepo: string;

beforeAll(() => {
  upstream = makeRepo("main");
  clone = makeClone(upstream);
  notARepo = tempDir();
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A fully resolved conversion, for the rendering cases that need no repository. */
const RESOLVED: Conversion = {
  container: "/Users/t/GitLocal/my-project",
  remoteUrl: "git@github.com:t/my-project.git",
  defaultBranch: "trunk",
};

describe("resolveConversion", () => {
  test("answers the container, origin's URL and the default branch of a clone", async () => {
    expect(await resolveConversion(clone)).toEqual({
      container: clone,
      remoteUrl: upstream,
      defaultBranch: "main",
    });
  });

  test("answers the same container from a nested subdirectory", async () => {
    // The container is the repository's identity, so it must not shift with cwd. Under an
    // unconverted repository it is simply the directory holding `.git` — which is what the
    // recipe renames, so reading it off cwd would rename a subdirectory instead.
    const nested = join(clone, "a", "b");
    mkdirSync(nested, { recursive: true });

    expect((await resolveConversion(nested))?.container).toBe(clone);
  });

  test("returns null outside a repository", async () => {
    expect(await resolveConversion(notARepo)).toBeNull();
  });

  test("answers a null remote URL for a repository with no origin", async () => {
    // `git init` leaves no remote, and a repository worth converting need not have one.
    // Failing here would refuse a recipe that is otherwise entirely printable.
    expect((await resolveConversion(upstream))?.remoteUrl).toBeNull();
  });

  test("answers a null default branch on a detached HEAD with no conventional name", async () => {
    const repo = makeRepo("develop");
    const detached = join(tempDir(), "detached");
    fixtureGit(["worktree", "add", "-q", "--detach", detached], repo);

    expect((await resolveConversion(detached))?.defaultBranch).toBeNull();
  });

  test("leaves the repository byte-identical", async () => {
    // The issue's second acceptance criterion, and the whole reason this command prints:
    // resolving reads, and only reads. Recorded before and after a full resolve-and-render.
    const own = makeClone(upstream, "untouched");
    const before = {
      head: fixtureGit(["rev-parse", "HEAD"], own),
      status: fixtureGit(["status", "--porcelain"], own),
      refs: fixtureGit(["for-each-ref"], own),
      worktrees: fixtureGit(["worktree", "list", "--porcelain"], own),
      config: fixtureGit(["config", "--local", "--list"], own),
    };

    const conversion = await resolveConversion(own);
    expect(conversion).not.toBeNull();
    if (conversion !== null) renderConversion(conversion);

    expect({
      head: fixtureGit(["rev-parse", "HEAD"], own),
      status: fixtureGit(["status", "--porcelain"], own),
      refs: fixtureGit(["for-each-ref"], own),
      worktrees: fixtureGit(["worktree", "list", "--porcelain"], own),
      config: fixtureGit(["config", "--local", "--list"], own),
    }).toEqual(before);
    expect(before.status).toBe("");
  });
});

describe("renderConversion", () => {
  test("substitutes the container's parent, its name, the remote URL and the branch", () => {
    const recipe = renderConversion(RESOLVED);

    expect(recipe).toContain("cd /Users/t/GitLocal\n");
    expect(recipe).toContain("mv my-project my-project.old\n");
    expect(recipe).toContain("mkdir my-project\n");
    expect(recipe).toContain("git clone --bare ../my-project.old .bare\n");
    expect(recipe).toContain(
      "git --git-dir=.bare remote set-url origin git@github.com:t/my-project.git\n",
    );
    expect(recipe).toContain("git worktree add trunk trunk\n");
    expect(recipe).toContain("git -C trunk branch --set-upstream-to=origin/trunk trunk\n");
  });

  test("leaves no placeholder behind when every value resolved", () => {
    // The issue asks for the values "filled in". A stray `<default-branch>` would read as a
    // recipe the caller still has to edit, which is exactly what this command removes.
    expect(renderConversion(RESOLVED)).not.toMatch(/<[a-z-]+>/);
  });

  test("falls back to a placeholder for a value that did not resolve", () => {
    const recipe = renderConversion({ ...RESOLVED, remoteUrl: null, defaultBranch: null });

    expect(recipe).toContain("git --git-dir=.bare remote set-url origin '<remote-url>'");
    expect(recipe).toContain("git worktree add '<default-branch>' '<default-branch>'");
  });

  test("quotes a container path containing a space, everywhere it appears", () => {
    // Unquoted, `mv my project my project.old` renames something else entirely — and the
    // caller pastes this straight into a shell.
    const recipe = renderConversion({ ...RESOLVED, container: "/Users/t/Git Local/my project" });

    expect(recipe).toContain("cd '/Users/t/Git Local'\n");
    expect(recipe).toContain("mv 'my project' 'my project.old'\n");
    expect(recipe).toContain("git clone --bare '../my project.old' .bare\n");
  });

  test("leaves an ordinary path unquoted", () => {
    expect(renderConversion(RESOLVED)).toContain("cd /Users/t/GitLocal\n");
  });

  test("quotes a remote URL carrying a shell metacharacter", () => {
    const recipe = renderConversion({ ...RESOLVED, remoteUrl: "ssh://host/a'b.git" });

    expect(recipe).toContain(`remote set-url origin 'ssh://host/a'\\''b.git'`);
  });

  test("carries all six verification checks", () => {
    const recipe = renderConversion(RESOLVED);

    for (const check of [
      "git -C trunk config core.bare",
      "ls -l .git",
      "git -C trunk rev-parse --git-common-dir",
      "git -C trunk rev-parse --abbrev-ref '@{upstream}'",
      "git -C trunk branch --list",
      "git -C trunk status",
    ]) {
      expect(recipe).toContain(check);
    }
  });

  test("warns about the three kinds of work a re-clone does not carry across", () => {
    const recipe = renderConversion(RESOLVED);

    expect(recipe).toContain("Uncommitted work");
    expect(recipe).toContain("Untracked files");
    expect(recipe).toContain("refs/stash is not copied by any clone");
  });

  test("is safe to paste whole: every line is a comment, a command, or blank", () => {
    // The property that lets the output be read top to bottom in a terminal. A bare prose
    // line would try to execute — and the paragraphs here talk about `rm` and `mv`.
    const commands = ["cd ", "mv ", "mkdir ", "printf ", "ls ", "git "];

    for (const line of renderConversion(RESOLVED).split("\n")) {
      if (line === "") continue;
      expect(line.startsWith("#") || commands.some((prefix) => line.startsWith(prefix))).toBe(true);
    }
  });

  test("ends with exactly one newline, so printing it adds no blank line", () => {
    expect(renderConversion(RESOLVED)).toMatch(/[^\n]\n$/);
  });
});
