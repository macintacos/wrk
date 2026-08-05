/**
 * The on-disk cache every other `wrk` cache is built from.
 *
 * `wrk` shells out to `gh` and `git` constantly, and a prompt or a picker cannot afford to
 * wait on the network each time it draws. Everything expensive is therefore memoised to a
 * file, aged by that file's mtime, and refreshed through this module. What it stores is
 * text: callers that need structure serialise it themselves, because a cache that also
 * owns a format is two decisions welded together and the format is always the one that
 * changes.
 *
 * That is also why there is no schema-aware read here, unlike `config.ts` and the worktree
 * porcelain in `git.ts`, where a Zod schema owns the boundary. Nothing deserialises a cache
 * entry yet — there is no caller to design the seam against, and a `cachedJson(key, schema,
 * …)` invented before the first one would be guessing at what it needs. It is a real
 * boundary and it will want one; the shape belongs to whoever brings the first consumer.
 *
 * Three properties make it safe to point a shell prompt at:
 *
 * - **Atomic replacement.** A refresh stages to a per-process temp file and `rename`s it
 *   into place, so a reader sees the whole previous value or the whole new one — never a
 *   truncated write, and never an empty file where a failed refresh got half-way.
 * - **Failure keeps the old answer.** A refresh that throws leaves the entry exactly as it
 *   was and its previous contents are returned. Stale data beats no data for everything
 *   cached here.
 * - **Touch-debounce.** A burst of invocations — a shell that redraws its prompt three
 *   times in a second — starts one refresh, not one each.
 *
 * The root is XDG's, resolved by hand. `conf` and `env-paths` both answer
 * `~/Library/Caches` on macOS, which would quietly move the cache off the path the rest of
 * the toolchain looks in, so neither is used.
 *
 * Built on `node:fs/promises` rather than `Bun.file`, for the reason `proc.ts` gives: the
 * published artifact targets Node.
 *
 * @packageDocumentation
 */

