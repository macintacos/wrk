/**
 * Where `wrk` reads its own settings.
 *
 * Three layers, lowest first: {@link DEFAULTS}, then a machine-wide file at
 * `$XDG_CONFIG_HOME/wrk/config.toml`, then the `wrk` namespace inside the repository
 * container's `.project-meta.json` — read through [`./meta`](./meta), which owns that file
 * for every namespace in it rather than only this one. {@link loadConfig} folds them into one
 * {@link WrkConfig} and never reports a problem with any of them — a config that is
 * absent, unreadable, unparseable, or simply carries none of the keys leaves the layers
 * below it standing.
 *
 * **The two layers are in different formats, deliberately.** The global file is TOML,
 * which is what a human hand-edits comfortably and what the rest of this repo's tooling
 * already speaks. `.project-meta.json` is *shared* — the ones on disk today carry a
 * top-level `search` key belonging to an unrelated tool — so it stays JSON, keeps its name,
 * and everything `wrk` reads there hangs off a `wrk` key. Reformatting a file another tool
 * owns to match this one's taste is not a tidy-up, it is a break. The namespacing is
 * asymmetric for the same reason: the global file is already namespaced by its path, so its
 * sections sit at the root of the document, while `wrk`'s per-repo search settings are
 * `wrk.search`, never the neighbouring top-level `search`.
 *
 * **The parsing is bought; the layering is not.** `smol-toml` reads the global document —
 * hand-rolling TOML means disagreeing with the spec somewhere inside a file a human edits
 * by hand. It won over the other parsers on maintenance and surface: `@iarna/toml` and
 * `toml` both predate TOML 1.0 and have been dormant for years, and `@ltd/j-toml` carries a
 * far larger API for a module that wants `parse(text)` and nothing else.
 *
 * The layering stayed here after weighing two config libraries against it. `cosmiconfig`
 * exists to *discover* config across a dozen conventional locations, which this module
 * deliberately does not want: there are exactly two layers at two known paths, and a stray
 * `wrk.config.js` two directories up silently becoming configuration would be a misfeature.
 * It also has no TOML loader, so it would sit on top of this dependency rather than replace
 * it. `c12` does layer natively and does read TOML, but it is in beta for a module a shell
 * prompt calls on every redraw, it pulls a substantial dependency graph into a package that
 * otherwise has five, and it merges *whole layers* — the wrong granularity for the
 * per-field degradation below, which would have had to stay hand-written underneath it
 * anyway. In fairness to that last argument, `zod` is now the largest thing in this
 * package's own graph; what it buys is the per-field degradation itself, which is the part
 * `c12` would not have replaced.
 *
 * **Validation is per field, not per layer.** Every field is parsed through its own schema
 * on its own {@link take}, so one malformed value falls through to the layer beneath it
 * while its well-formed neighbours in the same table still apply — which is what "degrades
 * to defaults" has to mean for a file a human hand-edits. A whole layer is discarded only
 * when the document itself cannot be read: a TOML document error (an unterminated table
 * header, a redefined key, an integer too large to represent losslessly) or a
 * `.project-meta.json` that is not a JSON object.
 *
 * **This module spawns nothing and resolves no repository.** The container arrives as a
 * parameter, exactly as `cache.ts` takes `CacheKey.container`, which keeps container
 * resolution `repo.ts`'s single responsibility and leaves this module testable with no git
 * repository anywhere in sight. One consequence is inherited rather than fought: on a git
 * older than 2.31, `rev-parse` echoes the unrecognised `--path-format` flag to stdout and
 * exits 0 (see `doc/ADVANCED.md`'s git version floor), so `containerFor` answers with a
 * path derived from that echo rather than with a real container. Handed one, this module
 * reads a file that is not the container's and degrades — so an unsupported git costs the per-repo
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

import { parse as parseToml } from "smol-toml";
import { z } from "zod";

import { readNamespace } from "./meta";

/**
 * Directory under the XDG config root, and the key the per-repo settings hang off.
 *
 * One constant for both because they are the same claim — "this belongs to `wrk`" — made
 * against two different documents.
 */
const NAMESPACE = "wrk";

/** The machine-wide config file's name within its namespaced directory. */
const GLOBAL_FILENAME = "config.toml";

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

/** One glyph or colour. The empty string is rejected as absent rather than accepted. */
const MARK = z.string().min(1);

/** A `{top, bottom, merged}` section — see {@link ByStackPosition}. */
const BY_POSITION = z.object({ top: MARK, bottom: MARK, merged: MARK }).readonly();

/**
 * The usable search roots a layer supplies.
 *
 * Entries that are not strings, and entries still relative after expansion, are dropped
 * individually — a relative root would be scanned from wherever the user happened to be
 * standing, which is the same hazard {@link globalConfigPath} rejects a relative
 * `XDG_CONFIG_HOME` for. A list that empties out fails the parse rather than answering
 * "search nowhere", so a typo'd `"GitLocal"` yields the layer below rather than a picker
 * that silently finds nothing.
 */
