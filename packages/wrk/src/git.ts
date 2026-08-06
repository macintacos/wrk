/**
 * Typed wrappers over the git plumbing the rest of `wrk` needs.
 *
 * Every wrapper is one plumbing command, named for what the caller wants rather than for
 * how git spells it, and layered on {@link run} from `./proc`. Porcelain output formats are
 * parsed here so no caller has to know which git version prints what.
 *
 * Three conventions run through the whole module.
 *
 * **`cwd` is the first optional parameter of every wrapper**, since it is the one thing
 * every caller varies — `wrk` exists to operate on checkouts other than the one it is
 * running in. Options that tune a command come after it, so no call site has to pass
 * `undefined` to reach the argument it actually cares about.
 *
 * **A query reads any refusal as "no"; a command with no "no" to express throws.**
 * {@link showToplevel}, {@link gitCommonDir}, {@link isInsideWorkTree}, {@link currentBranch},
 * {@link symbolicRef} and {@link refExists} answer `null` or `false` for every nonzero exit,
 * including "not a repository" — a caller's next move is the same whichever it was, and the
 * first two are themselves how repo-ness gets probed. {@link listWorktrees},
 * {@link forEachRef}, {@link statusPorcelain} and the worktree mutations have no such
 * answer, so they throw a {@link CommandFailed} carrying git's own exit status and stderr
 * rather than return an empty result a caller would read as real — the status being what
 * lets `wrk` exit with the code of the command that failed underneath it.
 * {@link listWorktrees} has one further failure of its own: a record it cannot read, which
 * is a plain `Error` carrying the record rather than any stderr. {@link gitOk} is that half's
 * escape hatch — {@link git}'s throwing twin, for the one-off command that has not earned a
 * wrapper of its own.
 *
 * **Output is fully buffered**, since {@link run} has no `maxBuffer` equivalent. That is a
 * deliberate call rather than an oversight: no wrapper here runs `git log` or `git diff`, so
 * the largest output any of them can produce is bounded by the repository's current state —
 * its refs, its worktrees, its dirty paths — at tens of bytes per line, never by the size of
 * history. The bound is a property of which commands are wrapped, not something enforced:
 * {@link git} is exported and will buffer whatever it is handed.
 *
 * @packageDocumentation
 */

import { z } from "zod";

import { CommandFailed } from "./errors";
import { type RunResult, run } from "./proc";

/**
 * Every variable `git rev-parse --local-env-vars` reports, mapped to `undefined` so
 * {@link git} unsets each one.
 *
 * This is git's own answer to "what binds me to one particular repository", and therefore
 * the complete set of things that can override a `cwd`. Two of them do real damage and are
 * not obvious: git exports `GIT_INDEX_FILE` to **every hook**, which points
 * {@link statusPorcelain} at another worktree's index and makes a clean checkout report as
 * dirty; and `GIT_COMMON_DIR` redirects {@link gitCommonDir} and {@link listWorktrees}
 * wholesale, which is how a worktree list ends up describing a different repository than the
 * one about to be acted on.
 *
 * Re-derive the list from `git rev-parse --local-env-vars` rather than editing it by hand.
 */
const LOCAL_REPO_ENV: Record<string, undefined> = Object.fromEntries(
  [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
  ].map((name) => [name, undefined]),
);

/**
 * Runs `git` with `args` in `cwd` and resolves with what it said — the escape hatch for any
 * plumbing command this module does not wrap.
 *
 * Every repository-binding variable in the inherited environment is unset for the child
 * (see {@link LOCAL_REPO_ENV}), so `cwd` alone decides which repository answers. Doing it
 * here rather than per wrapper is what keeps it true of the next wrapper anyone adds.
 *
 * A nonzero exit resolves rather than throwing, exactly as {@link run} does.
 *
 * @param args - Arguments after `git`, one array element per argv entry.
 * @param cwd - Directory to run in. Defaults to this process's cwd.
 * @param env - Variables for this call alone, for the settings git reads from the environment
 *   and nowhere else — `GIT_TERMINAL_PROMPT` being the one this exists for. {@link
 *   LOCAL_REPO_ENV} is spread *after* it and therefore wins, so this parameter can add to the
 *   environment but cannot re-bind the repository: `cwd` stays the only thing that decides which
 *   repository answers, which is what the module header promises without qualification. A caller
 *   wanting a different repository has `cwd`.
 */
export function git(
  args: string[],
  cwd?: string,
  env?: Record<string, string | undefined>,
): Promise<RunResult> {
  return run("git", args, { cwd, env: { ...env, ...LOCAL_REPO_ENV } });
}

