/**
 * The preflight verdict: what a calling agent should do before it creates a worktree.
 *
 * This is the most-depended-on answer `wrk` gives. Ten-plus skill files across two agent
 * trees run it before every exec run, parse the object it prints, and branch on `.verdict`
 * — so the shape below is a **frozen contract**, not an internal type. Its nine keys, their
 * order, the three verdicts and the four block reasons are all consumed by name.
 *
 * **Six checks, in an order that is itself load-bearing.** Is there a work tree here; is the
 * repository the bare-repo container the sibling layout needs; is this checkout a run
 * worktree; whose; what is the default branch; and is the checkout clean enough to sync.
 * Each one exists because the checks after it would otherwise ask a question that has no
 * meaning — there is no `--show-toplevel` to read in a bare repository, no container to
 * place a sibling in outside the layout, and no sync to run from inside somebody else's
 * worktree.
 *
 * **Every check precedes the first mutation of the repository, so a `blocked` verdict leaves
 * it byte-identical.** That is what makes a blocking answer safe to act on: the caller is
 * told to stop and knows nothing moved, including no `FETCH_HEAD`. The only writes this
 * module performs to the repository are in {@link syncDefaultBranch}, reached last and only
 * on the path that has already decided to proceed. The one write outside it is
 * {@link SYNC_LOCK}, a transient directory in the *container* beside the bare repository
 * rather than inside it, removed before this function returns.
 *
 * **The sync is serialised across processes**, because the checkout it syncs is shared. Every
 * checkout in a container has one common git dir between them, so two runs overlapping
 * collide three ways: `FETCH_HEAD` is a single file, and two fetches leave it holding more
 * than one merge candidate, which is `git pull`'s `fatal: Cannot fast-forward to multiple
 * branches`; the remote-tracking refs are locked per ref, and a fetch that loses one fails
 * outright; and `index.lock` is taken by both the switch and the pull's merge with no retry
 * timeout behind it. A fourth is not a failure but a **wrong answer**: `git status` decides
 * the `dirty-checkout` verdict from an index another run is part-way through replacing, so a
 * clean checkout reports as dirty. The dirty check is therefore inside the critical section
 * with the sync rather than in front of it. See [`./lock`](./lock) for the mutex itself, and
 * why a waiter needs no timeout of its own.
 *
 * **`blocked` is a successful run.** Exit `0` for every verdict, per [`./output`](./output)'s
 * exit rules — callers branch on the payload, never on the status, so a nonzero exit means
 * `wrk` has no answer at all rather than that the answer was no. Two failures do exit
 * nonzero, and neither is a verdict: a cwd in no repository (git's own `128`, through
 * `CommandFailed`) and a default branch that cannot be resolved on the syncing path (a
 * {@link Refusal}).
 *
 * Four deliberate divergences from the Python implementation this reproduces
 * (`agent_exec_worktree.py`), recorded here so the conformance suite meets them as decisions.
 * Each is pinned by a case in `test/conformance.test.ts` marked `DIVERGENCE`:
 *
 * - `current_branch` is `null` rather than `""` on `container-cwd`. The empty string was a
 *   consequence of a non-optional dataclass field, not a meaning.
 * - `current_branch` is `null` rather than `"HEAD"` on a detached HEAD, following
 *   {@link currentBranch}'s existing contract — `"HEAD"` is not a branch a caller can act on.
 *   Only observable on the `--base` path: the sync switches off a detached HEAD before the
 *   report is built, so the syncing path names the default branch instead.
 * - `base` uses `??` where the Python used `or`, so an explicitly empty `--base` is reported
 *   back rather than silently replaced by the default — a caller that passed one has a bug this
 *   should not hide. This is an **envelope** difference, not an internal one.
 * - A default branch that resolves to nothing on the syncing path is a {@link Refusal}, where
 *   the Python reached `git switch HEAD` and died with git's status. There is genuinely
 *   nothing to sync to, and no verdict describes it.
 *
 * Every other difference from that implementation is internal and produces the same envelope:
 * the post-sync branch and the switch decision are both known from values already in hand
 * rather than re-read from git, saving two spawns. Both are behaviour-preserving because the
 * sync ends on `defaultBranch` either way and a fast-forward pull cannot rename a branch — but
 * an envelope built from an assigned value cannot witness that on its own, so the conformance
 * cases that cover them re-read `git branch --show-current` independently.
 *
 * @packageDocumentation
 */

import { basename, join } from "node:path";

