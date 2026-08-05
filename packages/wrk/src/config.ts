/**
 * Where `wrk` reads its own settings.
 *
 * Three layers, lowest first: {@link DEFAULTS}, then a machine-wide file at
 * `$XDG_CONFIG_HOME/wrk/config.json`, then a `wrk` namespace inside the repository
 * container's `.project-meta.json`. {@link loadConfig} folds them into one
 * {@link WrkConfig} and never reports a problem with any of them — a config that is
 * absent, unreadable, not JSON, or simply carries none of the keys leaves the layers below
 * it standing.
 *
 * **The namespacing is asymmetric, deliberately.** The global file is already namespaced
 * by its path, so its sections sit at the root of the document. `.project-meta.json` is
 * *shared* — the ones on disk today carry a top-level `search` key belonging to an
 * unrelated tool — so everything `wrk` reads there hangs off a `wrk` key, and `wrk`'s own
 * search settings are `wrk.search`, never the neighbouring top-level `search`.
 *
 * **Validation is per field, not per layer.** One malformed value falls through to the
 * layer beneath it while its well-formed neighbours in the same object still apply, which
 * is what "degrades to defaults" has to mean for a file a human hand-edits. A whole layer
 * is discarded only when the document itself cannot be read as a JSON object.
 *
 * **This module spawns nothing and resolves no repository.** The container arrives as a
 * parameter, exactly as `cache.ts` takes `CacheKey.container`, which keeps container
 * resolution `repo.ts`'s single responsibility and leaves this module testable with no git
 * repository anywhere in sight. One consequence is inherited rather than fought: on a git
 * older than 2.31, `rev-parse` echoes the unrecognised `--path-format` flag to stdout and
 * exits 0 (see the README's git-floor note), so `containerFor` answers with a path derived
 * from that echo rather than with a real container. Handed one, this module reads a file
 * that is not the container's and degrades — so an unsupported git costs the per-repo
 * layer silently, which is what the acceptance criteria ask for anyway. Note the derived
 * path can be as innocuous as `.`, so the file read may be a `.project-meta.json` relative
 * to the process cwd; it is still not the repository's, and the answer is still defaults.
 *
 * The defaults are not invented: they are what the fish implementation this package
 * replaces does today, so adopting `wrk` with no config at all changes nothing.
 *
 * @packageDocumentation
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Directory under the XDG config root, and the key the per-repo settings hang off.
 *
 * One constant for both because they are the same claim — "this belongs to `wrk`" — made
 * against two different documents.
 */
const NAMESPACE = "wrk";

/** The machine-wide config file's name within its namespaced directory. */
const GLOBAL_FILENAME = "config.json";

/** The container-level file the per-repo layer is read from. Shared with other tools. */
const PROJECT_META = ".project-meta.json";

/**
 * A value per position in a PR stack.
 *
 * The three positions are the ones the stack annotator distinguishes: the top of a stack,
 * its bottom, and a branch already merged. A one-layer stack is none of them and carries
 * no marker at all, which is why there is no fourth field.
 */
export interface ByStackPosition {
  /** Top of the stack. */
  readonly top: string;
  /** Bottom of the stack. */
  readonly bottom: string;
  /** Already merged. */
  readonly merged: string;
}

/** Everything `wrk` lets a user override. */
export interface WrkConfig {
  /**
   * Where repository containers are looked for.
   *
   * Replaces the `find ~/GitLocal -mindepth 2 -maxdepth 2` the fish implementation
   * hardcodes. `depth` is configurable alongside `roots` because the pair is one decision:
   * a root whose containers sit at a different nesting than `~/GitLocal`'s is unusable
   * with the depth frozen at 2.
   */
  readonly search: {
    /** Absolute directories to scan. Any `~` was expanded when the config was read. */
    readonly roots: readonly string[];
    /** How far below each root a container sits. `0` means the root is itself one. */
    readonly depth: number;
  };

  readonly cache: {
    /**
     * Milliseconds before a cache entry goes stale, keyed by the entry's `CacheKey.name`.
     *
     * `0` is a meaningful value — refresh on every read — and is therefore accepted rather
     * than treated as absent. An entry with no key here has no configured TTL; what to do
     * about that is its caller's decision, not this module's.
     */
    readonly ttls: Readonly<Record<string, number>>;
  };

  /** Marker characters per stack position. Nerd Font private-use code points by default. */
  readonly glyphs: ByStackPosition;

  /**
   * Colour per stack position.
   *
   * The values stay opaque strings. Turning a name into an escape sequence is the
   * business of whatever draws the picker, and a config layer that validated the name
   * would have to track that renderer's palette to do it.
   */
  readonly colours: ByStackPosition;
}