/**
 * Runs `git` and returns its stdout, throwing if it did not exit 0.
 *
 * For the commands where git has no "no" to express — listing worktrees, reading status,
 * mutating anything — so a failure surfaces as git's own message rather than as an empty
 * list the caller reads as a real answer.
 *
 * The failure is a {@link CommandFailed} rather than a plain `Error`, which is what lets
 * `wrk` exit with git's own status: this is the one place every throwing wrapper in the
 * module routes through, so the code survives as a value here or it survives nowhere.
 *
 * Exported as {@link git}'s throwing twin, for a mutation whose single caller does not earn a
 * wrapper of its own — a `fetch`, a `switch`, a `pull`. A command that gains a second caller
 * earns its wrapper then, and moves in here.
 *
 * @param args - Arguments after `git`, one array element per argv entry.
 * @param cwd - Directory to run in. Defaults to this process's cwd.
 * @param env - Per-call environment, exactly as {@link git} takes it.
 */
export async function gitOk(
  args: string[],
  cwd?: string,
  env?: Record<string, string | undefined>,
): Promise<string> {
  const { stdout, stderr, code } = await git(args, cwd, env);
  if (code !== 0) {
    throw new CommandFailed(["git", ...args], code, stderr);
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
async function revParse(args: string[], cwd?: string): Promise<string | null> {
  const { stdout, code } = await git(["rev-parse", ...args], cwd);
  return code === 0 ? stdout.trim() : null;
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

/** The `refs/heads/` prefix {@link currentBranch} strips. */
const BRANCH_PREFIX = "refs/heads/";

/**
 * The short name of the checked-out branch, or `null` when there is not one.
 *
 * `null` means a detached HEAD or no repository. On an unborn branch — a fresh repository
 * with no commit — the branch name is still reported, because it is still the branch a commit
 * would land on.
 *
 * Read through `symbolic-ref` rather than `rev-parse --abbrev-ref HEAD`, which the issue's
 * acceptance criteria name. `--abbrev-ref` shortens ambiguously: with a tag named `main`
 * alongside the branch `main` it answers `heads/main`, which is not a name any caller can use
 * — `refs/heads/` + it is `refs/heads/heads/main` — and which would not match the
 * fully-qualified refs {@link listWorktrees} reports. `symbolic-ref` reads HEAD exactly, and
 * exits nonzero when detached, so the "HEAD means detached" special case disappears with it.
 */
export async function currentBranch(cwd?: string): Promise<string | null> {
  const ref = await symbolicRef("HEAD", cwd);
  if (ref === null || !ref.startsWith(BRANCH_PREFIX)) return null;
  return ref.slice(BRANCH_PREFIX.length);
}

/**
 * Refs matching `patterns`, one entry per ref.
 *
 * @param patterns - Ref patterns, e.g. `["refs/heads"]`. Matching nothing is not an error.
 * @param cwd - Directory to run in.
 * @param format - A `for-each-ref` format string. A format containing newlines splits one
 *   ref across several entries.
 * @throws If git failed — matching no refs returns `[]` rather than failing.
 */
export async function forEachRef(
  patterns: string[],
  cwd?: string,
  format = "%(refname)",
): Promise<string[]> {
  return lines(await gitOk(["for-each-ref", `--format=${format}`, ...patterns], cwd));
}

/** Options for {@link statusPorcelain}. */
export interface StatusOptions {
  /**
   * Whether untracked files count as changes. Defaults to `true`, git's own default.
   *
   * `false` passes `--untracked-files=no`, which is the question "would a `switch` or a
   * fast-forward `pull` be blocked?" — scratch files and build output are normal in a working
   * checkout and block neither.
   */
  untracked?: boolean;
}

/**
 * Porcelain status entries, one per line — empty exactly when the work tree is clean.
 *
 * Version 1 of the format, deliberately not `-z`: under `-z` a rename emits two
 * NUL-separated fields for one logical change, so splitting on the separator yields a bare
 * path masquerading as an entry. Line mode always puts one entry on one line, at the cost of
 * C-quoting paths containing unusual characters.
 *
 * `--no-optional-locks` because reading status is not worth contending for `index.lock`:
 * plain `git status` rewrites the refreshed index, so surveying several worktrees — or
 * running while an editor does its own background `status` — turns into an intermittent
 * "Unable to create index.lock" failure. The reported entries are unchanged; only the
 * cache write is skipped. It is also what lets a caller that must not touch the repository at
 * all — one deciding whether it is allowed to — ask this question safely.
 *
 * @throws If git failed.
 */
export async function statusPorcelain(
  cwd?: string,
  options: StatusOptions = {},
): Promise<string[]> {
  const args = ["--no-optional-locks", "status", "--porcelain"];
  if (options.untracked === false) args.push("--untracked-files=no");
  return lines(await gitOk(args, cwd));
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
 * The attributes of one `worktree list --porcelain` record, as a {@link Worktree}.
 *
 * This is the parse boundary in the literal sense — text git wrote becoming a value the
 * rest of `wrk` acts on — so it is a schema rather than a hand-rolled fold, and the
 * transform's return annotation ties it to {@link Worktree} so the two cannot drift.
 *
 * `worktree` is required **and non-empty**, which is the point of writing it this way: it
 * is what makes `Worktree.path` a path rather than possibly the empty string. Git has
 * always emitted it first and with a value, so this is the schema stating a precondition
 * rather than a case expected to fire — but {@link removeWorktree} deletes the directory it
 * is handed, and an empty path is not something that should be able to reach it if a future
 * git ever reshapes this format.
 *
 * Attributes with no value (`detached`, a reasonless `locked`) arrive as the empty string,
 * and every attribute not named here is dropped by the schema.
 */
// ponytail: `locked` is dropped rather than captured — nothing consumes it, and git emits
// a bare `locked` with no reason when locked without one, so an honest field needs either
// two properties or a ""-versus-null trap. Add it when a caller needs it.
const WORKTREE = z
  .object({
    worktree: z.string().min(1),
    HEAD: z.string().optional(),
    branch: z.string().optional(),
    prunable: z.string().optional(),
  })
  .transform(
    ({ worktree, HEAD, branch, prunable }): Worktree => ({
      path: worktree,
      // Git writes the all-zeros object id for a branch with no commit yet, which is not a
      // commit-ish any caller can hand back to it. Matched by shape rather than by length
      // so SHA-256 repositories, where it is 64 characters, are covered too.
      head: HEAD === undefined || /^0+$/.test(HEAD) ? null : HEAD,
      branch: branch ?? null,
      prunable: prunable ?? null,
    }),
  );

/**
 * Parses one NUL-separated `worktree list --porcelain -z` record, or `null` for the
 * repository's bare entry.
 *
 * Whole records rather than lines, which is the entire point: git emits `prunable` *after*
 * `branch`, so anything that decides a worktree is complete on seeing its branch reads a
 * stale worktree as live.
 *
 * Exported only so `git.test.ts` can drive it with hand-built bytes. {@link listWorktrees}
 * is the supported entry point, and the records this rejects are ones real git does not
 * emit — which is exactly why they cannot be reached through it.
 *
 * @internal
 * @throws If the record is not one {@link WORKTREE} accepts, carrying the record itself.
 *   Git's own stderr says nothing about a record git successfully printed, so the record is
 *   what a reader needs — and the message follows {@link CommandFailed}'s shape rather than
 *   letting a `ZodError`'s issue array out of the module.
 */
export function parseWorktree(record: string): Worktree | null {
  const attributes = Object.fromEntries(
    record.split("\0").map((attribute) => {
      const boundary = attribute.indexOf(" ");
      return boundary === -1
        ? [attribute, ""]
        : [attribute.slice(0, boundary), attribute.slice(boundary + 1)];
    }),
  );
  if ("bare" in attributes) return null;

  const parsed = WORKTREE.safeParse(attributes);
  if (!parsed.success) {
    throw new Error(`git worktree list emitted an unreadable record: ${JSON.stringify(record)}`);
  }

  return parsed.data;
}

/**
 * Every worktree of the repository, in the order git reports them, without the bare entry.
 *
 * NUL-delimited rather than newline-delimited (`-z`), because a newline inside a worktree's
 * path splits one record into two under the newline form — and this list is what
 * {@link removeWorktree} acts on, so a record read off the wrong path deletes the wrong
 * directory.
 *
 * @throws If git failed, or if it emitted a record {@link WORKTREE} does not accept. A
 *   repository always has at least one worktree, so an empty array would have no honest
 *   meaning and would only launder a real failure into a plausible answer — and a record
 *   this module cannot read is the same kind of failure, one directory-deleting call away.
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
 * **With neither option set, git's own convenience DWIM takes over** and creates a branch
 * named after `path`'s basename — or, where `worktree.guessRemote` is configured, tracks a
 * same-named remote branch instead. Pass `branch` to decide the name rather than inheriting
 * it from a directory name and a config setting.
 *
 * @throws If git refused — the path is taken, the branch already exists, or the branch is
 *   checked out somewhere else. The message carries git's own stderr.
 */
export async function addWorktree(
  path: string,
  cwd?: string,
  options: WorktreeAddOptions = {},
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
  cwd?: string,
  options: WorktreeRemoveOptions = {},
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
