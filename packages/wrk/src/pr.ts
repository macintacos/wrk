/**
 * The one pull-request cache everything downstream reads.
 *
 * It replaces the two caches the fish implementation keeps — different TTLs, different column
 * orders, the same upstream data, keyed identically — with a single entry per repository
 * container, so the prompt, the picker and the stack walk cannot disagree about which pull
 * request a branch belongs to. Layered on {@link cached} from [`./cache`](./cache), which owns
 * atomic replacement, the single-flight refresh and the stale-contents fallback, and on
 * [`./gh`](./gh), which owns everything about how `gh` is spelled. This module owns exactly
 * two decisions of its own: **what is stored**, and **who wins when one head ref carries more
 * than one pull request**.
 *
 * **The head ref is the key**, so the answer is a `Map` rather than a list — every consumer
 * joins on the branch it is standing in, and returning rows would leave each of them to
 * re-derive the same index and disagree about the dedupe while doing it.
 *
 * **The stored format is JSON.** The tab-separated file this replaces interpolated a pull
 * request title straight into a column, so one title holding a tab or a newline desynced every
 * column after it — for every reader, until the entry expired. A title is free text and this
 * is not hypothetical. Rows go out through `JSON.stringify` and come back through
 * {@link PULL_REQUEST}, the schema `gh.ts` already parses `gh`'s own output with, so the
 * on-disk shape cannot drift from the query that produced it. Text that will not parse is
 * treated as no data rather than thrown: a corrupt or older-format entry costs a picker its
 * rows, where an exception would cost it the whole draw.
 *
 * **Only the open query gates the write.** Both run concurrently; a merged query that *could
 * not answer* costs merged branches their marker for one TTL, which is a marker missing from
 * rows that are drawn anyway. An open query that could not answer aborts the write entirely,
 * because the open set *is* the graph and replacing a good one with an empty one is a wrong
 * answer rather than a thin one. Aborting is spelled as a throw out of the refresh callback,
 * which is the lever {@link cached} offers: it discards the rejection, leaves the entry
 * untouched and serves the previous contents. A query that answers *unreadably* is not a
 * refusal at all — it is a `gh` whose JSON shape has changed — so it propagates like any other
 * fault, from either state, per `gh.ts`'s own fault/answer split.
 *
 * **The container is also the directory `gh` runs in**, which is what keeps the answer and the
 * key it is filed under describing the same repository. A container is a real directory with a
 * `.git` file pointing at its bare repository, so `gh` resolves the remote from it exactly as
 * it would from a checkout; a separate run directory would be one more thing a caller could
 * get wrong, and getting it wrong would file one repository's pull requests under another's
 * key, on a shared on-disk cache, for a full TTL.
 *
 * **Nothing here resolves a repository or reads configuration.** The container arrives as a
 * parameter, as it does in `cache.ts` and `config.ts`, and so does the TTL — `cached` takes it
 * positionally and this module is a layer over that call, so a caller that has already loaded
 * `WrkConfig` passes `cache.ttls["pr-graph"]` and one that has not passes whatever it likes.
 *
 * **This module is also a script, and that is what keeps `gh` off the critical path.** With
 * {@link PullRequestOptions.background} set, {@link pullRequests} answers from the stored entry
 * immediately and starts the refresh in a process nobody is waiting on. Nothing smaller works:
 * an in-process refresh that is merely not awaited is abandoned the moment the event loop
 * drains, so the entry never lands, and a shell waits on the *process* rather than on a
 * promise. The child is this process's own runtime re-run on this module's own path —
 * `process.execPath` and `import.meta.url`, neither of them guessed — which makes it exactly as
 * runnable as whatever loaded this module, with no file extension baked into a spawn and no
 * dependence on `process.argv[1]`, which names the test runner under `bun test` rather than the
 * CLI. `cli.ts`'s `import.meta.main` guard is the same idiom; the worker is at the bottom of
 * this file.
 *
 * @packageDocumentation
 */

import { fileURLToPath } from "node:url";

import { z } from "zod";

import { cached, cachedBehind } from "./cache";
import { listPullRequests, PULL_REQUEST, type PullRequest } from "./gh";
import { debug } from "./output";
import { detach } from "./proc";

/**
 * The cache entry every repository's graph is stored under.
 *
 * The name is also a public contract: `config.ts`'s `DEFAULTS.cache.ttls` carries this key, so
 * a user configuring `cache.ttls."pr-graph"` is configuring this entry. Renaming it silently
 * detaches every configured TTL from the cache it was written for, which is why `pr.test.ts`
 * spells the literal out rather than importing it.
 */
const ENTRY = "pr-graph";

