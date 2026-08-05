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
