/**
 * Config resolution, driven against a real filesystem.
 *
 * Nothing is mocked. Every case writes a real file into a throwaway directory and reads it
 * back through `loadConfig`, because the behaviour under test is almost entirely about
 * what happens to files the module does not control — absent, truncated, unreadable, or
 * carrying a key that belongs to some other tool. A stubbed `fs` would let every one of
 * those pass while the real thing threw at a shell prompt.
 *
 * The two layers are written in the two formats they actually use: the global fixtures are
 * TOML, the per-repo ones JSON. Global fixtures are written as **literal text**, never
 * through a serialiser, so each case pins what the parser does with the bytes a human
 * would type — which is the only kind of fixture that can express a duplicate key or an
 * unterminated table header at all.
 *
 * The per-repo fixtures are shaped like the `.project-meta.json` files that actually exist
 * on this machine — a top-level `search` key owned by a different tool — so the namespacing
 * is pinned against the real hazard rather than against a convenient invention.
 */

import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULTS, globalConfigPath, loadConfig } from "../src/config";

/** Runs `body` against a throwaway directory, removed afterwards even on failure. */
async function withTemp(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "wrk-config-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Runs `body` with `XDG_CONFIG_HOME` set to `value`, or unset when it is `undefined`.
 *
 * Accepts an async body so a case can `await loadConfig()` — the default-path case has to,
 * since the variable must still be set when the read happens.
 */
async function withXdgConfigHome(
  value: string | undefined,
  body: () => void | Promise<void>,
): Promise<void> {
  const previous = process.env.XDG_CONFIG_HOME;
  if (value === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = value;
  }
  try {
    await body();
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previous;
    }
  }
}

/** Writes `value` as JSON at `path`, creating its parent directory. For the per-repo layer. */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

/** Writes `text` verbatim at `path`. Every global-layer fixture goes through this. */
async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

/** Writes a container's `.project-meta.json` and returns the container path. */
async function withMeta(dir: string, meta: unknown): Promise<string> {
  const container = join(dir, "container");
  await writeJson(join(container, ".project-meta.json"), meta);
  return container;
}

/** A `.project-meta.json` body carrying only the neighbouring tool's top-level `search`. */
const FOREIGN_META = { search: { externalPaths: ["~/GitLocal", "~/.config"] } };

describe("globalConfigPath", () => {
  test("roots under $XDG_CONFIG_HOME when it is an absolute path", async () => {
    await withXdgConfigHome("/xdg/config", () => {
      expect(globalConfigPath()).toBe(join("/xdg/config", "wrk", "config.toml"));
    });
  });

  test("falls back to $HOME/.config when XDG_CONFIG_HOME is unset", async () => {
    await withXdgConfigHome(undefined, () => {
      expect(globalConfigPath()).toBe(join(homedir(), ".config", "wrk", "config.toml"));
    });
  });

  test("falls back when XDG_CONFIG_HOME is set but empty", async () => {
    // An exported-but-empty variable is how a shell says "unset" in practice; taking it
    // literally would `join("", …)` into a path relative to the cwd.
    await withXdgConfigHome("", () => {
      expect(globalConfigPath()).toBe(join(homedir(), ".config", "wrk", "config.toml"));
    });
  });

  test("falls back when XDG_CONFIG_HOME is relative", async () => {
    // Required by the XDG base directory spec: a relative value is invalid and ignored.
    await withXdgConfigHome("relative/config", () => {
      expect(globalConfigPath()).toBe(join(homedir(), ".config", "wrk", "config.toml"));
    });
  });

  test("is where loadConfig looks when it is given no globalPath", async () => {
    // Without this, nothing exercises `loadConfig`'s default argument — the module's main
    // user-facing path, and the one the README tells people to create. `XDG_CONFIG_HOME`
    // is redirected at the temp dir so the case cannot read a real ~/.config/wrk.
    await withTemp(async (dir) => {
      await writeText(join(dir, "wrk", "config.toml"), "[search]\ndepth = 9\n");

      await withXdgConfigHome(dir, async () => {
        expect((await loadConfig()).search.depth).toBe(9);
      });
    });
  });
});