/** The stored document: the deduplicated rows, in no significant order. */
const ROWS = z.array(PULL_REQUEST);

/**
 * Thrown out of the refresh when `gh` could not answer about **open** pull requests.
 *
 * Private, and never printed. It exists because a throw is the only way to tell {@link cached}
 * not to write, and it is a type of its own so that {@link pullRequests} can absorb exactly
 * this case while a genuine fault — an unwritable cache directory, a `gh` whose JSON shape has
 * changed — still propagates. It escapes `cached` only on a cold start, since an entry that
 * already exists is served instead.
 */
class Unavailable extends Error {}

/**
 * The staleness threshold the detached worker refreshes at: nothing is ever fresher than it.
 *
 * Deliberately **not** `0`. {@link cached} asks whether `Date.now() - stats.mtimeMs < ttl`, and
 * `Date.now()` is whole milliseconds while `mtimeMs` is not — so at `0` an entry written in the
 * same millisecond compares as *fresh* and the refresh is skipped. Reaching the worker at all
 * means the parent has just stamped the entry on its way past, so `0` would be relying on the
 * child's own start-up to take more than a millisecond. The failure that buys is the invisible
 * one this whole path exists to avoid: the worker does nothing, the entry never lands, and
 * every consumer keeps drawing the stale graph with nothing anywhere saying why.
 */
const FORCED = Number.NEGATIVE_INFINITY;

/** Options for {@link pullRequests}. */
export interface PullRequestOptions {
  /**
   * Cache root, overriding the XDG default.
   *
   * Present so a test can point a whole cache at a temp directory in one field rather than
   * mutating `XDG_CACHE_HOME` in a shared process — the seam `CacheKey.root` is.
   */
  root?: string;

  /**
   * Answer from the stored entry and refresh it in a detached process, rather than waiting.
   *
   * For anything drawing on a keystroke — a prompt, a picker — where a stale graph now beats a
   * fresh one in three seconds. A **cold** cache is unaffected: with nothing stored there is
   * nothing to draw, so the call falls through to the waiting path and pays for the first
   * answer once, rather than returning an empty map that a caller could not tell apart from a
   * repository with no pull requests.
   */
  background?: boolean;
}

/**
 * Whether `candidate` should displace `incumbent` as the pull request for their shared head ref.
 *
 * The rule, in full: an **open** pull request beats a merged one; within a state the later
 * `updatedAt` wins; and a remaining tie goes to the higher number. The third clause is what
 * makes the ordering **total**, which is the point — with only the first two, two rows agreeing
 * on state and timestamp would be separated by nothing but which one the fold happened to see
 * first, and the answer would depend on the order `gh` returned rows in.
 *
 * `updatedAt` is compared as a string, which is exact rather than convenient:
 * {@link PullRequest.updatedAt} is pinned to second-precision UTC, so byte order is
 * chronological order and no date is parsed to find that out.
 */
function beats(candidate: PullRequest, incumbent: PullRequest): boolean {
  if (candidate.state !== incumbent.state) return candidate.state === "OPEN";
  if (candidate.updatedAt !== incumbent.updatedAt) return candidate.updatedAt > incumbent.updatedAt;

  return candidate.number > incumbent.number;
}

/**
 * Folds rows into one pull request per head ref, by {@link beats}.
 *
 * Used on both sides — building the value to store, and rebuilding the map from what was
 * stored — because they are the same operation. The second call is a formality against an entry
 * this module wrote, and the guarantee that an entry it did not write cannot produce a map with
 * a head ref resolved by nothing but position.
 */
function dedupe(rows: readonly PullRequest[]): Map<string, PullRequest> {
  const graph = new Map<string, PullRequest>();

  for (const row of rows) {
    const incumbent = graph.get(row.headRefName);
    if (incumbent === undefined || beats(row, incumbent)) {
      graph.set(row.headRefName, row);
    }
  }

  return graph;
}

/**
 * Queries both states and renders the entry's new contents.
 *
 * @param container - The repository container, which `gh` runs in — see this module's header
 * for why the key and the run directory are the same value.
 * @returns The deduplicated rows as JSON.
 * @throws {Unavailable} If `gh` could not answer about open pull requests — see this module's
 * header for why only that half gates the write.
 */
async function collect(container: string): Promise<string> {
  const [open, merged] = await Promise.all([
    listPullRequests("OPEN", container),
    listPullRequests("MERGED", container),
  ]);
  if (open === null) throw new Unavailable();

  return JSON.stringify([...dedupe([...open, ...(merged ?? [])]).values()]);
}

