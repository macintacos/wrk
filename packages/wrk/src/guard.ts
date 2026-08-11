/**
 * The cross-checkout edit decision: may this session write to this path?
 *
 * Under the bare-repo container layout every checkout is a flat sibling of every other, so a
 * path resolved against the wrong root does not fail — it lands in a real directory belonging
 * to somebody else's work and stays invisible, because the tests in the checkout the session
 * *meant* still pass. This module is the rule that catches that, and nothing else: it takes a
 * path and a session location and answers {@link Verdict}. **It implements no harness's hook
 * protocol.** Reading a payload, choosing an exit code, and writing a decision envelope belong
 * to the wiring that calls this, which differs per harness and lives outside `wrk`.
 *
 * ## One rule, not two
 *
 * Two guards enforce this today with rules that look inverted. The Claude Code hook anchors on
 * `$PWD` — which `EnterWorktree` moves into the run worktree — and blocks any absolute path
 * inside the container but outside that checkout. The OpenCode plugin cannot: that harness
 * never relocates a session, so `$PWD` stays in the default-branch checkout and the Python rule
 * ported as written would allow every mistake and block nothing. It instead remembers the
 * worktree root `agent_exec_worktree.py create` printed and blocks everything else inside the
 * container.
 *
 * The inversion dissolves once the session's working checkout is a *parameter* rather than a
 * discovery. Hand {@link verdict} the remembered worktree root and it produces the OpenCode
 * rule exactly: the session is a run worktree, so the crossing below is unavailable and every
 * other in-container path blocks. Hand it `$PWD` and it produces the Python rule. They were
 * never two rules — they were one rule with two ways of answering "where is this session
 * working?", which is why {@link Session} is an argument here and not something this module
 * goes looking for.
 *
 * ## The one sanctioned crossing
 *
 * The **default-branch checkout may write into a run worktree of the same container**. That is
 * an orchestrated implementer: its cwd is pinned to the checkout it was dispatched from and
 * cannot follow it into the worktree it created, so every write it makes is an absolute path
 * across that boundary. It runs one way only — a run worktree writing at the default-branch
 * checkout is the accident this exists for, and stays blocked.
 *
 * Both halves of each {@link isRunWorktree} call are required, because in this layout every
 * checkout is a linked worktree and git-directory identity tells none of them apart. The
 * branch must carry an `<ISSUE-ID>/` prefix *and* the directory must be the one `create` would
 * have named for it.
 *
 * ## Fail-open, asymmetrically
 *
 * A guard must never block on its own bug — which is also why this module's import graph is
 * kept to what is already on the git path, pinned by a test. The asymmetry that follows from
 * it is deliberate and is the subtlest thing here:
 *
 * - **Failing to locate the session allows.** One that cannot tell where it is has nothing to
 *   compare against, so {@link guardEdit} answers "allowed" for a cwd outside any repository,
 *   for a container cwd with no work tree, and for any error reaching git at all.
 * - **Failing to name the *target's* branch keeps the block.** That lookup decides whether the
 *   crossing above is sanctioned, so a target git cannot answer for — missing, wedged, not a
 *   checkout — is not a run worktree, and the block stands. The relaxation is proven, never
 *   assumed.
 *
 * A session whose *own* branch cannot be named sits between the two: it is not a run worktree,
 * which leaves the crossing available and everything else still blocked. A guard does not block
 * harder because it knows less about itself.
 *
 * One deliberate tightening over the Python guard follows from reading that asymmetry
 * consistently. It names the *session's* branch with a plain `--abbrev-ref`, so a run worktree
 * stopped mid-rebase stops looking like one to itself and may write outside its own checkout;
 * here both branches come from {@link headBranch}, so it still knows what it is and stays
 * blocked. Same rule, applied to both ends rather than one.
 *
 * ## What is deliberately not blocked
 *
 * A path outside the container, which is what permits the exec plan store at
 * `~/.claude/__exec-plans__/`: `/linear-plan` writes there from wherever the session happens to
 * be and `/linear-exec` reads it back from inside its worktree. `/tmp` and the scratchpad ride
 * the same clause. And an unconverted plain clone, where the container and the checkout are the
 * same directory, so no path can be inside one and outside the other.
 *
 * @packageDocumentation
 */