describe("DEFAULTS", () => {
  test("reproduces the fish implementation this package replaces", () => {
    // The glyphs are Nerd Font private-use code points — U+F062, U+F063 and U+F00C — and
    // render as blanks in an editor without that font. They are asserted as literals
    // rather than as escapes so this stays a comparison against the bytes on disk.
    expect(DEFAULTS).toEqual({
      search: { roots: [join(homedir(), "GitLocal")], depth: 2 },
      cache: { ttls: { "pr-graph": 900_000 } },
      glyphs: { top: "", bottom: "", merged: "" },
      colours: { top: "green", bottom: "yellow", merged: "brblack" },
    });
  });

  test("survives a caller mutating a config it was handed", async () => {
    // Only the array and the two records can alias — a scalar cannot, so mutating `depth`
    // would pass against an implementation that handed back `DEFAULTS`' own objects.
    //
    // The expected values are captured *before* the mutation rather than read off
    // `DEFAULTS` afterwards. Asserting against `DEFAULTS` post-mutation compares a
    // corrupted object with itself and can never fail, which is exactly how an aliasing
    // implementation slips through.
    await withTemp(async (dir) => {
      const globalPath = join(dir, "absent.toml");
      const before = {
        roots: [...DEFAULTS.search.roots],
        ttl: DEFAULTS.cache.ttls["pr-graph"],
        glyph: DEFAULTS.glyphs.top,
      };

      const config = await loadConfig({ globalPath });
      // Through `unknown` because the cast deliberately strips `readonly` — the point is
      // to do what the type system forbids and prove the runtime holds up anyway.
      const mutable = config as unknown as {
        search: { roots: string[] };
        cache: { ttls: Record<string, number> };
        glyphs: { top: string };
      };
      mutable.search.roots.push("/injected");
      mutable.cache.ttls["pr-graph"] = 1;
      mutable.glyphs.top = "X";

      expect(DEFAULTS.search.roots).toEqual(before.roots);
      expect(DEFAULTS.cache.ttls["pr-graph"]).toBe(before.ttl);
      expect(DEFAULTS.glyphs.top).toBe(before.glyph);

      const fresh = await loadConfig({ globalPath });
      expect(fresh.search.roots).toEqual(before.roots);
      expect(fresh.cache.ttls["pr-graph"]).toBe(before.ttl);
      expect(fresh.glyphs.top).toBe(before.glyph);
    });
  });
});

