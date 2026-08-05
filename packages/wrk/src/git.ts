/**
 * Typed wrappers over the git plumbing the rest of `wrk` needs.
 *
 * Every wrapper is one plumbing command, named for what the caller wants rather than for
 * how git spells it, and layered on {@link run} from `./proc`. Porcelain output formats are
 * parsed here so no caller has to know which git version prints what.
 *
 * Two conventions run through the whole module.
 *
 * **A wrapper answers "no" only where git's nonzero exit encodes a specific expected
 * negative answer** — no such ref, not a symbolic ref, not in a work tree. Those return
 * `null` or `false`, inheriting {@link run}'s "a nonzero exit is a value" contract.
 * Everything else insists on success and throws with git's own stderr, because an empty
 * result would launder a real failure into a plausible-looking answer.
 *
 * **Output is fully buffered**, since {@link run} has no `maxBuffer` equivalent. That is a
 * deliberate call rather than an oversight: nothing here runs `git log` or `git diff`, so
 * the largest output any wrapper can produce is bounded by the repository's current state —
 * its refs, its worktrees, its dirty paths — at tens of bytes per line, never by the size
 * of history. Whoever adds a diff or log wrapper owns that decision separately.
 *
 * @packageDocumentation
 */

import { type RunResult, run } from "./proc";

/**
 * Runs `git` with `args` in `cwd` and resolves with what it said — the escape hatch for any
 * plumbing command this module does not wrap.
 *
 * `GIT_DIR` and `GIT_WORK_TREE` are unset for the child. Both silently override `cwd` when
 * inherited, which would make every wrapper in this module answer for whatever repository
 * the parent process was pointed at instead of the one asked for — and `wrk` is run from
 * inside git hooks and aliases, which is precisely where git exports them. Doing it here
 * rather than per wrapper means the next wrapper anyone adds cannot forget it.
 *
 * A nonzero exit resolves rather than throwing, exactly as {@link run} does.
 *
 * @param args - Arguments after `git`, one array element per argv entry.
 * @param cwd - Directory to run in. Defaults to this process's cwd.
 */