const ROOTS = z
  .array(z.unknown())
  .transform((entries) =>
    entries
      .filter((entry) => typeof entry === "string")
      .map(expandHome)
      .filter(isAbsolute),
  )
  .refine((roots) => roots.length > 0)
  .readonly();

/** A search depth a directory scan could actually use. `0` means the root is itself one. */
const DEPTH = z.int().nonnegative();

/**
 * One entry's staleness threshold, in milliseconds.
 *
 * `0` is meaningful — refresh on every read — so it is accepted rather than treated as
 * absent. `z.number()` already rejects `NaN` and `Infinity`, which TOML can express as
 * float literals inside an otherwise well-formed document.
 */
const TTL = z.number().nonnegative();

/**
 * The well-formed TTL entries of one layer, keyed by the entry's `CacheKey.name`.
 *
 * Parsed entry by entry rather than as one record, because TTLs merge key by key:
 * overriding one entry's TTL must not drop every other entry's, and neither must one
 * malformed entry. An entry with no key here has no configured TTL; what to do about that
 * is its caller's decision, not this module's.
 */
const TTLS = z
  .record(z.string(), z.unknown())
  .transform((entries) =>
    Object.fromEntries(
      Object.entries(entries).flatMap(([name, value]) => {
        const ms = TTL.safeParse(value);
        return ms.success ? [[name, ms.data] as const] : [];
      }),
    ),
  )
  .readonly();

/**
 * Everything `wrk` lets a user override, as a schema.
 *
 * The schema is the definition and {@link WrkConfig} is derived from it, so there is no
 * second declaration to keep in sync by hand. The cost of deriving rather than declaring is
 * that the per-field prose lives here and on the leaf schemas above rather than on the
 * exported type, where an editor would surface it on hover — accepted, because a type kept
 * in sync by hand is the failure this is meant to prevent.
 *
 * **This schema types the config and checks the defaults; it does not read the layers.**
 * {@link loadConfig} folds the files by name, field by field, so a field added here is
 * typed, documented and validated in {@link DEFAULTS} while being silently ignored in both
 * config files until it gets its own `take` line in that fold.
 *
 * Parsing {@link DEFAULTS} through it is what makes a default violating an invariant the
 * type system cannot express — an empty glyph, a wholly relative `roots` — fail at import
 * rather than ship. Not every invariant, though: {@link TTLS} and {@link ROOTS} *drop* bad
 * entries rather than rejecting, so a default with a negative TTL parses to an empty `ttls`
 * instead of throwing. `config.test.ts`'s defaults-parity case is what catches those.
 *
 * `search.roots` and `search.depth` are one decision spelled as two fields — together they
 * replace the `find ~/GitLocal -mindepth 2 -maxdepth 2` the fish implementation hardcodes,
 * and a root whose containers sit at a different nesting is unusable with the depth frozen
 * at 2. `glyphs` and `colours` are the marker and the colour the stack annotator draws per
 * stack position. The colours stay opaque strings, because turning a name into an escape
 * sequence is the business of whatever draws the picker, and a config layer that validated
 * the name would have to track that renderer's palette to do it.
 */
const CONFIG = z
  .object({
    search: z.object({ roots: ROOTS, depth: DEPTH }).readonly(),
    cache: z.object({ ttls: TTLS }).readonly(),
    glyphs: BY_POSITION,
    colours: BY_POSITION,
  })
  .readonly();

/**
 * A value per position in a PR stack.
 *
 * The three positions are the ones the stack annotator distinguishes: the top of a stack,
 * its bottom, and a branch already merged. A one-layer stack is none of them and carries
 * no marker at all, which is why there is no fourth field.
 */
export type ByStackPosition = z.infer<typeof BY_POSITION>;

/** Everything `wrk` lets a user override. Derived from {@link CONFIG}, never declared twice. */
export type WrkConfig = z.infer<typeof CONFIG>;

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
 * `roots` is written the way a user would write it and comes back expanded, so every
 * consumer sees absolute paths whichever layer an answer came from.
 *
 * Deep-frozen, because {@link CONFIG} ends in `.readonly()`. {@link loadConfig}'s answer is
 * deliberately *not* frozen — it is built by hand and handed to a caller who may do what it
 * likes with it — so the two differ, and only this one is safe to alias.
 *
 * The glyphs are spelled as code points rather than as literal characters. They are Nerd
 * Font private-use points, so a literal renders as a blank box in any editor lacking that
 * font — unreviewable in a diff, and silently destroyed by anything that re-encodes the
 * file. `config.test.ts` asserts the literal characters, so the two spellings check each
 * other.
 */