describe("loadConfig layering", () => {
  test("returns the defaults when neither layer exists", async () => {
    await withTemp(async (dir) => {
      expect(await loadConfig({ globalPath: join(dir, "absent.toml") })).toEqual(DEFAULTS);
    });
  });

  test("returns the defaults when the container holds no .project-meta.json", async () => {
    await withTemp(async (dir) => {
      const container = join(dir, "bare-container");
      await mkdir(container, { recursive: true });

      expect(await loadConfig({ container, globalPath: join(dir, "absent.toml") })).toEqual(
        DEFAULTS,
      );
    });
  });

  test("takes the global layer over the defaults", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, '[search]\ndepth = 4\n\n[glyphs]\nmerged = "M"\n');

      const config = await loadConfig({ globalPath });
      expect(config.search.depth).toBe(4);
      expect(config.glyphs.merged).toBe("M");
      expect(config.glyphs.top).toBe(DEFAULTS.glyphs.top);
      expect(config.search.roots).toEqual(DEFAULTS.search.roots);
    });
  });

  test("takes the per-repo wrk namespace over the defaults", async () => {
    await withTemp(async (dir) => {
      const container = await withMeta(dir, { wrk: { search: { depth: 3 } } });

      const config = await loadConfig({ container, globalPath: join(dir, "absent.toml") });
      expect(config.search.depth).toBe(3);
    });
  });

  test("takes the per-repo layer over the global layer, field by field", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(
        globalPath,
        '[search]\ndepth = 4\nroots = ["/from-global"]\n\n[colours]\ntop = "blue"\nmerged = "cyan"\n',
      );
      const container = await withMeta(dir, {
        ...FOREIGN_META,
        wrk: { search: { depth: 7 }, colours: { top: "red" } },
      });

      const config = await loadConfig({ container, globalPath });
      expect(config.search.depth).toBe(7);
      expect(config.colours.top).toBe("red");
      // Set only globally, so it must survive the per-repo layer landing on top.
      expect(config.search.roots).toEqual(["/from-global"]);
      expect(config.colours.merged).toBe("cyan");
      // Set by neither, so it must still be the default.
      expect(config.colours.bottom).toBe(DEFAULTS.colours.bottom);
    });
  });

  test("ignores a .project-meta.json that carries no wrk key", async () => {
    // The real files on this machine carry a top-level `search` owned by another tool.
    // Reading that as `wrk.search` would silently import a foreign tool's settings.
    await withTemp(async (dir) => {
      const container = await withMeta(dir, FOREIGN_META);

      expect(await loadConfig({ container, globalPath: join(dir, "absent.toml") })).toEqual(
        DEFAULTS,
      );
    });
  });

  test("never reads a neighbouring top-level key that collides with wrk's own sections", async () => {
    // The hostile shape of the case above: the neighbouring tool's keys are named exactly
    // like `wrk`'s sections and carry values a naive read would happily accept. Only the
    // contents of `wrk` may land, so `depth` is 3 and everything else stays default.
    await withTemp(async (dir) => {
      const container = await withMeta(dir, {
        search: { depth: 99, roots: ["/foreign"] },
        glyphs: { top: "X" },
        cache: { ttls: { "pr-graph": 1 } },
        wrk: { search: { depth: 3 } },
      });

      const config = await loadConfig({ container, globalPath: join(dir, "absent.toml") });
      expect(config.search.depth).toBe(3);
      expect(config.search.roots).toEqual(DEFAULTS.search.roots);
      expect(config.glyphs.top).toBe(DEFAULTS.glyphs.top);
      expect(config.cache.ttls["pr-graph"]).toBe(DEFAULTS.cache.ttls["pr-graph"]);
    });
  });

  test("ignores a wrk key in the global file, whose sections sit at the root", async () => {
    // The other half of the asymmetric namespacing, and the mistake a user makes straight
    // after reading the per-repo example: a `wrk` wrapper belongs only in .project-meta.json.
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, "[wrk.search]\ndepth = 4\n");

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });

  test("ignores a wrk key that is not an object", async () => {
    await withTemp(async (dir) => {
      const container = await withMeta(dir, { wrk: "yes please" });

      expect(await loadConfig({ container, globalPath: join(dir, "absent.toml") })).toEqual(
        DEFAULTS,
      );
    });
  });

  test("skips the per-repo layer when no container is given", async () => {
    await withTemp(async (dir) => {
      // A `null` container is what `containerFor` answers outside a repository.
      expect(await loadConfig({ container: null, globalPath: join(dir, "absent.toml") })).toEqual(
        DEFAULTS,
      );
    });
  });
});

