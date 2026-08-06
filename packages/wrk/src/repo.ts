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
 * `realpath` pass on top would be redundant work that would also *fail* rather than answer:
 * `fs.realpath` rejects with `ENOENT` on a path that no longer exists, which is exactly the
 * shape a prunable worktree's record has. {@link checkoutFor} drops those records instead.
 * All three routes are pinned by tests that build a container under a symlink, rather than
 * by code that re-does git's work.
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

/** The prefix {@link resolveDefaultBranch} strips off `origin/HEAD`'s target. */
const ORIGIN_PREFIX = "refs/remotes/origin/";

/** The remote's own record of its default branch. Derived, so the two cannot drift apart. */
const ORIGIN_HEAD_REF = `${ORIGIN_PREFIX}HEAD`;

/** The prefix branch refs carry, as {@link listWorktrees} and `show-ref` report them. */
const BRANCH_PREFIX = "refs/heads/";

/**
 * What a command that places a sibling worktree refuses with when {@link isBareLayout} is false.
 *
 * Here rather than at either call site because it is one sentence with two speakers —
 * `worktree.ts`'s `createWorktree` and `prpick.ts`'s `landIn` — and it names a skill the user is
 * then expected to run. `output.ts` exports `PREFIX` on exactly this reasoning: a second literal
 * is the shape that drifts, and a drifted instruction is worse than a drifted prefix. It lives
 * beside {@link isBareLayout} because that is the predicate it is the negative answer to.
 */
export const UNCONVERTED =
  "not a bare-repo container, so there is nowhere to place a sibling worktree; convert it first with the repo-setup skill";

/**
 * Where a directory sits relative to the repository — the three-state "where am I?".
 *
 * The states are distinguished by which of the two `rev-parse` probes answer: a work tree
 * *and* a common dir means a checkout; a common dir with no work tree means somewhere in the
 * repository that is not a work tree; neither means no repository at all. The fourth
 * combination cannot occur — nothing has a work tree without a common dir.
 *
 * `"container"` names the case that matters — a bare-repo container, where callers land
 * routinely because it keeps the path the repository had before conversion. It is **not**
 * exclusively that: `--show-toplevel` fails from inside any git directory, so a plain clone's
 * `.git`, a worktree's private gitdir, and `<container>/.bare` all report `"container"` too.
 * The `container` value is correct in every one of them, which is what the state is for; it
 * is a "not in a work tree" answer, not a proof the repository is bare. {@link isBareLayout}
 * is the predicate for that.
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
 * spawns.
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
 * *other repositories* and worktrees created in it would be scattered among them. The `.git`
 * pointer file alone is equally true of any ordinary repository. So the rule is both: the
 * repository must be bare, **and** the container must hold a `.git` **file** — a normal
 * repository's `.git` is a directory, which is what that half rules out.
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
  // Sequential rather than concurrent with the `config` read below, unlike `locate`'s pair:
  // there is no container to test the `.git` of when this is null, and outside a repository
  // it saves the second spawn entirely.
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
 * `origin/HEAD` is verified to point at a ref that exists, not merely read. `git fetch
 * --prune` does not update it, so after an upstream default-branch rename — the most ordinary
 * event in this space — it names a branch nothing can check out, and {@link checkoutFor}
 * would then answer `null` with a perfectly good checkout sitting in front of it. A dangling
 * pointer is not an answer, so it falls through to the conventional names like any other
 * absent `origin/HEAD`.
 *
 * The candidates could be read in one `for-each-ref` spawn instead of up to three
 * `show-ref`s, and are not: {@link forEachRef} throws outside a repository, which would
 * replace this function's documented `null` with an exception. Three cheap spawns in the
 * uncommon case is the price of that contract.
 *
 * @param cwd - Directory to inspect. Defaults to this process's cwd.
 * @returns The short branch name, or `null` when there is nothing to answer — a detached
 *   HEAD with no conventional branch present, or no repository at all. Deliberately not the
 *   literal string `"HEAD"`: that is what `rev-parse --abbrev-ref` would say, and it is not
 *   a branch any caller can act on.
 */
export async function resolveDefaultBranch(cwd?: string): Promise<string | null> {
  const head = await symbolicRef(ORIGIN_HEAD_REF, cwd);
  if (head?.startsWith(ORIGIN_PREFIX) && (await refExists(head, cwd))) {
    return head.slice(ORIGIN_PREFIX.length);
  }

  for (const candidate of DEFAULT_BRANCH_FALLBACKS) {
    if (await refExists(`${BRANCH_PREFIX}${candidate}`, cwd)) return candidate;
  }

  return currentBranch(cwd);
}

/**
 * A checkout to work in, given a directory that may not be one.
 *
 * `cwd` inside a work tree resolves to that checkout's root. Otherwise `cwd` is in the
 * repository but not in a work tree — the container being the case that matters — and the
 * answer is the checkout holding the default branch. Callers arrive there routinely rather
 * than by mistake: the container keeps the path the repository had before conversion, so
 * stale bookmarks and plain habit both land in it.
 *
 * **The default-branch checkout is found by the branch it holds, never by its directory
 * name.** `wrk` names it for its branch when it creates one, but the hand-run conversion
 * recipe leaves the name to whoever runs it, so a name-based lookup finds the wrong checkout
 * or none at all.
 *
 * Prunable records are skipped. They are administrative entries for worktrees whose
 * directories are gone, and a path that does not exist is not a checkout — while the record
 * stands, git also refuses to check that branch out anywhere else, so there is no second
 * candidate it could be hiding.
 *
 * @param cwd - Directory to inspect. Defaults to this process's cwd.
 * @returns The absolute checkout root, or `null` when there is no work tree to offer —
 *   `cwd` is in no repository, no worktree holds the default branch, or the only one that
 *   does is prunable. Use {@link locate} to tell the first apart from the rest. `null` rather
 *   than `cwd`: handing back a path labelled "the checkout" that has no work tree, or none at
 *   all, would push the failure into whichever caller acted on it.
 * @throws If git failed while listing the worktrees.
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
  const holder = (await listWorktrees(cwd)).find(
    (worktree) => worktree.branch === ref && worktree.prunable === null,
  );
  return holder?.path ?? null;
}
