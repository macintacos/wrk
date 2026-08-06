/**
 * What the PR picker's preview pane displays.
 *
 * `gh` already renders a pull request beautifully — markdown as ANSI, wrapped to the terminal
 * it believes it is writing to. This module is the layer between that rendering and the pane:
 * it asks for the render at the pane's own width, remembers the answer, and says when to forget
 * it. It writes no markup of its own, and deliberately does not parse `gh`'s.
 *
 * Two modules do the actual work, and neither is modified here. [`./gh`](./gh)'s
 * {@link viewPullRequest} forces a TTY at a requested width, empties `GH_PAGER` so the forced
 * render cannot start a pager and wait on a keystroke, and hands back both of `gh`'s streams
 * concatenated. [`./cache`](./cache)'s {@link cached} stores the result atomically, ages it by
 * mtime, and collapses a burst of redraws into one refresh. What is left for this module is the
 * key, the default staleness threshold, and the purge — three decisions, described below.
 *
 * **Width is part of the key, not just part of the call.** Text wrapped for eighty columns is
 * wrong at sixty, so a resized pane must re-render rather than replay. Storing renders under
 * `pr-preview-<number>-<width>` gets that for free: a resize asks for a name that is not on
 * disk. Nothing has to notice the resize, compare a stored width, or invalidate anything.
 *
 * **A preview never outlives the pull-request data it belongs to.** {@link previewPullRequest}
 * defaults its staleness threshold to the PR cache's own, read off `config.ts`'s `DEFAULTS`
 * rather than restated here, so a user who retunes one clock retunes both and the two cannot
 * drift. That is the passive half of the coupling; {@link clearPreviews} is the active half,
 * for a refresh that replaces the underlying data outright rather than waiting for it to age.
 * A separate `pr-preview` TTL key was deliberately not added: a second knob is precisely the
 * divergence the shared clock exists to prevent.
 *
 * **A failure is a render.** `gh`'s complaint about a pull request it could not find is what
 * belongs in the pane — an empty pane says nothing at all — so the text comes back, and is
 * stored, exactly like a successful render. Throwing instead would be worse in the very case
 * that matters: {@link cached} serves previous contents when a refresh throws, and on a
 * first-ever lookup there are none. The single failure carrying no message of its own is a `gh`
 * that could not be run at all, where {@link viewPullRequest} answers `null` and {@link NO_GH}
 * is substituted.
 *
 * Nothing here reads configuration files, resolves a repository, or spawns anything directly.
 * The container arrives as a parameter exactly as it does in `cache.ts` and `config.ts`, which
 * is what keeps this module testable with no git repository in sight.
 *
 * @packageDocumentation
 */

import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type CacheKey, cached, cachePath } from "./cache";
import { DEFAULTS } from "./config";
import { viewPullRequest } from "./gh";

/**
 * The PR cache entry whose staleness threshold previews share.
 *
 * Named here rather than inlined because it is a claim about another module's data, not a
 * string this one invented — see this module's header for why previews have no clock of
 * their own.
 */
const PR_CACHE = "pr-graph";

/**
 * Leading segment of every preview entry's name.
 *
 * Chosen so it cannot prefix-match {@link PR_CACHE}, which shares the same per-repo directory:
 * {@link clearPreviews} recognises what it may remove by this prefix, and a `pr-graph-preview`
 * spelling would leave the PR graph one careless `startsWith` away from being purged with its
 * previews. Every character is inside `cacheSlug`'s alphabet, so the prefix survives onto disk
 * unfolded — which is what makes that filename test work at all.
 */
const PREFIX = "pr-preview";

/**
 * Staleness threshold a caller inherits when it supplies none.
 *
 * The fallback is `noUncheckedIndexedAccess` demanding a total lookup rather than a case
 * expected to fire — `config.ts` ships that key today. `0` is the honest value for it: refresh
 * on every read, which is correct and merely slower, where an invented constant would silently
 * reinstate the divergence this default exists to prevent.
 */
const DEFAULT_TTL = DEFAULTS.cache.ttls[PR_CACHE] ?? 0;

/**
 * Shown when `gh` could not be run — the one failure that carries no message of its own.
 *
 * Worded over **both** of the causes `gh.ts` documents as indistinguishable at the spawn, and
 * modelled on `checkoutPullRequest`'s message for that reason: a missing `gh` and a `cwd` that
 * no longer exists produce the same `ENOENT`, and this is a sentence a user reads, so asserting
 * the more likely one would send someone who has `gh` installed chasing an install. A worktree
 * torn down under a running picker is exactly how the second cause reaches here.
 */
const NO_GH =
  "could not run gh — check that it is installed (https://cli.github.com) and that the directory exists\n";

/** Options for {@link previewPullRequest}. */
export interface PreviewOptions extends Omit<CacheKey, "name"> {
  /**
   * Directory `gh` runs in, which is what decides the repository it answers about. Defaults to
   * this process's cwd.
   */
  cwd?: string;