export function git(args: string[], cwd?: string): Promise<RunResult> {
  return run("git", args, { cwd, env: { GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
}

/**
 * Runs `git` and returns its stdout, throwing if it did not exit 0.
 *
 * For the commands where git has no "no" to express — listing worktrees, reading status,
 * mutating anything — so a failure surfaces as git's own message rather than as an empty
 * list the caller reads as a real answer.
 */
// ponytail: a plain Error, so an exit code cannot be branched on. Introduce a GitError
// carrying `code` if a caller ever needs to distinguish failures programmatically.
async function gitOk(args: string[], cwd?: string): Promise<string> {
  const { stdout, stderr, code } = await git(args, cwd);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`);
  }
  return stdout;
}

/**
 * Splits command output into non-empty lines.
 *
 * The filter is the point: git exits 0 with empty stdout when a query matches nothing, and
 * `"".split("\n")` is `[""]`, so an unfiltered split reports one empty result instead of
 * none.
 */
function lines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line !== "");
}

/** Runs `git rev-parse` with `args`, returning trimmed stdout, or `null` if git refused. */
function revParse(args: string[], cwd?: string): Promise<string | null> {
  return git(["rev-parse", ...args], cwd).then(({ stdout, code }) =>
    code === 0 ? stdout.trim() : null,
  );
}

/**
 * The absolute root of the work tree containing `cwd`, or `null` if there is no work tree.
 *
 * **Not an identifier for the repository.** Under `wrk`'s bare-repo container layout each
 * checkout is named after the branch it holds, so this path's basename is a *branch* name —
 * use {@link gitCommonDir} to key anything off the repository.
 *
 * `null` covers both the container (a repository with no work tree) and somewhere outside a
 * repository entirely; {@link gitCommonDir} tells those apart by answering in the first case
 * and not the second.
 */
export function showToplevel(cwd?: string): Promise<string | null> {
  return revParse(["--path-format=absolute", "--show-toplevel"], cwd);
}

/**
 * The absolute path of the repository's shared git directory, or `null` outside a repository.
 *
 * The *common* dir, not `--git-dir`: a linked worktree's own git dir is a private
 * subdirectory of it, so only this form resolves to the same path from every checkout — which
 * is what makes it the stable key for the repository.
 */
export function gitCommonDir(cwd?: string): Promise<string | null> {
  return revParse(["--path-format=absolute", "--git-common-dir"], cwd);
}

/**
 * Whether `cwd` sits inside a work tree.
 *
 * `false` for both a repository without one and a directory in no repository at all — git
 * answers the first with `false` and the second by failing, and neither is a work tree.
 */
export async function isInsideWorkTree(cwd?: string): Promise<boolean> {
  return (await revParse(["--is-inside-work-tree"], cwd)) === "true";
}

/**
 * The short name of the checked-out branch, or `null` when there is not one.
 *
 * `null` means detached HEAD, an unborn branch, or no repository. Git reports a detached
 * HEAD as the literal string `HEAD`, which a caller would otherwise store and later fail to
 * look up as a branch; that case is folded into `null` here. A branch genuinely named `HEAD`
 * is indistinguishable, which git itself warns about at creation time.
 */
export async function currentBranch(cwd?: string): Promise<string | null> {
  const branch = await revParse(["--abbrev-ref", "HEAD"], cwd);
  return branch === "HEAD" ? null : branch;
}

/**
 * Refs matching `patterns`, one entry per ref.
 *
 * @param patterns - Ref patterns, e.g. `["refs/heads"]`. Matching nothing is not an error.
 * @param format - A `for-each-ref` format string. A format containing newlines splits one
 *   ref across several entries.
 * @param cwd - Directory to run in.
 * @throws If git failed — matching no refs returns `[]` rather than failing.
 */
export async function forEachRef(
  patterns: string[],
  format = "%(refname)",
  cwd?: string,
): Promise<string[]> {
  return lines(await gitOk(["for-each-ref", `--format=${format}`, ...patterns], cwd));
}

/**
 * Porcelain status entries, one per line — empty exactly when the work tree is clean.
 *
 * Version 1 of the format, deliberately not `-z`: under `-z` a rename emits two
 * NUL-separated fields for one logical change, so splitting on the separator yields a bare
 * path masquerading as an entry. Line mode always puts one entry on one line, at the cost of
 * C-quoting paths containing unusual characters.
 *
 * @throws If git failed.
 */
export async function statusPorcelain(cwd?: string): Promise<string[]> {
  return lines(await gitOk(["status", "--porcelain"], cwd));
}

/**
 * What `name` points at, or `null` if it is not a symbolic ref.
 *
 * The way to read `refs/remotes/origin/HEAD` — the remote's default branch — without
 * parsing it out of `git remote show`, which talks to the network.
 *
 * @param name - A full ref name, e.g. `HEAD` or `refs/remotes/origin/HEAD`.
 */
export async function symbolicRef(name: string, cwd?: string): Promise<string | null> {
  const { stdout, code } = await git(["symbolic-ref", "--quiet", name], cwd);
  return code === 0 ? stdout.trim() : null;
}

/**
 * Whether `ref` exists.
 *
 * @param ref - A **fully qualified** ref, e.g. `refs/heads/main`. `--verify` does not apply
 *   git's usual short-name DWIM, so a bare `main` reports `false` rather than an error.
 */
export async function refExists(ref: string, cwd?: string): Promise<boolean> {
  return (await git(["show-ref", "--verify", "--quiet", ref], cwd)).code === 0;
}

/** One entry from {@link listWorktrees}. The repository's bare entry is not one of these. */
export interface Worktree {
  /** Absolute path of the worktree's directory. */
  path: string;

  /** Commit the worktree has checked out, or `null` on an unborn branch. */
  head: string | null;

  /**
   * Fully qualified branch ref, or `null` when the worktree is detached.
   *
   * There is no separate `detached` flag because this is it: bare entries are dropped
   * during parsing, and every remaining entry either holds a branch or is detached.
   */
  branch: string | null;

  /**
   * Git's reason the worktree can be pruned, or `null` when it cannot be.
   *
   * Test `!== null` rather than truthiness — the reason is what git chose to say, and this
   * field's presence, not its content, is the answer.
   */
  prunable: string | null;
}

/**
 * Parses one `worktree list --porcelain` record, or `null` for the repository's bare entry.
 *
 * Whole records rather than lines, which is the entire point: git emits `prunable` *after*
 * `branch`, so anything that decides a worktree is complete on seeing its branch reads a
 * stale worktree as live.
 */
// ponytail: `locked` is parsed past rather than captured — nothing consumes it, and git
// emits a bare `locked` with no reason when locked without one, so an honest field needs
// either two properties or a ""-versus-null trap. Add it when a caller needs it.
function parseWorktree(record: string): Worktree | null {
  let path = "";
  let head: string | null = null;
  let branch: string | null = null;
  let prunable: string | null = null;

  for (const attribute of record.split("\0")) {
    const boundary = attribute.indexOf(" ");
    const key = boundary === -1 ? attribute : attribute.slice(0, boundary);
    const value = boundary === -1 ? "" : attribute.slice(boundary + 1);

    switch (key) {
      case "bare":
        return null;
      case "worktree":
        path = value;
        break;
      case "HEAD":
        head = value;
        break;
      case "branch":
        branch = value;
        break;
      case "prunable":
        prunable = value;
        break;
      default:
        break;
    }
  }

  return { path, head, branch, prunable };
}

/**
 * Every worktree of the repository, in the order git reports them, without the bare entry.
 *
 * NUL-delimited rather than newline-delimited (`-z`), because a newline inside a worktree's
 * path splits one record into two under the newline form — and this list is what
 * {@link removeWorktree} acts on, so a record read off the wrong path deletes the wrong
 * directory.
 *
 * @throws If git failed. A repository always has at least one worktree, so an empty array
 *   would have no honest meaning and would only launder a real failure into a plausible
 *   answer.
 */
export async function listWorktrees(cwd?: string): Promise<Worktree[]> {
  const stdout = await gitOk(["worktree", "list", "--porcelain", "-z"], cwd);
  return stdout
    .split("\0\0")
    .filter((record) => record !== "")
    .map(parseWorktree)
    .filter((worktree) => worktree !== null);
}

/** Options for {@link addWorktree}. */
export interface WorktreeAddOptions {
  /** Create this branch at `startPoint`. Omit to check out `startPoint` as it is. */
  branch?: string;

  /** Commit-ish the worktree starts at. Defaults to the current `HEAD`. */
  startPoint?: string;
}

/**
 * Creates a worktree at `path`.
 *
 * @throws If git refused — the path is taken, the branch already exists, or the branch is
 *   checked out somewhere else. The message carries git's own stderr.
 */
export async function addWorktree(
  path: string,
  options: WorktreeAddOptions = {},
  cwd?: string,
): Promise<void> {
  const args = ["worktree", "add"];
  if (options.branch !== undefined) args.push("-b", options.branch);
  args.push(path);
  if (options.startPoint !== undefined) args.push(options.startPoint);
  await gitOk(args, cwd);
}

/** Options for {@link removeWorktree}. */
export interface WorktreeRemoveOptions {
  /** Remove the worktree even with uncommitted changes or untracked files in it. */
  force?: boolean;
}

/**
 * Removes the worktree at `path`, deleting its directory. The branch it held is untouched.
 *
 * @throws If git refused — most often because the worktree is dirty and `force` was not set.
 */
export async function removeWorktree(
  path: string,
  options: WorktreeRemoveOptions = {},
  cwd?: string,
): Promise<void> {
  const args = ["worktree", "remove"];
  if (options.force === true) args.push("--force");
  args.push(path);
  await gitOk(args, cwd);
}

/**
 * Discards the administrative records of worktrees whose directories are gone.
 *
 * These are the entries {@link Worktree.prunable} marks; until pruned they keep holding
 * their branch, so git refuses to check that branch out anywhere else.
 *
 * @throws If git failed.
 */
export async function pruneWorktrees(cwd?: string): Promise<void> {
  await gitOk(["worktree", "prune"], cwd);
}