/** Which layers {@link loadConfig} reads, and where from. */
export interface ConfigSources {
  /**
   * Repository container supplying the per-repo layer, as `containerFor` answers it.
   *
   * Absent or `null` skips that layer — `null` is what a caller outside any repository
   * has, and it is not an error here.
   */
  readonly container?: string | null;

  /**
   * Machine-wide config file, overriding the XDG default.
   *
   * Present so a test can point the global layer at a temp file in one field rather than
   * mutating `XDG_CONFIG_HOME` in a shared process — the same seam `CacheKey.root` is.
   */
  readonly globalPath?: string;
}

/**
 * What `wrk` does with no configuration at all.
 *
 * Every value is the fish implementation's current behaviour: `~/GitLocal` scanned two
 * levels down, a fifteen-minute PR-graph cache, and the three glyph-and-colour pairs the
 * stack annotator draws with.
 *
 * `roots` is stored expanded, so every consumer sees absolute paths whichever layer an
 * answer came from.
 *
 * The glyphs are spelled as code points rather than as literal characters. They are Nerd
 * Font private-use points, so a literal renders as a blank box in any editor lacking that
 * font — unreviewable in a diff, and silently destroyed by anything that re-encodes the
 * file. `config.test.ts` asserts the literal characters, so the two spellings check each
 * other.
 */
export const DEFAULTS: WrkConfig = {
  search: { roots: [join(homedir(), "GitLocal")], depth: 2 },
  cache: { ttls: { "pr-graph": 900_000 } },
  glyphs: {
    top: String.fromCodePoint(0xf062),
    bottom: String.fromCodePoint(0xf063),
    merged: String.fromCodePoint(0xf00c),
  },
  colours: { top: "green", bottom: "yellow", merged: "brblack" },
};

/** One layer's raw document, after it has been confirmed to be a JSON object. */
type Layer = Record<string, unknown>;