  /**
   * Milliseconds before a render goes stale.
   *
   * Defaults to the PR cache's own threshold — see {@link DEFAULT_TTL}. A caller holding a
   * loaded {@link DEFAULTS}-shaped config passes `config.cache.ttls["pr-graph"]` here, which is
   * the same coupling with the user's override applied.
   */
  ttl?: number;
}

/**
 * One pull request as `gh` renders it, wrapped for a pane `width` columns wide.
 *
 * Cached per pull request *and* per width, so a resized pane re-renders rather than replaying
 * text wrapped for the width it used to be.
 *
 * @param number - The pull request to preview.
 * @param width - Column count to render at, which is also what makes `gh` render markdown
 *   rather than fall back to plain text. Expected to be a positive integer: it reaches `gh` as
 *   `GH_FORCE_TTY` and reaches disk as part of the entry name, so a fractional or negative
 *   value produces a strange render under a strange filename rather than an error — and a
 *   fractional one puts a `.` in that filename, which {@link clearPreviews} then reads as a
 *   sibling and leaves behind.
 * @param options - See {@link PreviewOptions}.
 * @returns What to display. A failed lookup yields `gh`'s own message and an unrunnable `gh`
 *   yields {@link NO_GH}, so the pane goes blank only if `gh` itself exited saying nothing.
 * @throws Whatever {@link cached} throws — a cache directory that cannot be written. `gh`
 *   itself failing is not among them; that is a render.
 *
 * @example
 * ```ts
 * const pane = await previewPullRequest(22, columns, { container, cwd: checkout });
 * ```
 */
// ponytail: every distinct width is a cache miss by construction, so dragging a terminal
// resize does not merely leave a file per column count it passed through — it spawns a `gh`
// per column count, and `cached`'s single-flight lock cannot collapse any of it because each
// width is a different key. Quantising the width here would contradict the exact-column-count
// contract, so the fix belongs to the caller: debounce the resize before drawing.
export async function previewPullRequest(
  number: number,
  width: number,
  options: PreviewOptions,
): Promise<string> {
  const { cwd, ttl = DEFAULT_TTL, ...key } = options;

  // ponytail: a failed render is stored for a full TTL like a successful one, which is
  // deliberate for a flaky network — the alternative re-runs a failing `gh` on every redraw.
  // It reads worse for the NO_GH case, the one failure a user actively fixes: the pane keeps
  // saying so until the entry ages out or `clearPreviews` runs. Give a nonzero render a
  // shorter threshold of its own if either becomes visible.
  return cached(
    { ...key, name: `${PREFIX}-${number}-${width}` },
    ttl,
    async () => (await viewPullRequest(number, cwd, { width })) ?? NO_GH,
  );
}

/**
 * Discards every stored render for one repository.
 *
 * The active half of "invalidated together with the PR cache": a refresh that *replaces* the
 * pull-request data has made every preview of it wrong immediately, rather than merely old, and
 * waiting out a shared TTL would leave the pane describing pull requests the list no longer
 * shows. The passive half is {@link DEFAULT_TTL}.
 *
 * Entries are removed; the **siblings a cache write leaves beside one are not**. `cache.ts`
 * puts two kinds of file next to an entry — the `.lock` a refresh holds, and the
 * `.<pid>.<n>.tmp` a write is staged in before being renamed over the entry — and removing
 * either mid-flight breaks a caller that has done nothing wrong. Taking a lock from its holder
 * is the larger problem `cache.ts` documents at length; deleting a staging file makes its
 * rename fail `ENOENT`, and `cached` writes outside its own stale-contents fallback, so that
 * rejection surfaces in whatever was drawing. A purge is designed to run *concurrently* with a
 * render, so both are live rather than theoretical. The PR cache itself is left standing too —
 * see {@link PREFIX} for what keeps the two apart.
 *
 * A repository with no cache directory yet is not an error: nothing was stored, which is the
 * state the caller asked for.
 *
 * @param key - Which repository's previews to discard. Takes {@link CacheKey}'s container and
 *   root, since a purge is addressed to every name rather than to one.
 * @throws If the directory exists but cannot be read, or an entry cannot be removed. An
 *   unreadable cache is a real fault, and reporting it as "nothing to do" would leave a stale
 *   pane with no explanation.
 */
export async function clearPreviews(key: Omit<CacheKey, "name">): Promise<void> {
  // The name is a placeholder: only the directory above it is wanted, and deriving it through
  // `cachePath` is what keeps the per-repo layout `cache.ts`'s single decision.
  const directory = dirname(cachePath({ ...key, name: PREFIX }));

  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });

  await Promise.all(
    names
      // Two conditions, each answering a different question. The trailing separator matters as
      // much as the prefix: without it a future `pr-previews` entry would be swept by a call
      // that never meant to touch it. And the dot test asks "is this an entry, or a sibling of
      // one?" rather than enumerating today's suffixes — an entry name is the folded key plus a
      // hex digest, which holds no `.`, while every sibling `cache.ts` writes does. Stated as a
      // property, so a third suffix invented there is excluded without an edit here.
      .filter((name) => name.startsWith(`${PREFIX}-`) && !name.includes("."))
      .map((name) => rm(join(directory, name), { force: true })),
  );
}