import { readlink, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { headBranch } from "./git";
import { isRunWorktree } from "./naming";
import { locate } from "./repo";

/**
 * Whether an edit may proceed, and why not when it may not.
 *
 * A discriminated union rather than a nullable reason, because the two answers are read by
 * wiring that has to *do* different things with them — exit 2 and print, or exit 0 and stay
 * silent — and a truthiness test on a message is how "allowed" and "blocked with an empty
 * explanation" become the same thing.
 */
export type Verdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * Where a session is working, as the caller knows it.
 *
 * Supplied rather than discovered — see this module's header. `checkout` is the checkout whose
 * files this session may write, which for a harness that relocates its session is its cwd and
 * for one that does not is the worktree root it was told about.
 */
export interface Session {
  /** The repository container: the parent of the git *common* dir, never of a checkout. */
  readonly container: string;

  /** Root of the checkout the session is working in. */
  readonly checkout: string;

  /** Branch that checkout holds, or `""` when it could not be named. */
  readonly branch: string;
}

/** Shared, since an allowed verdict carries nothing to distinguish one instance from another. */
const ALLOWED: Verdict = { allowed: true };

/** Whether `path` is `root` itself or lies beneath it. Both are already normalized. */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/**
 * The container-level directory `filePath` lands in, or `null` when it needs no verdict.
 *
 * Paths are normalized (`.`, `..`, duplicate separators) but **not** resolved through symlinks,
 * which is what keeps this pure; {@link guardEdit} does that pass before calling in.
 *
 * Takes the two paths rather than a whole {@link Session}, because the branch plays no part in
 * this half of the decision — and because that is what lets {@link guardEdit} ask this question
 * *before* paying for a branch lookup it usually turns out not to need.
 *
 * Exported rather than kept private because it is the question a harness's wiring wants on its
 * own: "would a verdict here even involve me?" is answerable with no git at all, and the Python
 * guard this consolidates exports its `target_checkout` for the same reason.
 *
 * @param filePath - The path the edit or write is aimed at.
 * @param container - The repository container.
 * @param checkout - Root of the checkout the session is working in.
 * @returns `null` whenever the existing rules already settle it — a relative path, one inside
 *   this checkout, or one outside the container entirely. Otherwise the container-level entry
 *   the target sits under, which is a sibling checkout only sometimes and may equally be
 *   `.bare`, a plain file, a directory that does not exist, or the container itself.
 */
export function targetCheckout(
  filePath: string,
  container: string,
  checkout: string,
): string | null {
  if (!isAbsolute(filePath)) return null;

  const target = resolve(filePath);
  if (isUnder(target, resolve(checkout))) return null;

  const root = resolve(container);
  if (!isUnder(target, root)) return null;

  const [entry] = relative(root, target).split(sep);
  return entry === undefined || entry === "" ? root : join(root, entry);
}

/**
 * Whether `filePath` may be written from `session`, given what the target's branch turned out
 * to be.
 *
 * Pure: no git, no filesystem, no clock. The facts it decides from are the three strings in
 * {@link Session} plus one more, which is what lets every layout this has to survive be pinned
 * in tests without one of them being built on disk.
 *
 * @param filePath - The path the edit or write is aimed at.
 * @param session - Where the session is working.
 * @param targetBranch - Branch held by the container-level directory the target lands in, or
 *   `""` when git could not name one — which is not a run worktree, so the block stands.
 * @returns Allowed, or blocked with the message the wiring should surface.
 */
export function verdict(filePath: string, session: Session, targetBranch: string): Verdict {
  const target = targetCheckout(filePath, session.container, session.checkout);
  if (target === null) return ALLOWED;

  const checkout = resolve(session.checkout);
  const sanctioned =
    !isRunWorktree(basename(checkout), session.branch) &&
    isRunWorktree(basename(target), targetBranch);
  if (sanctioned) return ALLOWED;

  return {
    allowed: false,
    reason:
      `Blocked: this session is working in ${checkout}, but ${filePath} is elsewhere in the ` +
      "repository container. Use a path relative to the working directory, or absolute under " +
      `${checkout}.`,
  };
}

/**
 * `filePath` as a path comparable with git's own answers: absolute, and through every symlink on
 * the way to it as well as one standing at it.
 *
 * The resolution is what stops macOS's `/tmp` → `/private/tmp` from defeating a match, since git
 * emits realpath-resolved paths and a target spelled the other way would land outside every
 * container and be allowed. Python's `Path.resolve()` — which the guard being consolidated uses —
 * resolves as far as it can and stops; `realpath(3)` has no such mode and rejects outright on
 * anything missing, so the three shapes the guard actually sees are taken in turn:
 *
 * 1. **The target exists.** `realpath` answers for it, including when it *is* a symlink into
 *    another checkout — the write follows that, so the guard must too.
 * 2. **The target does not exist but its parent does** — an ordinary `Write` creating a file.
 *    The parent resolves and the name is joined back on. If the name is a *dangling* symlink,
 *    `realpath` rejected in step 1 but the write would still land wherever it points, so the link
 *    is read and followed explicitly.
 * 3. **Neither exists.** Plain normalization.
 *
 * Two boundaries remain, and both fail *open* — they can only allow an edit the fully resolved
 * form would have caught, never block one it would have permitted. A chain of dangling symlinks
 * is followed one hop rather than to its end, and a write several directories deep into a tree
 * that is not there yet is compared unresolved.
 */
async function resolveTarget(filePath: string, cwd: string): Promise<string> {
  const absolute = resolve(cwd, filePath);

  const existing = await realpath(absolute).catch(() => null);
  if (existing !== null) return existing;

  const parent = await realpath(resolve(absolute, "..")).catch(() => null);
  if (parent === null) return absolute;

  const named = join(parent, basename(absolute));
  const dangling = await readlink(named).catch(() => null);

  return dangling === null ? named : resolve(parent, dangling);
}

/**
 * The decision itself, free to throw and free to hang — {@link guardEdit} owns both answers.
 *
 * Locates the session with {@link locate}, names both branches with {@link headBranch} — which
 * sees through a rebase in progress, so a worktree stopped on a conflict is still recognised as
 * one while the model edits it to resolve that conflict — and asks {@link verdict}.
 *
 * **Neither branch is looked up until {@link targetCheckout} says a verdict is needed**, which is
 * the whole reason it takes paths rather than a {@link Session}. The overwhelmingly common call —
 * an edit inside the session's own checkout — is settled by two concurrent `rev-parse` probes and
 * string comparison, with no branch lookup at all; only a path that actually crosses pays for the
 * two, and it pays for them concurrently.
 */
async function decide(filePath: string, cwd: string): Promise<Verdict> {
  const where = await locate(cwd);
  if (where.kind !== "checkout") return ALLOWED;

  const target = await resolveTarget(filePath, cwd);
  const sibling = targetCheckout(target, where.container, where.root);
  if (sibling === null) return ALLOWED;

  // Caught here, not by the outer handler: that one allows, which is right for the session's own
  // lookup but not for the target's, whose failure must keep the block. A target that is not a
  // directory makes git fail to start, which is the ordinary way that arrives.
  const [branch, targetBranch] = await Promise.all([
    headBranch(where.root).catch(() => null),
    headBranch(sibling).catch(() => null),
  ]);
  const session: Session = {
    container: where.container,
    checkout: where.root,
    branch: branch ?? "",
  };

  return verdict(target, session, targetBranch ?? "");
}

/**
 * Ceiling on one decision, after which the edit is allowed unread.
 *
 * The failure this closes is not an exception but a *wait*: a contended `index.lock`, a stalled
 * network filesystem, a git that never returns. Nothing above would throw, so the fail-open
 * handler never fires — the promise simply does not settle, the harness's hook never answers, and
 * the session is wedged with no way out. That is the same outcome blocking on a bug would have,
 * reached along the one axis a `try`/`catch` cannot see, so it gets the same answer.
 *
 * Five seconds because that is what `guard_worktree_edits.py` caps each of its git calls at, for
 * this reason in those words. It is a ceiling on the whole decision rather than per call, which is
 * the stricter reading and bounds anything a later change adds inside it.
 */
const DEADLINE_MS = 5000;

/**
 * {@link verdict}, with the facts resolved from disk.
 *
 * **Every failure answers allowed**, including one this module did not anticipate and including a
 * decision that simply takes too long ({@link DEADLINE_MS}): it is called before every file write,
 * and blocking on its own bug would wedge a session with no way out. Only a decision reached in
 * full can block.
 *
 * @param filePath - The path the edit or write is aimed at. A relative one is resolved against
 *   `cwd`, exactly as the harness's own tool would resolve it.
 * @param cwd - The session's working directory — not its checkout root, which {@link locate}
 *   derives from it. Defaults to this process's cwd.
 * @returns Allowed, or blocked with the message the wiring should surface. Never throws.
 */
export async function guardEdit(filePath: string, cwd?: string): Promise<Verdict> {
  if (filePath === "") return ALLOWED;

  const stalled = new Promise<Verdict>((settle) => {
    setTimeout(() => settle(ALLOWED), DEADLINE_MS).unref();
  });

  return Promise.race([decide(filePath, cwd ?? process.cwd()).catch(() => ALLOWED), stalled]);
}