/** Whether `value` is a plain JSON object — an array is not one, and neither is `null`. */
function isObject(value: unknown): value is Layer {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves the machine-wide config file's path.
 *
 * The two rejections mirror `cache.ts`'s `defaultRoot`, for the same two reasons. An
 * **empty** `XDG_CONFIG_HOME` is treated as unset, because an exported-but-empty variable
 * is how a shell says "unset" in practice and `join("", …)` would silently yield a path
 * relative to the cwd. A **relative** one is ignored, which the XDG base directory
 * specification requires — and which matters here because `wrk` runs from wherever the
 * user happens to be standing.
 *
 * Those few lines are duplicated rather than shared with `cache.ts`: the two read
 * different variables, the other copy is private to its module, and a module existing to
 * host four lines for two call sites is not worth the indirection. If a third XDG consumer
 * appears, extract then.
 *
 * @returns The absolute path of the global config file, whether or not it exists.
 */
export function globalConfigPath(): string {
  const configured = process.env.XDG_CONFIG_HOME;
  const base = configured && isAbsolute(configured) ? configured : join(homedir(), ".config");

  return join(base, NAMESPACE, GLOBAL_FILENAME);
}

/**
 * Reads one JSON document, answering `null` for every way it can fail to be one.
 *
 * Missing, unreadable, a directory, empty, truncated, or a JSON array or scalar at the
 * root all collapse to the same answer, because the caller does the same thing with each:
 * fall through to the layer below. Distinguishing them would only be useful for a
 * diagnostic this module is specified not to emit.
 */
async function readLayer(path: string): Promise<Layer | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;

  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Reads the `wrk` namespace out of a container's `.project-meta.json`. */
async function readProjectLayer(container: string): Promise<Layer | null> {
  const meta = await readLayer(join(container, PROJECT_META));
  const namespaced = meta?.[NAMESPACE];

  return isObject(namespaced) ? namespaced : null;
}

/** One named section of a layer, or `null` when the layer omits it or it is not an object. */
function section(layer: Layer, name: keyof WrkConfig): Layer | null {
  const value = layer[name];
  return isObject(value) ? value : null;
}

/**
 * Expands a leading `~`, and only a leading `~`.
 *
 * `~otheruser` is deliberately left alone: resolving another user's home means reading the
 * password database, and the result is dropped a moment later anyway for not being
 * absolute — which is the honest answer for a root `wrk` cannot locate.
 */
function expandHome(path: string): string {
  if (path === "~") return homedir();

  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * The usable search roots a layer supplies, or `undefined` when it supplies none.
 *
 * Entries that are not strings, and entries still relative after expansion, are dropped
 * individually — a relative root would be scanned from wherever the user happened to be
 * standing, which is the same hazard `globalConfigPath` rejects a relative
 * `XDG_CONFIG_HOME` for. A list that empties out is treated as no answer rather than as
 * "search nowhere", so a typo'd `"GitLocal"` yields the layer below rather than a picker
 * that silently finds nothing.
 */
function takeRoots(search: Layer | null): string[] | undefined {
  const value = search?.roots;
  if (!Array.isArray(value)) return undefined;

  const roots: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;

    const expanded = expandHome(entry);
    if (isAbsolute(expanded)) roots.push(expanded);
  }

  return roots.length > 0 ? roots : undefined;
}

/** A layer's search depth, if it is one a directory scan could actually use. */
function takeDepth(search: Layer | null): number | undefined {
  const value = search?.depth;

  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The well-formed TTL entries of one layer.
 *
 * Returns a map rather than a whole-value answer because TTLs merge key by key: overriding
 * one entry's TTL must not drop every other entry's. A bad entry is skipped on its own.
 */
function takeTtls(cache: Layer | null): Record<string, number> {
  const value = cache?.ttls;
  if (!isObject(value)) return {};

  const ttls: Record<string, number> = {};
  for (const [name, ms] of Object.entries(value)) {
    if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) ttls[name] = ms;
  }

  return ttls;
}

/** A layer's value for one glyph or colour. Empty strings are rejected as absent. */
function takeMark(marks: Layer | null, position: keyof ByStackPosition): string | undefined {
  const value = marks?.[position];

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolves one `{top, bottom, merged}` section, folding the layers on in priority order.
 *
 * `??` is exact rather than convenient here: {@link takeMark} already rejects the empty
 * string, so the only `undefined` reaching it means "this layer offered nothing usable for
 * this position" — which is how one malformed mark falls through while its siblings in the
 * same object still land.
 */
function takeByPosition(
  layers: readonly Layer[],
  name: "glyphs" | "colours",
  fallback: ByStackPosition,
): ByStackPosition {
  // Copied rather than aliased, so the answer is never `DEFAULTS`' own object.
  let marks: ByStackPosition = { ...fallback };

  for (const layer of layers) {
    const supplied = section(layer, name);
    marks = {
      top: takeMark(supplied, "top") ?? marks.top,
      bottom: takeMark(supplied, "bottom") ?? marks.bottom,
      merged: takeMark(supplied, "merged") ?? marks.merged,
    };
  }

  return marks;
}

/**
 * Reads and merges every configuration layer.
 *
 * Nothing here throws or warns. A caller gets a complete {@link WrkConfig} whatever state
 * the files are in, which is what lets a shell prompt call it without a guard.
 *
 * Two merge rules, and the difference between them is the point. `search.roots` is
 * **replaced wholesale** by the highest layer offering a usable value — it is one decision
 * that happens to be a list, and concatenating onto the defaults would make `~/GitLocal`
 * impossible to remove. `cache.ttls`, `glyphs` and `colours` merge **key by key**, because
 * each is a bag of independently-named settings.
 *
 * The returned object is always freshly built, never {@link DEFAULTS} itself, so a caller
 * that mutates what it was handed cannot poison the next call.
 *
 * @param sources - Which layers to read. Defaults to the global file alone.
 * @returns The merged configuration.
 *
 * @example
 * ```ts
 * const config = await loadConfig({ container: await containerFor() });
 * const { roots, depth } = config.search;
 * ```
 */
// ponytail: validation is hand-rolled `typeof` guards. Reach for a schema library only if
// this grows past a handful of sections — today one would be more code, not less.
export async function loadConfig(sources: ConfigSources = {}): Promise<WrkConfig> {
  const { container, globalPath = globalConfigPath() } = sources;

  const [globalLayer, projectLayer] = await Promise.all([
    readLayer(globalPath),
    container ? readProjectLayer(container) : null,
  ]);

  // Every fold below applies the layers in this order, so a later one wins. A third layer
  // is added to the end of this array and needs no other change.
  const layers = [globalLayer, projectLayer].filter((layer) => layer !== null);

  const ttls: Record<string, number> = { ...DEFAULTS.cache.ttls };
  let roots: readonly string[] = DEFAULTS.search.roots;
  let depth = DEFAULTS.search.depth;

  for (const layer of layers) {
    const search = section(layer, "search");
    roots = takeRoots(search) ?? roots;
    depth = takeDepth(search) ?? depth;
    Object.assign(ttls, takeTtls(section(layer, "cache")));
  }

  return {
    // Spread rather than passed through: `roots` may still be `DEFAULTS`' own array here.
    search: { roots: [...roots], depth },
    cache: { ttls },
    glyphs: takeByPosition(layers, "glyphs", DEFAULTS.glyphs),
    colours: takeByPosition(layers, "colours", DEFAULTS.colours),
  };
}
