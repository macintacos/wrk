/**
 * The advisory mutex `wrk` serialises cross-process work with.
 *
 * One `mkdir` is the whole mechanism, and it is deliberately the whole mechanism: a bare
 * non-recursive `mkdir` is a single syscall that either creates the directory or fails
 * `EEXIST`, so an arbitrary number of processes arriving together agree on a single winner
 * with nothing to coordinate and no daemon to be running. There is no `flock` in
 * `node:fs/promises` to reach for instead, and a lock file written and read back would be a
 * check-then-act that this is not.
 *
 * **Two callers want opposite things from a contended lock**, which is why there are two
 * entry points rather than one. {@link cached} in `./cache` has previous contents to serve,
 * so a loser should not wait at all — it takes {@link claim}, reads the answer, and returns
 * stale text. {@link preflight} in `./preflight` has nothing to serve and must not proceed,
 * so it takes {@link withLock}, which waits. The protocol underneath is the same one.
 *
 * **A lock needs a bound, or a process killed mid-work wedges its resource forever** —
 * strictly worse than the contention the lock exists to stop, because the contention is
 * occasional and the wedge is permanent. {@link LOCK_STALE_MS} is that bound, and it is also
 * what caps {@link withLock}'s wait: a waiter that has watched a lock go stale steps past it
 * rather than growing a timeout of its own.
 *
 * Built on `node:fs/promises` rather than `Bun.file`, for the reason `proc.ts` gives: the
 * published artifact targets Node.
 *
 * @packageDocumentation
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

/** How long a lock may be held before it is assumed to belong to a process that died. */
export const LOCK_STALE_MS = 60_000;

/**
 * How long {@link withLock} sleeps between attempts on a contended lock.
 *
 * Polling rather than watching: `fs.watch` would need a watcher, an event handler and a
 * teardown to answer a question one `mkdir` already answers, and the work these locks guard
 * runs for hundreds of milliseconds at least, so an interval well below that costs nothing
 * anyone can observe.
 */
const POLL_MS = 50;

/**
 * What {@link claim} found.
 *
 * `held` and `abandoned` both mean "go ahead, and clear the lock afterwards"; they are
 * distinguished only because the second is the accepted ceiling and reads as one at the
 * call site. `lost` means someone else holds it.
 */
export type Claim = "held" | "lost" | "abandoned";

/**
 * Takes the lock, or reports who else has a claim on it.
 *
 * **Non-blocking**: a caller with something to fall back on reads the answer and moves on.
 * {@link withLock} is the waiting form.
 *
 * A lock older than {@link LOCK_STALE_MS} is treated as `abandoned`: **ignored, not broken.**
 * Breaking it would need a protocol of its own, because deleting it and re-creating it is a
 * check-then-act split across two syscalls — two callers can both delete, both create, both
 * believe they won, and then each remove the other's lock on the way out. Ignoring needs no
 * protocol, and degrades to something both callers already accept: for one burst, a resource
 * with an abandoned lock behaves as though it had no lock at all. Every caller in that burst
 * clears the lock as it leaves, so the next one locks normally.
 *
 * `ENOENT` — the lock's parent directory vanished under us — is `abandoned` rather than a
 * fault: there is nothing to lock. Any other failure propagates rather than degrading to an
 * unlocked run, because a permanently unwritable directory would otherwise serialise nothing
 * forever with no signal anywhere, which is the one outcome worse than the race.
 *
 * @param lock - Path the lock directory should occupy. Its parent must already exist; the
 *   `mkdir` is deliberately not recursive, since `mkdir -p` on an existing path succeeds and
 *   would hand the lock to everyone.
 * @returns Whether this call may proceed, and whether it owns the lock's removal.
 * @throws If the lock cannot be created for a reason other than already existing or its
 * parent having gone away.
 */
// ponytail: an abandoned lock is ignored rather than broken, so a burst arriving on one
// runs in full before the next burst locks again. Give the lock a real break-and-take
// protocol only if abandoned locks stop being rare.
export async function claim(lock: string): Promise<Claim> {
  try {
    await mkdir(lock);

    return "held";
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT") return "abandoned";
    if (code !== "EEXIST") throw error;
  }

  // A lock that vanished between those two calls counts as someone else's: `lost` costs one
  // more poll, and racing to re-create it is the check-then-act above in miniature.
  const existing = await stat(lock).catch(() => null);
  if (existing === null || Date.now() - existing.mtimeMs < LOCK_STALE_MS) return "lost";

  return "abandoned";
}

/**
 * Runs `work` with the lock held, waiting for whoever has it.
 *
 * The blocking form of {@link claim}, for a caller with no answer to give while it waits.
 *
 * **The wait is already bounded and takes no timeout of its own.** A holder that is alive
 * releases and the waiter proceeds; a holder that died leaves a lock that goes stale, which
 * {@link claim} reports as `abandoned` — so the longest any caller waits is
 * {@link LOCK_STALE_MS}, and it then proceeds rather than failing. Adding a timeout on top
 * would only convert a bounded wait into an error the caller has no better answer for.
 *
 * The release is a `finally` and its failure is swallowed, for the reasons `cache.ts` gives
 * at its own release: a throw from a `finally` replaces whatever the block was returning, so
 * a failed cleanup would discard work that had already succeeded — and `force: true` does not
 * make `rm` infallible on Bun, where concurrent removal of one directory can reject
 * `EFAULT`, which an abandoned lock produces by design.
 *
 * @param lock - Path the lock directory should occupy. Its parent must already exist.
 * @param work - What to run while holding it. Called exactly once.
 * @returns Whatever `work` returned.
 * @throws Whatever `work` threw, with the lock released first; or whatever {@link claim}
 * threw, in which case `work` never ran and there is nothing to release.
 *
 * @example
 * ```ts
 * await withLock(join(container, ".wrk-sync.lock"), async () => {
 *   await syncDefaultBranch(root, defaultBranch, branch);
 * });
 * ```
 */
export async function withLock<T>(lock: string, work: () => Promise<T>): Promise<T> {
  while ((await claim(lock)) === "lost") {
    await sleep(POLL_MS);
  }

  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}
