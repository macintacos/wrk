/**
 * The repository model — container, checkout, run worktree — and the rules that identify
 * each from any cwd inside the repository.
 *
 * `wrk` operates on a **bare-repo container**: a directory holding a `.bare` repository, a
 * `.git` file pointing at it, and one sibling directory per checkout, each named for the
 * branch it holds.
 *
 * ```text
 * <container>/.bare                  the bare clone
 * <container>/.git                   file holding `gitdir: ./.bare`
 * <container>/trunk                  the default-branch checkout, named for it
 * <container>/EXC-1+add-thing        a run worktree
 * ```
 *
 * **The repository's identity is its container, and the container is `dirname` of the git
 * *common* dir.** That is the one rule everything else here rests on. The obvious
 * alternative is wrong in a way that does not announce itself: `git rev-parse
 * --show-toplevel` returns the *checkout*, whose basename under this layout is a **branch**
 * name — so anything keyed off it silently re-keys the moment a run worktree is created,
 * and every cache, store and lookup hanging off the repository quietly starts missing.
 * {@link showToplevel} is used here only as a work-tree probe, never as an identifier.
 *
 * **Paths are not re-resolved.** Git already emits realpath-resolved absolute paths from
 * `--show-toplevel`, `--path-format=absolute --git-common-dir` and `worktree list
 * --porcelain` — including when the container is reached through a symlink, and including
 * when `worktree add` was handed a symlinked destination. Every path this module returns
 * comes from one of those three, and `dirname` of a resolved path is resolved, so a
 * `realpath` pass on top would be redundant work that also *changes* the answer for a
 * prunable worktree whose directory no longer exists. The property is pinned by a test that
 * builds a container under a symlink rather than by code that re-does git's work.
 *
 * @packageDocumentation
 */

import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  currentBranch,
  git,
  gitCommonDir,
  listWorktrees,
  refExists,
  showToplevel,
  symbolicRef,
} from "./git";

/**
 * Conventional default-branch names, tried in this order when `origin/HEAD` is absent.
 *
 * Order is the rule, not the membership: a repository carrying several of these has exactly
 * one default, and picking the first match is what makes the answer deterministic rather
 * than dependent on which ref git happens to enumerate first.
 */
const DEFAULT_BRANCH_FALLBACKS = ["main", "master", "trunk"] as const;

/** The remote's default-branch pointer, and the prefix {@link resolveDefaultBranch} strips. */
const ORIGIN_HEAD_REF = "refs/remotes/origin/HEAD";
const ORIGIN_PREFIX = "refs/remotes/origin/";

/** The prefix branch refs carry, as {@link listWorktrees} and `show-ref` report them. */
const BRANCH_PREFIX = "refs/heads/";

/**
 * Where a directory sits relative to the repository — the three-state "where am I?".
 *
 * The states are distinguished by which of the two `rev-parse` probes answer: a work tree
 * *and* a common dir means a checkout; no work tree but a common dir means the container,
 * which is bare and so has none; neither means no repository at all. The fourth combination
 * cannot occur — nothing has a work tree without a common dir.
 *
 * `container` is present in both repository states because it is the repository's key, and a
 * caller in the container needs it exactly as much as one in a checkout. `root` is the
 * checkout's own root and is **not** an identifier for the repository — see this module's
 * header.
 */
export type Location =
  | { readonly kind: "checkout"; readonly root: string; readonly container: string }
  | { readonly kind: "container"; readonly container: string }
  | { readonly kind: "outside" };

/**
 * Reports where `cwd` sits relative to the repository.
 *
 * The two probes run concurrently because neither depends on the other and both are process
 * spawns; the branch is decided once they are both back.
 *
 * @param cwd - Directory to inspect. Defaults to this process's cwd.
 * @returns One of the three states — see {@link Location}.
 *
 * @example
 * ```ts
 * const where = await locate();
 * if (where.kind === "outside") throw new Error("not a repository");
 * console.log(where.container); // the repository's key, in either repository state
 * ```
 */
export async function locate(cwd?: string): Promise<Location> {
  const [root, commonDir] = await Promise.all([showToplevel(cwd), gitCommonDir(cwd)]);
  if (commonDir === null) return { kind: "outside" };

  const container = dirname(commonDir);
  return root === null ? { kind: "container", container } : { kind: "checkout", root, container };
}

/**
 * The container `cwd`'s repository lives in, or `null` outside a repository.
 *
 * Resolves identically from the container, from any checkout, and from any linked worktree,
 * which is what makes it usable as the repository's key. For an unconverted repository this
 * is simply the directory holding its `.git` — {@link isBareLayout} is the predicate that
 * tells the two shapes apart.
 *
 * @param cwd - Directory to inspect. Defaults to this process's cwd.
 * @returns The absolute container path, or `null` if `cwd` is in no repository.
 */
export async function containerFor(cwd?: string): Promise<string | null> {
  const commonDir = await gitCommonDir(cwd);
  return commonDir === null ? null : dirname(commonDir);
}