/**
 * Reads what was stored, or an empty map when it cannot be read.
 *
 * Two failures land on one answer: the `try` catches text that is not JSON, and `safeParse`
 * reports JSON that is not these rows as a flag. Neither is worth an exception on a path that
 * exists to keep a prompt drawing, and a caller could do nothing different about them anyway.
 */
function parse(text: string): Map<string, PullRequest> {
  try {
    const rows = ROWS.safeParse(JSON.parse(text));

    return rows.success ? dedupe(rows.data) : new Map();
  } catch {
    return new Map();
  }
}

/**
 * Starts a detached refresh of this repository's entry, and says so under `WRK_DEBUG`.
 *
 * The argv is `[this module, container, root?]` — see this module's header for why the runtime
 * and the path are read off the running process rather than written down. `root` is passed
 * along rather than left to the child's own defaults because it decides *where* the answer
 * lands: a caller that pointed the cache somewhere and a worker that did not would refresh a
 * different file from the one the caller is reading, forever.
 *
 * The diagnostic is the only evidence this path leaves. Everything downstream of it — the rows,
 * the markers, the exit status — is identical whether the refresh happened or not, so a
 * regression here is silent by construction and a line naming the pid is what makes it
 * observable in the field rather than only under a debugger.
 */
function spawnRefresh(container: string, root?: string): void {
  const worker = fileURLToPath(import.meta.url);
  const pid = detach(process.execPath, [worker, container, ...(root === undefined ? [] : [root])]);

  debug(
    pid === undefined
      ? `${ENTRY} for ${container} is stale, but the background refresh could not be started`
      : `${ENTRY} for ${container} is stale; refreshing in the background as pid ${pid}`,
  );
}

/**
 * The repository's pull requests, keyed by head ref, refreshed through `gh` when stale.
 *
 * The read-through every consumer should reach for. A fresh entry is served without `gh` being
 * run at all; a stale or missing one is refreshed, deduplicated and stored atomically.
 *
 * **The wait is optional.** With {@link PullRequestOptions.background}, a stale entry is served
 * as it stands and the refresh runs in a detached process instead — everything below still
 * applies to it, one process later. Only a cold cache is unaffected, having nothing to serve.
 *
 * Note the TTL is spent on a *failed* refresh too, by {@link cached}'s design: a `gh` that
 * cannot answer is not retried until the entry goes stale again, which is what keeps a flaky
 * `gh` from being re-run by every prompt redraw. That needs an entry to stamp, so it does not
 * cover a cold cache — where `gh` has never answered, both queries run on every invocation,
 * per `cached`'s own note on why a cold start cannot debounce.
 *
 * @param container - Absolute path of the repository container the entry belongs to, and the
 * directory `gh` is run in.
 * @param ttl - Milliseconds after which the entry is stale.
 * @param options - See {@link PullRequestOptions}.
 * @returns One pull request per head ref. Empty when `gh` could not answer and nothing was
 * cached, and empty when the stored entry cannot be read — both are "nothing to draw" rather
 * than failures, per this module's header.
 * @throws Whatever {@link cached} threw. `gh` being unable to answer is not one of those: it
 * is either absorbed here or served from the previous entry.
 *
 * @example
 * ```ts
 * // The `??` is `noUncheckedIndexedAccess`, not a real absence: `loadConfig` seeds every key
 * // `DEFAULTS` carries, and this is one of them.
 * const prs = await pullRequests(container, config.cache.ttls["pr-graph"] ?? 900_000);
 * const mine = prs.get(await currentBranch());
 * ```
 */
export async function pullRequests(
  container: string,
  ttl: number,
  options: PullRequestOptions = {},
): Promise<Map<string, PullRequest>> {
  const key = { name: ENTRY, container, root: options.root };

  if (options.background === true) {
    const stored = await cachedBehind(key, ttl, () => spawnRefresh(container, options.root));
    if (stored !== null) return parse(stored);

    debug(`${ENTRY} for ${container} has nothing stored; refreshing in the foreground`);
  }

  try {
    return parse(await cached(key, ttl, () => collect(container)));
  } catch (error) {
    if (error instanceof Unavailable) return new Map();
    throw error;
  }
}

// The worker `spawnRefresh` starts, guarded so that importing this module runs nothing —
// `cli.ts`'s idiom. `FORCED` rather than the caller's TTL because the caller has just stamped
// the entry to debounce its siblings, and this process is the refresh that stamp was promising.
if (import.meta.main) {
  const [container, root] = process.argv.slice(2);
  if (container === undefined) {
    throw new Error("usage: pr.ts <container> [cache-root]");
  }

  await pullRequests(container, FORCED, { root });
}