describe("loadConfig degrades silently", () => {
  test("ignores an unterminated table header", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, "[search\ndepth = 4\n");

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });

  test("ignores a document that redefines a key", async () => {
    // A duplicate key is a document error in TOML, not a last-one-wins merge as it is in
    // most JSON parsers — so the whole layer goes, which is the documented behaviour for a
    // document that cannot be read at all.
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, "[search]\ndepth = 1\ndepth = 2\n");

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });

  test("ignores a document carrying an integer too large to represent losslessly", async () => {
    // smol-toml refuses rather than silently rounding, so this is a document error too.
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, "[cache.ttls]\npr-graph = 9007199254740993\n");

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });

  test("ignores an empty file", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, "");

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });

  test("ignores a file it cannot read", async () => {
    // Root can read a 0o000 file regardless of its mode, so the case is unprovable there.
    if (process.getuid?.() === 0) return;

    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, "[search]\ndepth = 4\n");
      await chmod(globalPath, 0o000);

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });

  test("ignores a directory where the config file should be", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await mkdir(globalPath, { recursive: true });

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });

  test("ignores a truncated .project-meta.json", async () => {
    await withTemp(async (dir) => {
      const container = join(dir, "container");
      await writeText(join(container, ".project-meta.json"), '{"wrk": {"search": {"depth": 4');

      expect(await loadConfig({ container, globalPath: join(dir, "absent.toml") })).toEqual(
        DEFAULTS,
      );
    });
  });

  test("ignores a .project-meta.json that is a JSON array at the root", async () => {
    // A TOML document root is always a table, so only the JSON layer can be shaped like
    // this — and only this layer's guard against it can be exercised.
    await withTemp(async (dir) => {
      const container = await withMeta(dir, [{ wrk: { search: { depth: 4 } } }]);

      expect(await loadConfig({ container, globalPath: join(dir, "absent.toml") })).toEqual(
        DEFAULTS,
      );
    });
  });

  test("ignores a .project-meta.json that is a JSON scalar at the root", async () => {
    await withTemp(async (dir) => {
      const container = await withMeta(dir, "depth 4 please");

      expect(await loadConfig({ container, globalPath: join(dir, "absent.toml") })).toEqual(
        DEFAULTS,
      );
    });
  });
});

describe("loadConfig field validation", () => {
  test("ignores a roots that is not an array, keeping its well-formed sibling", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, '[search]\nroots = "/one-root"\ndepth = 5\n');

      const config = await loadConfig({ globalPath });
      expect(config.search.roots).toEqual(DEFAULTS.search.roots);
      expect(config.search.depth).toBe(5);
    });
  });

  test("drops non-string entries from roots and keeps the rest", async () => {
    // TOML 1.0 permits a heterogeneous array, so this is a document a user can really write.
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, '[search]\nroots = ["/keep", 7, ["nested"], "/also-keep"]\n');

      expect((await loadConfig({ globalPath })).search.roots).toEqual(["/keep", "/also-keep"]);
    });
  });

  test("rejects a depth that is not a non-negative integer", async () => {
    await withTemp(async (dir) => {
      // TOML has no null literal, but it does have `nan` — a float that reaches the config
      // out of a perfectly well-formed document.
      for (const [name, value] of Object.entries({
        string: '"2"',
        negative: "-1",
        fractional: "1.5",
        nan: "nan",
        infinite: "inf",
      })) {
        const globalPath = join(dir, `depth-${name}.toml`);
        await writeText(globalPath, `[search]\ndepth = ${value}\n`);

        expect((await loadConfig({ globalPath })).search.depth).toBe(DEFAULTS.search.depth);
      }
    });
  });

  test("accepts a depth of zero", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, "[search]\ndepth = 0\n");

      expect((await loadConfig({ globalPath })).search.depth).toBe(0);
    });
  });

  test("rejects a malformed TTL without disturbing its neighbours", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, '[cache.ttls]\npr-graph = "15m"\nstacks = -1\nbranches = 1000\n');

      const { ttls } = (await loadConfig({ globalPath })).cache;
      expect(ttls["pr-graph"]).toBe(DEFAULTS.cache.ttls["pr-graph"]);
      expect(ttls.stacks).toBeUndefined();
      expect(ttls.branches).toBe(1000);
    });
  });

  test("accepts a TTL of zero, which means always refresh", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, "[cache.ttls]\npr-graph = 0\n");

      expect((await loadConfig({ globalPath })).cache.ttls["pr-graph"]).toBe(0);
    });
  });

  test("rejects a non-finite TTL", async () => {
    await withTemp(async (dir) => {
      // `inf` and `nan` are TOML float literals, so unlike JSON these arrive from a
      // document the parser is perfectly happy with.
      for (const [name, value] of Object.entries({ infinite: "inf", nan: "nan" })) {
        const globalPath = join(dir, `ttl-${name}.toml`);
        await writeText(globalPath, `[cache.ttls]\npr-graph = ${value}\nbranches = 1000\n`);

        const { ttls } = (await loadConfig({ globalPath })).cache;
        expect(ttls["pr-graph"]).toBe(DEFAULTS.cache.ttls["pr-graph"]);
        expect(ttls.branches).toBe(1000);
      }
    });
  });

  test("rejects an empty or non-string glyph, keeping its well-formed sibling", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, '[glyphs]\ntop = ""\nbottom = 3\nmerged = "M"\n');

      const { glyphs } = await loadConfig({ globalPath });
      expect(glyphs.top).toBe(DEFAULTS.glyphs.top);
      expect(glyphs.bottom).toBe(DEFAULTS.glyphs.bottom);
      expect(glyphs.merged).toBe("M");
    });
  });

  test("ignores an unknown key in a known section", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, '[glyphs]\nsideways = "S"\n');

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });

  test("ignores a section that is not a table", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, 'search = 4\nglyphs = "x"\ncache = []\n');

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });

  test("degrades field by field, never layer by layer", async () => {
    // The property the whole module turns on, and the one an all-or-nothing parse gets
    // wrong: this document is malformed in three separate sections at once, and every
    // well-formed value in it must still land. An implementation that discards a layer on
    // its first bad field returns DEFAULTS for all six assertions.
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(
        globalPath,
        [
          "[search]",
          'roots = ["/good/root"]',
          'depth = "not a number"',
          "",
          "[cache.ttls]",
          'pr-graph = "15m"',
          "branches = 1234",
          "",
          "[glyphs]",
          "top = 7",
          'merged = "M"',
          "",
        ].join("\n"),
      );

      const config = await loadConfig({ globalPath });
      expect(config.search.roots).toEqual(["/good/root"]);
      expect(config.search.depth).toBe(DEFAULTS.search.depth);
      expect(config.cache.ttls["pr-graph"]).toBe(DEFAULTS.cache.ttls["pr-graph"]);
      expect(config.cache.ttls.branches).toBe(1234);
      expect(config.glyphs.top).toBe(DEFAULTS.glyphs.top);
      expect(config.glyphs.merged).toBe("M");
    });
  });
});