import { mkdir, open, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { cacheSlug } from "./naming";

/**
 * Directory under the XDG cache root that everything here lives in.
 *
 * Without it, each repository's cache directory would sit loose in the user's shared cache
 * root under a name like `_Users_me_GitLocal_thing`, with nothing saying which tool owns it
 * and no way to clear `wrk`'s cache short of picking those out by hand.
 */
const NAMESPACE = "wrk";

/** Identifies one cache entry. */
export interface CacheKey {
  /** Entry name within the per-repo directory, e.g. `"pr-graph"`. */
  name: string;

  /**
   * Absolute path of the repository container this entry belongs to.
   *
   * Caches are per-repository, and the container path is the identity that survives a
   * worktree being created or removed underneath it.
   */
  container: string;

  /**
   * Cache root, overriding the XDG default.
   *
   * Present so a test can point a whole cache at a temp directory in one field rather than
   * mutating `XDG_CACHE_HOME` in a shared process.
   */
  root?: string;
}

/** An entry's contents alongside the mtime staleness is measured against. */
interface CacheEntry {
  text: string;
  mtimeMs: number;
}

/**
 * Distinguishes staging files written by this process.
 *
 * The pid alone is not enough: two overlapping writes to one key inside a single process
 * would share a staging path, so the first rename publishes the second's bytes and the
 * second fails with `ENOENT` — leaving a caller whose promise resolved with something other
 * than what reached disk.
 */
let staged = 0;

/**
 * Resolves the XDG cache root.
 *
 * Two rejections of `XDG_CACHE_HOME` are deliberate. An **empty** value is treated as
 * unset, because an exported-but-empty variable is how a shell says "unset" in practice and
 * `join("", …)` would silently yield a path relative to the cwd. A **relative** value is
 * likewise ignored, which the XDG base directory specification requires outright — and
 * which matters more here than in most programs, since `wrk` runs from wherever the user
 * happens to be standing, so a relative root would scatter cache directories across the
 * filesystem.
 */
function defaultRoot(): string {
  const configured = process.env.XDG_CACHE_HOME;
  const base = configured && isAbsolute(configured) ? configured : join(homedir(), ".cache");

  return join(base, NAMESPACE);
}

/**
 * Locates an entry on disk.
 *
 * Both segments go through {@link cacheSlug} rather than being interpolated: it is the
 * single definition of "reduce an arbitrary key to one inert path segment", and it is what
 * stops a container of `..` — or any key carrying a separator — from resolving somewhere
 * other than inside the cache root. A second sanitiser written here is exactly the drift
 * that module exists to prevent.
 *
 * @param key - The entry to locate.
 * @returns The absolute path of that entry, whether or not it exists.
 */
export function cachePath(key: CacheKey): string {
  return join(key.root ?? defaultRoot(), cacheSlug(key.container), cacheSlug(key.name));
}

/**
 * Reads an entry's contents and mtime through a single file handle.
 *
 * One handle rather than a separate `stat` and `readFile`: both answers then describe the
 * inode this handle was opened on, so a concurrent {@link writeCache} renaming a new entry
 * into place mid-read cannot pair one file's mtime with another file's text. Reading the
 * two through the path instead leaves that window open, and a fresh mtime beside stale text
 * is the one combination that defeats the staleness check silently.
 *
 * A missing entry is `null`. Any other failure propagates, because an unreadable cache
 * directory is a real fault and reporting it as a miss would turn it into an unexplained
 * refresh on every single invocation.
 */
async function readEntry(path: string): Promise<CacheEntry | null> {
  const handle = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (handle === null) return null;

  try {
    const [stats, text] = await Promise.all([handle.stat(), handle.readFile("utf8")]);

    return { text, mtimeMs: stats.mtimeMs };
  } finally {
    await handle.close();
  }
}

/** How long a lock may be held before it is assumed to belong to a process that died. */
const LOCK_STALE_MS = 60_000;

/**
 * Takes the refresh lock for an entry, or reports that someone else holds it.
 *
 * A bare `mkdir` — no `recursive` — is the whole mechanism. It is one syscall that either
 * creates the directory or fails `EEXIST`, so an arbitrary number of processes arriving
 * together agree on a single winner with nothing to coordinate and no state to clean up
 * beyond the directory itself. It is the same move {@link writeCache} makes with `rename`:
 * lean on one atomic call rather than assemble the guarantee in userspace.
 *
 * A lock also needs a bound. Without one, a process killed mid-refresh wedges the entry
 * into serving stale contents forever — strictly worse than the duplicated refresh this
 * exists to stop. A lock older than {@link LOCK_STALE_MS} is therefore treated as
 * abandoned, reaped, and re-claimed once.
 *
 * A failure that is not `EEXIST` propagates rather than degrading to an unlocked refresh.
 * A permanently unwritable cache directory would otherwise serve stale contents forever
 * with no signal anywhere, which is the one outcome worse than the race. The retry after
 * a reap is the exception: losing there means "serve stale", which is the safe direction.
 *
 * @param lock - Path the lock directory should occupy. Its parent must already exist,
 * which is why {@link cached} only reaches here when the entry does.
 * @returns `true` when this call holds the lock and must release it.
 * @throws If the lock cannot be created for any reason other than already existing.
 */
// ponytail: the lock's mtime is stamped once at creation and never renewed, so a refresh
// running longer than LOCK_STALE_MS has its lock reaped and a second one starts. Renew it
// from inside the refresh if a slow `gh` ever makes that common.
async function claim(lock: string): Promise<boolean> {
  try {
    await mkdir(lock);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const held = await stat(lock).catch(() => null);
  if (held === null || Date.now() - held.mtimeMs < LOCK_STALE_MS) return false;

  await rm(lock, { recursive: true, force: true });

  return await mkdir(lock).then(
    () => true,
    () => false,
  );
}

/**
 * Stamps an entry's mtime to now, so a refresh that failed is not retried immediately.
 *
 * The half of the debounce {@link claim} cannot cover. The lock serialises refreshes that
 * overlap in time and is released as soon as one finishes; the stamp is what outlives a
 * refresh that *failed*, leaving the entry reading fresh for a full TTL rather than
 * retried by every invocation until it succeeds.
 *
 * Failures are swallowed. The cost of a missed touch is one duplicated refresh — the same
 * thing that happens on a cold start by design — which is never worth failing a cache read
 * over.
 */
// ponytail: refreshes of an existing entry are serialised, but a cold start is not — it
// has no entry to serve a loser, so making one wait would trade a duplicated refresh for a
// stall. Have losers wait on the lock and re-read if a cold stampede ever costs more.
async function touch(path: string): Promise<void> {
  const now = new Date();

  try {
    await utimes(path, now, now);
  } catch {
    // Best-effort by construction; see above.
  }
}

/**
 * Reads an entry regardless of its age.
 *
 * Staleness is {@link cached}'s concern, not this function's — a caller reaching for this
 * one wants whatever is on disk.
 *
 * @param key - The entry to read.
 * @returns The entry's contents, or `null` when it does not exist.
 */
export async function readCache(key: CacheKey): Promise<string | null> {
  return (await readEntry(cachePath(key)))?.text ?? null;
}

/**
 * Replaces an entry atomically.
 *
 * The value is written to `<entry>.<pid>.tmp` and `rename`d over the entry. `rename(2)`
 * within a directory is atomic, so a concurrent reader observes either the whole old value
 * or the whole new one, and a write that dies part-way never reaches the rename at all —
 * which is what makes a failed refresh leave the previous cache intact rather than
 * truncated. The pid in the staging name keeps two concurrent processes from writing over
 * each other's half-built file.
 *
 * The staging name is unique per write, not merely per process: the pid keeps two processes
 * apart, and a counter keeps two overlapping writes within one process apart. With only the
 * pid, concurrent writes to one key share a staging file and one caller's promise resolves
 * having published the other's bytes.
 *
 * The per-repo directory is created on demand, so a first-ever write needs no setup.
 *
 * @param key - The entry to replace.
 * @param value - The contents to store.
 * @throws If the directory cannot be created, or the write or rename fails. The staging
 * file is removed first, so a failure leaves no debris beside the entry.
 */
// ponytail: a process killed between the write and the rename leaves its staging file
// behind, and nothing reaps them. Sweep `*.tmp` older than a day here if they ever pile up.
export async function writeCache(key: CacheKey, value: string): Promise<void> {
  const path = cachePath(key);
  await mkdir(dirname(path), { recursive: true });

  const staging = `${path}.${process.pid}.${staged++}.tmp`;
  try {
    await writeFile(staging, value, "utf8");
    await rename(staging, path);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
}

/**
 * Reads an entry, refreshing it through `refresh` when it is older than `ttl`.
 *
 * The read-through every caller should reach for first. A fresh entry is returned without
 * `refresh` being called at all; a stale or missing one is refreshed and the result stored
 * atomically.
 *
 * **A failing `refresh` is absorbed when there is anything to fall back on.** Its rejection
 * is discarded and the previous contents returned, because every consumer of this module
 * renders something a user is looking at — a prompt, a picker, a preview — and a stale PR
 * list beats an error where the list should be. With no previous entry there is nothing to
 * serve, so the rejection propagates.
 *
 * **Refreshing an existing entry is serialised**, by {@link claim}, across processes as
 * well as within one. The mtime stamp cannot do this by itself: reading it and writing it
 * are two calls, so a burst that starts in the same instant all reads the old value and
 * all refreshes — precisely the stampede the debounce exists to collapse. Callers that
 * lose the lock serve the previous contents, which is what they would have served while
 * waiting anyway.
 *
 * Two consequences are accepted rather than engineered around:
 *
 * - **A cold start does not debounce.** `utimes` cannot create a file, so a missing entry
 *   has no mtime to stamp and there is nothing to claim the window with. The lock is not
 *   taken there either: with no previous contents there is nothing to hand a loser, so
 *   making one wait would trade a duplicated refresh for a stall. Staking the claim by
 *   writing the entry early would fix that and cost far more: a concurrent reader would
 *   be handed `""` as a valid value, which is a wrong answer rather than a slow one. So
 *   both callers refresh and both rename; the later write wins, and either value is whole.
 * - **A failed refresh still spends the touch**, leaving stale contents served for a full
 *   TTL rather than retried immediately. That is the wanted behaviour against a flaky
 *   `gh`: restoring the mtime on failure would reinstate the stampede the debounce exists
 *   to stop, on the slowest path there is.
 *
 * @param key - The entry to read.
 * @param ttl - Milliseconds after which the entry is stale.
 * @param refresh - Produces the new contents. Called only when the entry is stale or
 * missing, and at most once per call.
 * @returns The fresh contents, or the previous contents when `refresh` fails.
 * @throws Whatever `refresh` threw, when there was no previous entry to fall back on; or
 * whatever {@link writeCache} or {@link claim} threw. Only `refresh` gets the
 * stale-contents fallback — a cache that cannot be written is a fault worth surfacing, and
 * discarding a good refresh because it could not be stored would serve stale text the
 * caller had already paid to replace.
 *
 * @example
 * ```ts
 * const prs = await cached({ name: "pr-graph", container }, 300_000, async () => {
 *   const { stdout } = await run("gh", ["pr", "list", "--json", "number,headRefName"]);
 *   return stdout;
 * });
 * ```
 */
export async function cached(
  key: CacheKey,
  ttl: number,
  refresh: () => Promise<string>,
): Promise<string> {
  const path = cachePath(key);
  const entry = await readEntry(path);

  if (entry && Date.now() - entry.mtimeMs < ttl) {
    return entry.text;
  }

  // Only with an entry in hand: `claim` needs the per-repo directory to already exist, and
  // a loser needs something to be served. Both are the same condition.
  const lock = `${path}.lock`;
  const held = entry !== null && (await claim(lock));
  if (entry && !held) {
    return entry.text;
  }

  try {
    if (entry) {
      await touch(path);
    }

    let value: string;
    try {
      value = await refresh();
    } catch (error) {
      if (entry) {
        return entry.text;
      }
      throw error;
    }

    // Outside the inner `try` on purpose: only `refresh` gets the stale-contents fallback.
    await writeCache(key, value);

    return value;
  } finally {
    if (held) {
      await rm(lock, { recursive: true, force: true });
    }
  }
}