import { Refusal } from "./errors";
import { currentBranch, git, gitOk, statusPorcelain } from "./git";
import { withLock } from "./lock";
import { branchBelongsToIssue, isRunWorktree } from "./naming";
import { isBareLayout, locate, resolveDefaultBranch } from "./repo";

/**
 * What the calling agent should do next.
 *
 * - `proceed` — create the worktree; the default branch is synced and `worktree_root` says
 *   where the sibling goes.
 * - `resumed` — the session is already in this issue's worktree; create nothing.
 * - `blocked` — stop, and read `reason` for which of the four situations it is.
 */
export type Verdict = "proceed" | "resumed" | "blocked";

/**
 * Why a `blocked` run stopped.
 *
 * - `container-cwd` — the run is in the container rather than a checkout inside it. The
 *   checkouts are its subdirectories; `cd` into the default-branch one and re-run.
 * - `unconverted-repo` — not a bare-repo container, so there is nowhere to put a sibling
 *   worktree. The only reason carrying `conversion_reference`.
 * - `unrelated-worktree` — the run is inside a worktree belonging to different work, so the
 *   default branch was never synced and a new worktree would be seeded from that checkout.
 * - `dirty-checkout` — tracked changes would block the switch or the pull.
 */
export type BlockReason =
  | "container-cwd"
  | "unconverted-repo"
  | "unrelated-worktree"
  | "dirty-checkout";

/**
 * The skill that converts a repository into the layout this command requires.
 *
 * A bare skill **name**, never a path: this contract is shared by two agent trees that spell
 * an invocation differently, so a name is the only form each can render in its own idiom.
 */
const CONVERSION_REFERENCE = "repo-setup";

/**
 * Name of the lock directory serialising the default-branch sync, inside the container.
 *
 * **The container, because the container is the repository's identity** — `repo.ts`'s header
 * is the argument, and the practical consequence is that two processes reaching this
 * repository by any route derive the same path. A lock keyed off anything the environment
 * supplies, an XDG cache root being the obvious candidate, serialises only the processes that
 * happen to agree about that variable, which is not a mutex.
 *
 * Beside `.bare` rather than inside it: `git` owns the contents of its own directory, and
 * this is not git's lock. The container is safe to write into precisely because it is not a
 * work tree — {@link isBareLayout} has already answered `true` before the sync is reached —
 * so the directory can never surface as an untracked file in some checkout's `git status`.
 *
 * Exported for [`./teardown`](./teardown), the sync's second caller: two callers naming
 * different locks would serialise nothing.
 */
export const SYNC_LOCK = ".wrk-sync.lock";

/**
 * One preflight run's answer, rendered as the single JSON object on stdout.
 *
 * **No key is ever omitted.** A field a given verdict does not reach is `null`, so a caller
 * reads any of them unconditionally rather than guarding each one. The declaration order is
 * the wire order — `envelope` inherits key order from the payload's own insertion order, and
 * {@link report} builds this as one literal to keep that true.
 *
 * The keys are `snake_case` because that is what the callers already parse.
 */
export interface PreflightReport {
  /** What to do next. */
  readonly verdict: Verdict;

  /** Why a blocked run stopped; `null` for every other verdict. */
  readonly reason: BlockReason | null;

  /**
   * Root of the checkout the run was invoked from — or, on `container-cwd`, the directory it
   * was invoked from, which has no checkout root to report.
   */
  readonly repo_root: string;

  /** The repository's default branch, once resolved. */
  readonly default_branch: string | null;

  /** What the new worktree should be based on: the `base` option, else the default branch. */
  readonly base: string | null;

  /** The branch checked out **after** any sync, or `null` when HEAD is detached. */
  readonly current_branch: string | null;

  /**
   * Absolute path of the **container** the new worktree belongs in, alongside the
   * default-branch checkout.
   *
   * The name says "worktree" and the value is the container. It is misleading and it is
   * frozen — callers consume it by this name.
   */
  readonly worktree_root: string | null;

  /** The run worktree the run was invoked from, or `null` when invoked from a checkout. */
  readonly current_worktree: string | null;

  /** {@link CONVERSION_REFERENCE}, set only on the `unconverted-repo` verdict. */
  readonly conversion_reference: string | null;
}

/** Options for {@link preflight}. */
export interface PreflightOptions {
  /**
   * The branch the new worktree will be based on — the stacked path.
   *
   * When given, the default-branch sync is skipped **in its entirety**: no fetch, no switch,
   * no pull, and no dirty check, since a local feature branch is never fetched or pulled. The
   * layout and isolation checks still run, and `default_branch` is still resolved and
   * reported.
   */
  base?: string;
}

