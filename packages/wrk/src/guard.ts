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

import { realpath } from "node:fs/promises";
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
 * @param filePath - The path the edit or write is aimed at.
 * @param session - Where the session is working.
 * @returns `null` whenever the existing rules already settle it — a relative path, one inside
 *   this checkout, or one outside the container entirely. Otherwise the container-level entry
 *   the target sits under, which is a sibling checkout only sometimes and may equally be
 *   `.bare`, a plain file, a directory that does not exist, or the container itself.
 */
export function targetCheckout(filePath: string, session: Session): string | null {
  if (!isAbsolute(filePath)) return null;

  const target = resolve(filePath);
  if (isUnder(target, resolve(session.checkout))) return null;

  const container = resolve(session.container);
  if (!isUnder(target, container)) return null;

  const [entry] = relative(container, target).split(sep);
  return entry === undefined || entry === "" ? container : join(container, entry);
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
  const target = targetCheckout(filePath, session);
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
      "repository container. Use a path relative to that checkout, or absolute under its root.",
  };
}

/**
 * `filePath` as a path comparable with git's own answers: absolute, and through any symlink.
 *
 * The resolution is what stops macOS's `/tmp` → `/private/tmp` from defeating a match, since
 * git emits realpath-resolved paths and a target spelled the other way would land outside every
 * container and be allowed. Only the *parent* is resolved, because the target itself routinely
 * does not exist yet — a `Write` creating a file is the ordinary case — and a `realpath` on a
 * missing path rejects rather than answering as far as it can.
 *
 * A parent that does not exist either falls back to plain normalization. That is the honest
 * boundary of this pass: a write several directories deep into a tree that is not there yet is
 * compared unresolved, which can only ever *allow* an edit the resolved form would have caught.
 */
async function resolveTarget(filePath: string, cwd: string): Promise<string> {
  const absolute = resolve(cwd, filePath);
  const parent = resolve(absolute, "..");

  return realpath(parent).then(
    (real) => join(real, basename(absolute)),
    () => absolute,
  );
}

/**
 * {@link verdict}, with the facts resolved from disk.
 *
 * Locates the session with {@link locate}, names both branches with {@link headBranch} — which
 * sees through a rebase in progress, so a worktree stopped on a conflict is still recognised as
 * one while the model edits it to resolve that conflict — and asks {@link verdict}.
 *
 * The target's branch is only looked up once {@link targetCheckout} has said a verdict is
 * needed, so the ordinary edit inside the session's own checkout costs the session lookup and
 * nothing more.
 *
 * **Every failure here answers allowed**, including one this module did not anticipate: it is
 * called before every file write, and blocking on its own bug would wedge a session with no way
 * out. Only a decision reached in full can block.
 *
 * @param filePath - The path the edit or write is aimed at. Relative paths are resolved against
 *   `cwd`, which is what a harness that never relocates its session hands over.
 * @param cwd - Where the session is working. Defaults to this process's cwd.
 * @returns Allowed, or blocked with the message the wiring should surface. Never throws.
 */
export async function guardEdit(filePath: string, cwd?: string): Promise<Verdict> {
  if (filePath === "") return ALLOWED;

  try {
    const where = await locate(cwd);
    if (where.kind !== "checkout") return ALLOWED;

    const session: Session = {
      container: where.container,
      checkout: where.root,
      branch: (await headBranch(where.root)) ?? "",
    };

    const target = await resolveTarget(filePath, where.root);
    const sibling = targetCheckout(target, session);
    if (sibling === null) return ALLOWED;

    // Caught here rather than by the outer handler, which would answer allowed: this is the
    // lookup whose failure must *keep* the block. A target that is not a directory at all makes
    // git fail to even start, which is the ordinary way this arrives.
    const targetBranch = await headBranch(sibling).catch(() => null);

    return verdict(target, session, targetBranch ?? "");
  } catch {
    return ALLOWED;
  }
}