export const DEFAULTS: WrkConfig = CONFIG.parse({
  search: { roots: ["~/GitLocal"], depth: 2 },
  cache: { ttls: { "pr-graph": 900_000 } },
  glyphs: {
    top: String.fromCodePoint(0xf062),
    bottom: String.fromCodePoint(0xf063),
    merged: String.fromCodePoint(0xf00c),
  },
  colours: { top: "green", bottom: "yellow", merged: "brblack" },
});

/**
 * Any table: one layer's whole document, or one named section of it.
 *
 * The same schema does both jobs because they are the same question — "is this something
 * that has named fields?" — and it answers it for every non-table a document can hold: an
 * array, a scalar, `null`. It is also the only thing standing between an `unknown` parse
 * result and a value the folds below can index, so it is narrowing rather than defence.
 */
const LAYER = z.record(z.string(), z.unknown());

/** One layer's raw document, after it has been confirmed to be a table. */
type Layer = z.infer<typeof LAYER>;

/**
 * One field's value as `schema` reads it, or `null` when this layer offers nothing usable
 * for it.
 *
 * Every field goes through its own call, which is what makes degradation per field rather
 * than per layer: a schema that rejects cannot take its neighbours down with it.
 *
 * `null` rather than `undefined` for "nothing here", matching `cache.ts`, `git.ts` and
 * `repo.ts` — and unambiguous only because no schema in this module answers `null`. One
 * that did would need its own way to say it found nothing.
 */
function take<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> | null {
  const result = schema.safeParse(value);

  return result.success ? result.data : null;
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
 * Reads the machine-wide TOML document, answering `null` for every way that can fail.
 *
 * Missing, unreadable, a directory, or rejected by the parser all collapse to the same
 * answer, because the caller does the same thing with each: fall through to the layer
 * below. Distinguishing them would only be useful for a diagnostic this module is
 * specified not to emit.
 *
 * The per-repo layer's equivalent is {@link readNamespace}, which owes the same
 * degradation to a file in a different format — see [`./meta`](./meta).
 */
async function readGlobalLayer(path: string): Promise<Layer | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;

  try {
    return take(LAYER, parseToml(text));
  } catch {
    return null;
  }
}

/** One named section of a layer, or `null` when it is absent or is not a table. */
function section(layer: Layer, name: keyof WrkConfig): Layer | null {
  return take(LAYER, layer[name]);
}

/**
 * Resolves one `{top, bottom, merged}` section, folding the layers on in priority order.
 *
 * `??` is exact rather than convenient here: {@link MARK} already rejects the empty
 * string, so the only `undefined` reaching it means "this layer offered nothing usable for
 * this position" — which is how one malformed mark falls through while its siblings in the
 * same table still land.
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
      top: take(MARK, supplied?.top) ?? marks.top,
      bottom: take(MARK, supplied?.bottom) ?? marks.bottom,
      merged: take(MARK, supplied?.merged) ?? marks.merged,
    };
  }

  return marks;
}

/**
 * Reads and merges every configuration layer.
 *
 * Nothing here throws or warns. A caller gets a complete {@link WrkConfig} whatever state
 * the files are in, which is what lets a shell prompt call it without a guard. The module's
 * one throw site is {@link DEFAULTS}' own parse, which fires at import and only for a
 * default this repository shipped wrong.
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
export async function loadConfig(sources: ConfigSources = {}): Promise<WrkConfig> {
  const { container, globalPath = globalConfigPath() } = sources;

  const [globalLayer, projectLayer] = await Promise.all([
    readGlobalLayer(globalPath),
    container ? readNamespace(container, NAMESPACE) : null,
  ]);

  // Every fold below applies the layers in this order, so a later one wins. A third layer
  // is added to the end of this array and needs no other change — but a new *field* needs
  // its own `take` line below, since nothing walks {@link CONFIG} to find them.
  const layers = [globalLayer, projectLayer].filter((layer) => layer !== null);

  const ttls: Record<string, number> = { ...DEFAULTS.cache.ttls };
  let roots: readonly string[] = DEFAULTS.search.roots;
  let depth = DEFAULTS.search.depth;

  for (const layer of layers) {
    const search = section(layer, "search");
    roots = take(ROOTS, search?.roots) ?? roots;
    depth = take(DEPTH, search?.depth) ?? depth;
    // `Object.assign` skips a `null` source, so `take`'s "nothing here" needs no guard.
    Object.assign(ttls, take(TTLS, section(layer, "cache")?.ttls));
  }

  return {
    // Spread rather than passed through: `roots` may still be `DEFAULTS`' own array here.
    search: { roots: [...roots], depth },
    cache: { ttls },
    glyphs: takeByPosition(layers, "glyphs", DEFAULTS.glyphs),
    colours: takeByPosition(layers, "colours", DEFAULTS.colours),
  };
}