describe("loadConfig root expansion", () => {
  test("expands a leading ~/ against the home directory", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, '[search]\nroots = ["~/Code/work"]\n');

      expect((await loadConfig({ globalPath })).search.roots).toEqual([
        join(homedir(), "Code/work"),
      ]);
    });
  });

  test("expands a bare ~ to the home directory", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, '[search]\nroots = ["~"]\n');

      expect((await loadConfig({ globalPath })).search.roots).toEqual([homedir()]);
    });
  });

  test("passes an already-absolute root through untouched", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, '[search]\nroots = ["/srv/repos"]\n');

      expect((await loadConfig({ globalPath })).search.roots).toEqual(["/srv/repos"]);
    });
  });

  test("falls through when every root is relative", async () => {
    // A root that is not absolute would be scanned from wherever the user happened to be
    // standing, so a typo'd `GitLocal` must yield the defaults rather than a search of
    // somewhere arbitrary. `~other` is deliberately among them: another user's home is not
    // expanded, so it stays relative and is dropped like any other relative root.
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, '[search]\nroots = ["GitLocal", "./repos", "~other/repos"]\n');

      expect((await loadConfig({ globalPath })).search.roots).toEqual(DEFAULTS.search.roots);
    });
  });

  test("falls through on an empty roots array", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, "[search]\nroots = []\n");

      expect((await loadConfig({ globalPath })).search.roots).toEqual(DEFAULTS.search.roots);
    });
  });
});

describe("loadConfig merge semantics", () => {
  test("replaces roots wholesale rather than appending to the defaults", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, '[search]\nroots = ["/only/this"]\n');

      expect((await loadConfig({ globalPath })).search.roots).toEqual(["/only/this"]);
    });
  });

  test("merges ttls key by key across all three layers", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.toml");
      await writeText(globalPath, "[cache.ttls]\nstacks = 111\nbranches = 222\n");
      const container = await withMeta(dir, { wrk: { cache: { ttls: { branches: 333 } } } });

      const { ttls } = (await loadConfig({ container, globalPath })).cache;
      expect(ttls).toEqual({ "pr-graph": 900_000, stacks: 111, branches: 333 });
    });
  });
});