/**
 * Every key, in contract order, each holding the value a verdict that never reached it
 * reports. {@link report} spreads over this rather than restating the nine keys per call.
 */
const UNREACHED: PreflightReport = {
  verdict: "blocked",
  reason: null,
  repo_root: "",
  default_branch: null,
  base: null,
  current_branch: null,
  worktree_root: null,
  current_worktree: null,
  conversion_reference: null,
};

/**
 * Builds the full nine-key report from the handful of fields a given verdict reached.
 *
 * One literal, written once, in contract order — which is what makes "never omits a key" and
 * "keys keep a fixed order" properties of this module rather than of each return statement's
 * discipline. The spread cannot disturb the order: a key already present keeps its original
 * position when overwritten, so {@link UNREACHED} alone fixes it.
 *
 * @param fields - What this verdict reached. `verdict` and `repo_root` are required because
 *   every verdict has both, and an empty `repo_root` is the one baseline value that would be
 *   wrong rather than merely absent.
 */
function report(
  fields: Partial<PreflightReport> & Pick<PreflightReport, "verdict" | "repo_root">,
): PreflightReport {
  return { ...UNREACHED, ...fields };
}

/**
 * Brings the default branch up to date, ending with it checked out.
 *
 * Neither a repository without an `origin` nor a default branch without an upstream is a
 * failed preflight — there is simply nothing to fetch or fast-forward, and both are ordinary
 * in the bare-repo layout, where `clone --bare` creates no remote-tracking refs at all. Git
 * calls each an error, so each is guarded rather than attempted. A remote that is configured
 * but unreachable still throws: there the caller asked for an up-to-date base and cannot have
 * one.
 *
 * The three mutations go through {@link gitOk} rather than gaining wrappers of their own, per
 * `git.ts`'s rule that one caller does not earn a wrapper.
 *
 * Exported for [`./teardown`](./teardown), whose third step is this one — the resync a
 * worktree's removal leaves owing. It stays here rather than moving somewhere neutral because
 * this module's header is where the sync's collisions and its lock are argued; a caller takes
 * {@link SYNC_LOCK} with it, since the sync is only serialised if every caller holds it.
 *
 * @param cwd - The checkout to sync.
 * @param defaultBranch - The branch to end up on, already resolved.
 * @param from - The branch currently checked out, so the switch can be skipped when it is
 *   already the right one. `null` for a detached HEAD, which always switches.
 * @throws If a configured remote cannot be reached, the switch fails, or the pull is not a
 *   fast-forward.
 */
export async function syncDefaultBranch(
  cwd: string,
  defaultBranch: string,
  from: string | null,
): Promise<void> {
  const hasOrigin = (await git(["remote", "get-url", "origin"], cwd)).code === 0;
  // ponytail: the explicit fetch and the pull below are two round trips to the same remote,
  // which against a remote host is a second network wait on the critical path of every agent
  // run. `merge --ff-only @{upstream}` would reuse the refs this fetch just wrote — but only
  // where the upstream is on `origin`, which the guard below does not establish. Narrow that
  // guard first if the latency ever matters.
  if (hasOrigin) await gitOk(["fetch", "origin"], cwd);
  if (from !== defaultBranch) await gitOk(["switch", defaultBranch], cwd);

  // Read after the switch, not before: `@{upstream}` is a property of the branch that is
  // checked out, so asking while parked elsewhere answers about the wrong one.
  const tracks = (await git(["rev-parse", "--verify", "--quiet", "@{upstream}"], cwd)).code === 0;
  if (hasOrigin && tracks) await gitOk(["pull", "--ff-only"], cwd);
}

/**
 * Runs the Setup Worktree checks and reports what the caller should do.
 *
 * See this module's header for the contract: six ordered checks, three verdicts, and no
 * mutation before a blocking one.
 *
 * @param issue - The run's primary issue identifier, e.g. `EXC-997`. What tells this run's
 *   worktree from somebody else's.
 * @param cwd - Directory the calling agent is running from. Defaults to this process's cwd.
 * @param options - See {@link PreflightOptions}.
 * @returns The verdict, plus everything the caller needs in order to act on it.
 * @throws `CommandFailed` if `cwd` is in no repository at all — a caller error rather than a
 *   verdict, since none of the four describes it and no advice they carry would help — or if
 *   a git command in the sync failed outright.
 * @throws {@link Refusal} if the default branch cannot be resolved on the syncing path.
 *
 * @example
 * ```ts
 * const answer = await preflight("EXC-997");
 * // Nine flat keys rather than a union per verdict, so the container is checked, not narrowed.
 * if (answer.verdict === "proceed" && answer.worktree_root !== null) {
 *   await addWorktree(join(answer.worktree_root, worktreeDirName(branch)));
 * }
 * ```
 */
