/**
 * The `wt rm` engine: the four steps that retire a worktree, in the one order they work in.
 *
 * Leave the worktree, remove it, resync the default-branch checkout, delete the branch. Until
 * now that sequence lived as prose an agent re-derived on every close-out, which is the same
 * drift [`./naming`](./naming) ended for branch names and [`./preflight`](./preflight) for the
 * setup half of the same workflow.
 *
 * **"Leave the worktree" is a cwd discipline, not a step this module performs.** A child
 * process cannot move its parent shell, so the only sense in which `wrk` leaves a worktree is
 * that it never operates from inside the one it is deleting: every git command below runs from
 * the default-branch checkout, and a `cwd` inside the target is a {@link Refusal} naming where
 * to go instead. **Git does not refuse this** — `git worktree remove .` exits 0 and deletes the
 * directory out from under the shell standing in it — so the refusal below is the only guard
 * there is, not a friendlier rendering of git's.
 *
 * **The last step is the only branch deletion, and it is not optional.** `git worktree remove`
 * never removes the branch that was checked out — {@link removeWorktree} says so from the
 * other end — so a teardown that stopped after the removal would leave the branch behind for
 * good. It is equally not a sweep: exactly the branch this worktree held is deleted, never the
 * `<ISSUE-ID>/*` family around it, because a run that stacked layers has siblings whose
 * worktrees are still live.
 *
 * **The resync between them is what makes the deletion possible in general**, and is why the
 * order is fixed rather than merely tidy: a branch that is still checked out somewhere cannot
 * be deleted. Here the checkout is *found* by the default branch it holds, so it is never
 * parked on the branch about to go — but reordering the two would break the day some caller's
 * checkout is, and the resync is owed either way, since the checkout is otherwise left stale
 * and the next run branches from the wrong base.
 *
 * **Two force policies, deliberately different.** The removal is unforced by default, so a
 * worktree holding uncommitted work stops the run and the user sees git's own complaint; the
 * branch delete is always `-D`, because `-d` refuses whenever the local tip is not reachable
 * from the default branch, which is the *ordinary* state after a squash- or rebase-merge and
 * therefore the ordinary teardown. See {@link teardown} for what that costs.
 *
 * @packageDocumentation
 */

import { realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { type CommandFailed, Refusal } from "./errors";
import { gitOk, listWorktrees, removeWorktree } from "./git";
import { withLock } from "./lock";
import { SYNC_LOCK, syncDefaultBranch } from "./preflight";
import { containerFor, resolveDefaultBranch } from "./repo";

/** The prefix `listWorktrees` reports branch refs with, and everything else joins without. */
const BRANCH_PREFIX = "refs/heads/";

/**
 * What the teardown retired.
 *
 * The properties are declared in the order the envelope emits them — `envelope` inherits
 * `JSON.stringify`'s insertion-order walk — which is why {@link teardown} builds its result as
 * a single object literal. `worktree_path` is snake_case for the reason `Created`'s is: this
 * is serialised straight into the run's JSON envelope, so the property name is the field name.
 */
export interface TornDown {
  /** Absolute path of the worktree that is now gone. */
  worktree_path: string;

  /** The branch deleted with it, short, or `null` when the worktree was detached. */
  branch: string | null;

  /** The default-branch checkout, freshly synced — where the caller should be standing. */
  checkout: string;
}

/** Options for {@link teardown}. */
export interface TeardownOptions {
  /**
   * Remove the worktree even with uncommitted changes or untracked files in it.
   *
   * Governs the removal alone. The branch delete is forced unconditionally, and this flag does
   * not reach it — see this module's header for why the two differ.
   */
  force?: boolean;
}

/**
 * Retires `target`: removes its worktree, resyncs the default-branch checkout, deletes its
 * branch.
 *
 * `target` is either a path — absolute, or relative to `cwd` — or the branch the worktree
 * holds, which is what [`./wt`](./wt) shows as a row's identity and therefore what a caller
 * who just looked at the picker has in mind. Paths are matched against git's own, which are
 * realpath-resolved, so the argument is resolved the same way before comparing; a path that
 * does not exist falls through to the branch arm rather than failing on the resolution.
 *
 * **This destroys unpushed commits.** The removal refuses over uncommitted changes, so a dirty
 * tree is safe without `force`, but commits sitting on the branch and nowhere else go with the
 * `-D`. That is the command's purpose rather than an oversight — the state it exists to clean
 * up is a merged pull request, whose local tip is routinely unreachable from the default
 * branch — and it is the reason this is one explicit `rm` rather than anything automatic.
 *
 * @param cwd - Anywhere in the repository, other than inside the worktree being removed.
 * @param target - The worktree to remove: a path, or the branch it holds.
 * @param options - See {@link TeardownOptions}.
 * @returns What was removed and where to go now — see {@link TornDown}.
 * @throws {@link Refusal} if `cwd` is in no repository, if `target` names no worktree, if the
 *   repository has no default-branch checkout to work from, if `target` *is* that checkout, or
 *   if the caller is standing inside the worktree they asked to remove.
 * @throws {@link CommandFailed} if git refused — the worktree is dirty and `force` was not
 *   set, the remote could not be reached, the pull was not a fast-forward. It carries git's own
 *   exit status, which is what `wrk` exits with.
 *
 * @example
 * ```ts
 * await teardown(process.cwd(), "EXC-1/add-thing");
 * // { worktree_path: "/…/repo/EXC-1+add-thing", branch: "EXC-1/add-thing", checkout: "/…/repo/main" }
 * ```
 */
export async function teardown(
  cwd: string,
  target: string,
  options: TeardownOptions = {},
): Promise<TornDown> {
  // First, and on its own: it settles repo-ness before `listWorktrees` — which throws rather
  // than answering outside a repository — and it is what the two reads below are asked from.
  const container = await containerFor(cwd);
  if (container === null) {
    throw new Refusal("not a git repository; run this from inside the repository to remove from");
  }

  // **Asked of the container, not of `cwd`.** Refs are shared, so the *list* is the same either
  // way — but `resolveDefaultBranch` falls through to whatever branch its cwd has checked out
  // when `origin/HEAD` is absent or dangling and none of main/master/trunk exists, which
  // `repo.ts` documents as ordinary rather than exotic. Asked from inside a run worktree it
  // answers `EXC-2/b`, and the whole of the rest of this function then acts on that worktree:
  // the real checkout is left unsynced and somebody else's is fetched into. The container is
  // the one place with no run branch to be confused by — in the bare-repo layout its HEAD is
  // the repository's default, and in an unconverted repository it is the main work tree, whose
  // branch is the same answer `checkoutFor` degrades to.
  //
  // Concurrent because neither depends on the other and both are spawns. The one list serves
  // the target lookup and the checkout lookup both, which is also why `checkoutFor` is not used
  // for the second: it answers with the *caller's* checkout when the caller is in one, which
  // from a run worktree is the worktree about to be removed.
  const [worktrees, defaultBranch] = await Promise.all([
    listWorktrees(container),
    resolveDefaultBranch(container),
  ]);

  const named = resolve(cwd, target);
  const path = await realpath(named).catch(() => named);
  const found =
    worktrees.find((worktree) => worktree.path === path) ??
    worktrees.find((worktree) => worktree.branch === `${BRANCH_PREFIX}${target}`);
  if (found === undefined) {
    throw new Refusal(
      `no worktree of this repository is ${target}; wrk wt lists the ones there are`,
    );
  }

  if (defaultBranch === null) {
    throw new Refusal(
      "this repository has no default branch to sync to — no origin/HEAD, no main, master or trunk, and a detached HEAD",
    );
  }

  // Prunable records skipped, as `repo.ts`'s `checkoutFor` skips them and for its reason: a
  // path that does not exist is not a checkout, and nothing can be synced in it.
  const ref = `${BRANCH_PREFIX}${defaultBranch}`;
  const checkout = worktrees.find(
    (worktree) => worktree.branch === ref && worktree.prunable === null,
  );
  if (checkout === undefined) {
    throw new Refusal(
      `no worktree holds ${defaultBranch}, so there is nowhere to remove from and nothing to resync`,
    );
  }

  if (found.path === checkout.path) {
    throw new Refusal(
      `${found.path} is this repository's default-branch checkout, not a worktree to retire`,
    );
  }

  // Compared against `found.path` plus a separator rather than against `found.path` alone, so
  // a sibling whose name merely starts with the target's — `EXC-1+add-thing-2` beside
  // `EXC-1+add-thing` — is not read as being inside it.
  const here = await realpath(cwd).catch(() => resolve(cwd));
  if (here === found.path || here.startsWith(`${found.path}${sep}`)) {
    throw new Refusal(
      `cannot remove ${found.path} while standing in it; cd ${checkout.path} first`,
    );
  }

  await removeWorktree(found.path, checkout.path, { force: options.force });

  // Under the same lock `preflight` takes, and it has to be: `FETCH_HEAD` is one file per
  // repository, so a teardown fetching while a sibling run's preflight fetches leaves it
  // holding two merge candidates — `fatal: Cannot fast-forward to multiple branches`.
  //
  // `defaultBranch` is passed as the branch already checked out because that is how `checkout`
  // was found, so the switch inside is correctly skipped.
  await withLock(join(container, SYNC_LOCK), () =>
    syncDefaultBranch(checkout.path, defaultBranch, defaultBranch),
  );

  const branch = found.branch === null ? null : found.branch.slice(BRANCH_PREFIX.length);
  // Through `gitOk` rather than a wrapper of its own, per `git.ts`'s rule that one caller does
  // not earn one. A detached worktree held no branch, so there is nothing to delete.
  if (branch !== null) await gitOk(["branch", "-D", branch], checkout.path);

  return { worktree_path: found.path, branch, checkout: checkout.path };
}