/** Whether `path` exists and is a regular file. A missing path is `false`, not an error. */
async function isFile(path: string): Promise<boolean> {
  const stats = await stat(path).catch(() => null);
  return stats?.isFile() ?? false;
}

/**
 * Whether `cwd`'s repository is converted to the bare-repo container layout.
 *
 * **Both halves are required, because neither is sufficient.** `core.bare` alone is equally
 * true of the older `<name>.git` convention, where the derived container is a directory of
 * *other repositories* and worktrees created in it would be scattered among them. A path
 * comparison alone — "is the common dir inside this checkout?" — misreads a plain clone that
 * happens to carry an old-style nested worktree, whose common dir sits at the clone root
 * while its toplevel is the nested worktree. The `.git` pointer **file** the conversion
 * writes is what makes a container a container, and it must be a file: a normal
 * repository's `.git` is a directory.
 *
 * `core.bare` is read through `git config`, never `rev-parse --is-bare-repository`. The two
 * disagree exactly where it matters: the config value is a property of the *repository* and
 * is shared by every worktree, while `--is-bare-repository` answers about the *cwd* and so
 * reports `false` from every checkout in a converted container — which would make this
 * predicate false everywhere except the container itself.
 *
 * @param cwd - Directory to inspect. Defaults to this process's cwd.
 * @returns `true` only for a converted container. Outside a repository, `false`.
 */
export async function isBareLayout(cwd?: string): Promise<boolean> {
  const container = await containerFor(cwd);
  if (container === null) return false;

  const { stdout, code } = await git(["config", "--get", "core.bare"], cwd);
  if (code !== 0 || stdout.trim() !== "true") return false;

  return isFile(join(container, ".git"));
}

/**
 * The repository's default branch, as a short name.
 *
 * Three sources, in order: the remote's own `origin/HEAD`; then the first of
 * {@link DEFAULT_BRANCH_FALLBACKS} that exists as a local branch; then whatever branch is
 * checked out. The fallbacks are not a nicety — `git clone --bare` creates no
 * remote-tracking refs at all, so `origin/HEAD` is genuinely absent in the layout `wrk`
 * itself uses, making the second source the common path rather than the edge case.
 *
 * The candidates are probed sequentially by design: the first match wins, so probing all
 * three concurrently would spawn two `git` processes whose answers are discarded.
 *
 * @param cwd - Directory to inspect. Defaults to this process's cwd.
 * @returns The short branch name, or `null` when there is nothing to answer — a detached
 *   HEAD with no conventional branch present, or no repository at all. Deliberately not the
 *   literal string `"HEAD"`: that is what `rev-parse --abbrev-ref` would say, and it is not
 *   a branch any caller can act on.
 */
export async function resolveDefaultBranch(cwd?: string): Promise<string | null> {
  const head = await symbolicRef(ORIGIN_HEAD_REF, cwd);
  if (head?.startsWith(ORIGIN_PREFIX)) return head.slice(ORIGIN_PREFIX.length);

  for (const candidate of DEFAULT_BRANCH_FALLBACKS) {
    if (await refExists(`${BRANCH_PREFIX}${candidate}`, cwd)) return candidate;
  }

  return currentBranch(cwd);
}

/**
 * A checkout to work in, given a directory that may not be one.
 *
 * `cwd` inside a work tree resolves to that checkout's root. Otherwise `cwd` is the
 * container — bare, and so with no work tree of its own — and the answer is the checkout
 * holding the default branch. Callers arrive there routinely rather than by mistake: the
 * container keeps the path the repository had before conversion, so stale bookmarks and
 * plain habit both land in it.
 *
 * **The default-branch checkout is found by the branch it holds, never by its directory
 * name.** `wrk` names it for its branch when it creates one, but the hand-run conversion
 * recipe leaves the name to whoever runs it, so a name-based lookup finds the wrong checkout
 * or none at all.
 *
 * @param cwd - Directory to inspect. Defaults to this process's cwd.
 * @returns The absolute checkout root, or `null` when there is no work tree to offer —
 *   either `cwd` is in no repository, or no worktree holds the default branch. Use
 *   {@link locate} to tell those apart. `null` rather than `cwd`: handing back a bare
 *   container path labelled "the checkout" would push the failure into whichever caller
 *   acted on it.
 */
export async function checkoutFor(cwd?: string): Promise<string | null> {
  const where = await locate(cwd);
  if (where.kind === "outside") return null;
  if (where.kind === "checkout") return where.root;

  // Settled through `locate` above rather than probed here, because `listWorktrees` throws
  // outside a repository instead of answering — the one call below must not be reached with
  // a cwd that has no repository to list.
  const branch = await resolveDefaultBranch(cwd);
  if (branch === null) return null;

  const ref = `${BRANCH_PREFIX}${branch}`;
  const holder = (await listWorktrees(cwd)).find((worktree) => worktree.branch === ref);
  return holder?.path ?? null;
}
