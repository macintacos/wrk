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
 * **Only the open query gates the write.** Both run concurrently; a merged query that fails
 * costs merged branches their marker for one TTL, which is a marker missing from rows that are
 * drawn anyway. An open query that fails aborts the write entirely, because the open set *is*
 * the graph and replacing a good one with an empty one is a wrong answer rather than a thin
 * one. Aborting is spelled as a throw out of the refresh callback, which is the lever
 * {@link cached} offers: it discards the rejection, leaves the entry untouched and serves the
 * previous contents.
 *
 * **Nothing here resolves a repository or reads configuration.** The container arrives as a
 * parameter, as it does in `cache.ts` and `config.ts`, and so does the TTL — `cached` takes it
 * positionally and this module is a layer over that call, so a caller that has already loaded
 * `WrkConfig` passes `cache.ttls["pr-graph"]` and one that has not passes whatever it likes.
 *
 * @packageDocumentation
 */

import { z } from "zod";

import { cached } from "./cache";
import { listPullRequests, PULL_REQUEST, type PullRequest } from "./gh";

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

/** Options for {@link pullRequests}. */
export interface PullRequestOptions {
  /**
   * Directory `gh` runs in, which is what decides the repository it answers about. Defaults to
   * this process's cwd.
   *
   * Separate from the container on purpose: the container is a bare-repo directory with no work
   * tree, so it is the cache's identity rather than somewhere `gh` can run.
   */
  cwd?: string;

  /**
   * Cache root, overriding the XDG default.
   *
   * Present so a test can point a whole cache at a temp directory in one field rather than
   * mutating `XDG_CACHE_HOME` in a shared process — the seam `CacheKey.root` is.
   */
  root?: string;
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
 * @param cwd - Directory `gh` runs in.
 * @returns The deduplicated rows as JSON.
 * @throws {Unavailable} If `gh` could not answer about open pull requests — see this module's
 * header for why only that half gates the write.
 */
async function collect(cwd?: string): Promise<string> {
  const [open, merged] = await Promise.all([
    listPullRequests("OPEN", cwd),
    listPullRequests("MERGED", cwd),
  ]);
  if (open === null) throw new Unavailable();

  return JSON.stringify([...dedupe([...open, ...(merged ?? [])]).values()]);
}

/**
 * Reads what was stored, or an empty map when it cannot be read.
 *
 * One `try` covers both failures — text that is not JSON, and JSON that is not these rows —
 * because a caller can do nothing different about them and neither is worth an exception on a
 * path that exists to keep a prompt drawing.
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
 * The repository's pull requests, keyed by head ref, refreshed through `gh` when stale.
 *
 * The read-through every consumer should reach for. A fresh entry is served without `gh` being
 * run at all; a stale or missing one is refreshed, deduplicated and stored atomically.
 *
 * Note the TTL is spent on a *failed* refresh too, by {@link cached}'s design: a `gh` that
 * cannot answer is not retried until the entry goes stale again, which is what keeps a flaky
 * or unauthenticated `gh` from being re-run by every prompt redraw.
 *
 * @param container - Absolute path of the repository container the entry belongs to.
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

  try {
    return parse(await cached(key, ttl, () => collect(options.cwd)));
  } catch (error) {
    if (error instanceof Unavailable) return new Map();
    throw error;
  }
}
