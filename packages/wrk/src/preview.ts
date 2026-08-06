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
 * first-ever lookup there are none. The single failure carrying no message of its own is an
 * absent `gh`, where {@link viewPullRequest} answers `null` and {@link NO_GH} is substituted.
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
 * {@link clearPreviews} decides what to remove on this prefix alone, and a `pr-graph-preview`
 * spelling would leave the PR graph one careless `startsWith` away from being purged with its
 * previews. Every character is inside `cacheSlug`'s alphabet, so the prefix survives onto disk
 * unfolded — which is what makes that filename test work at all.
 */
const PREFIX = "pr-preview";

/**
 * Staleness threshold a caller inherits when it supplies none.
 *
 * Read off {@link DEFAULTS} rather than restated, so the two cannot drift. The fallback is
 * `noUncheckedIndexedAccess` demanding a total lookup rather than a case expected to fire —
 * `config.ts` ships that key today. `0` is the honest value for it: refresh on every read,
 * which is correct and merely slower, where an invented constant would silently reinstate the
 * divergence this default exists to prevent.
 */
const DEFAULT_TTL = DEFAULTS.cache.ttls[PR_CACHE] ?? 0;

/**
 * Shown when `gh` is absent — the one failure that carries no message of its own.
 *
 * Worded over both of the causes `gh.ts` documents as indistinguishable at the spawn, which is
 * why it says nothing about the directory: an absent `gh` and an unreadable `cwd` produce the
 * same `ENOENT`, and a sentence asserting the wrong one sends a reader chasing it.
 */
const NO_GH = "gh is not installed, so there is nothing to preview — see https://cli.github.com\n";

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
 *   value produces a strange render under a strange filename rather than an error.
 * @param options - See {@link PreviewOptions}.
 * @returns What to display. Never empty: a failed lookup yields `gh`'s own message, and an
 *   absent `gh` yields {@link NO_GH}.
 * @throws Whatever {@link cached} throws — a cache directory that cannot be written. `gh`
 *   itself failing is not among them; that is a render.
 *
 * @example
 * ```ts
 * const pane = await previewPullRequest(22, columns, { container, cwd: checkout });
 * ```
 */
// ponytail: every distinct width mints an entry of its own and only `clearPreviews` reaps
// them, so dragging a terminal resize leaves one file per column count it passed through.
// Round the width to a step, or sweep the oldest entries here, if that ever piles up.
export async function previewPullRequest(
  number: number,
  width: number,
  options: PreviewOptions,
): Promise<string> {
  const { cwd, ttl = DEFAULT_TTL, ...key } = options;

  // ponytail: a transient `gh` failure is stored for a full TTL like any successful render,
  // which is deliberate — the alternative re-runs a failing `gh` on every redraw of the picker.
  // Give a nonzero render a shorter threshold of its own if a flaky network makes it visible.
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
 * The PR cache itself is left standing — see {@link PREFIX} for what keeps the two apart — as
 * is any `.lock` directory. Skipping locks is not tidiness: `cache.ts` documents why taking a
 * refresh lock from its holder is a larger problem than it looks, and a render running
 * concurrently with this call is exactly a holder. The lock is released by whoever took it.
 *
 * @param key - Which repository's previews to discard. Takes {@link CacheKey}'s container and
 *   root, since a purge is addressed to every name rather than to one.
 * @returns Nothing. A repository with no cache directory yet is not an error — nothing was
 *   stored, which is the state the caller asked for.
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
      // The trailing separator matters as much as the prefix: without it a future `pr-previews`
      // entry would be swept by a call that never meant to touch it.
      .filter((name) => name.startsWith(`${PREFIX}-`) && !name.endsWith(".lock"))
      .map((name) => rm(join(directory, name), { force: true })),
  );
}