export async function preflight(
  issue: string,
  cwd?: string,
  options: PreflightOptions = {},
): Promise<PreflightReport> {
  const here = cwd ?? process.cwd();

  // 1. Is there a work tree here? `locate` answers all three states as values, "no repository
  //    at all" among them — so the probe beside it exists only to make git itself raise that
  //    one, as its own 128 through `CommandFailed`. Its return value is discarded, because
  //    `where.kind` already carries the answer. Without the probe a cwd in no repository would
  //    be handed the container verdict's "cd into the checkout below" advice, and it has no
  //    checkout below it. Concurrent: neither depends on the other and both are spawns.
  const [, where] = await Promise.all([
    gitOk(["rev-parse", "--is-inside-work-tree"], cwd),
    locate(cwd),
  ]);
  if (where.kind !== "checkout") {
    return report({ verdict: "blocked", reason: "container-cwd", repo_root: here });
  }

  const [bare, branch] = await Promise.all([isBareLayout(cwd), currentBranch(cwd)]);

  // 2. Is it the layout a sibling worktree needs? Refused first among the repository's own
  //    properties, since there is nowhere to put one and every later step would be wasted.
  if (!bare) {
    return report({
      verdict: "blocked",
      reason: "unconverted-repo",
      repo_root: where.root,
      current_branch: branch,
      conversion_reference: CONVERSION_REFERENCE,
    });
  }

  // 3. Is this checkout a run worktree, and 4. is it *this* run's? Both before the sync,
  //    which assumes a default-branch checkout.
  if (branch !== null && isRunWorktree(basename(where.root), branch)) {
    if (!branchBelongsToIssue(branch, issue)) {
      return report({
        verdict: "blocked",
        reason: "unrelated-worktree",
        repo_root: where.root,
        current_branch: branch,
        current_worktree: where.root,
      });
    }

    return report({
      verdict: "resumed",
      repo_root: where.root,
      current_branch: branch,
      current_worktree: where.root,
    });
  }

  // 5. What is the default branch? Resolved before the `base` split, so it is reported on
  //    the stacked path too — that path skips the *sync*, not the answer.
  const defaultBranch = await resolveDefaultBranch(cwd);

  let current = branch;
  if (options.base === undefined) {
    // The index and the work tree are one critical section, held against every other
    // preflight on this repository — see this module's header for the collisions, the last of
    // which is a wrong verdict rather than a failure and is why the dirty check is in here
    // rather than in front of it. The checks above stay outside deliberately: they read refs
    // and config only, never the index, and a sync running underneath them only moves refs
    // forward. `--base` reaches none of this, having nothing to sync.
    //
    // The closure answers with the branch now checked out, or with the blocking verdict
    // itself — rather than assigning `current` from in here, which a later early return would
    // silently skip. Returning it makes the compiler ask for both cases.
    const synced = await withLock(join(where.container, SYNC_LOCK), async () => {
      // 6. Is the checkout clean enough to switch and pull? Untracked files are excluded: they
      //    block neither, and scratch files are normal in a working checkout.
      if ((await statusPorcelain(cwd, { untracked: false })).length > 0) {
        return report({
          verdict: "blocked",
          reason: "dirty-checkout",
          repo_root: where.root,
          default_branch: defaultBranch,
          base: defaultBranch,
          current_branch: branch,
        });
      }

      if (defaultBranch === null) {
        throw new Refusal(
          `${where.root} has no default branch to sync — no origin/HEAD, no main, master or ` +
            "trunk, and a detached HEAD; pass --base to skip the sync",
        );
      }

      // From the checkout root rather than `cwd`, the one call here that does not take `cwd`
      // verbatim: a switch can remove the subdirectory `cwd` names, and the `@{upstream}` read
      // after it would then run from a path that no longer exists.
      await syncDefaultBranch(where.root, defaultBranch, branch);

      // Known rather than re-read: the sync above either switched to this branch or was
      // already on it, and a fast-forward pull does not rename it. One spawn saved to learn
      // what the call that just returned established.
      return defaultBranch;
    });
    if (typeof synced !== "string") return synced;
    current = synced;
  }

  return report({
    verdict: "proceed",
    repo_root: where.root,
    default_branch: defaultBranch,
    base: options.base ?? defaultBranch,
    current_branch: current,
    worktree_root: where.container,
  });
}
