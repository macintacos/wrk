/**
 * Config resolution, driven against a real filesystem.
 *
 * Nothing is mocked. Every case writes real JSON into a throwaway directory and reads it
 * back through `loadConfig`, because the behaviour under test is almost entirely about
 * what happens to files the module does not control — absent, truncated, unreadable, or
 * carrying a key that belongs to some other tool. A stubbed `fs` would let every one of
 * those pass while the real thing threw at a shell prompt.
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

/** Writes `value` as JSON at `path`, creating its parent directory. */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

/** Writes `text` verbatim at `path`, for fixtures that are deliberately not valid JSON. */
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
      expect(globalConfigPath()).toBe(join("/xdg/config", "wrk", "config.json"));
    });
  });

  test("falls back to $HOME/.config when XDG_CONFIG_HOME is unset", async () => {
    await withXdgConfigHome(undefined, () => {
      expect(globalConfigPath()).toBe(join(homedir(), ".config", "wrk", "config.json"));
    });
  });

  test("falls back when XDG_CONFIG_HOME is set but empty", async () => {
    // An exported-but-empty variable is how a shell says "unset" in practice; taking it
    // literally would `join("", …)` into a path relative to the cwd.
    await withXdgConfigHome("", () => {
      expect(globalConfigPath()).toBe(join(homedir(), ".config", "wrk", "config.json"));
    });
  });

  test("falls back when XDG_CONFIG_HOME is relative", async () => {
    // Required by the XDG base directory spec: a relative value is invalid and ignored.
    await withXdgConfigHome("relative/config", () => {
      expect(globalConfigPath()).toBe(join(homedir(), ".config", "wrk", "config.json"));
    });
  });

  test("is where loadConfig looks when it is given no globalPath", async () => {
    // Without this, nothing exercises `loadConfig`'s default argument — the module's main
    // user-facing path, and the one the README tells people to create. `XDG_CONFIG_HOME`
    // is redirected at the temp dir so the case cannot read a real ~/.config/wrk.
    await withTemp(async (dir) => {
      await writeJson(join(dir, "wrk", "config.json"), { search: { depth: 9 } });

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
      const globalPath = join(dir, "absent.json");
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
      expect(await loadConfig({ globalPath: join(dir, "absent.json") })).toEqual(DEFAULTS);
    });
  });

  test("returns the defaults when the container holds no .project-meta.json", async () => {
    await withTemp(async (dir) => {
      const container = join(dir, "bare-container");
      await mkdir(container, { recursive: true });

      expect(await loadConfig({ container, globalPath: join(dir, "absent.json") })).toEqual(
        DEFAULTS,
      );
    });
  });

  test("takes the global layer over the defaults", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, { search: { depth: 4 }, glyphs: { merged: "M" } });

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

      const config = await loadConfig({ container, globalPath: join(dir, "absent.json") });
      expect(config.search.depth).toBe(3);
    });
  });

  test("takes the per-repo layer over the global layer, field by field", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, {
        search: { depth: 4, roots: ["/from-global"] },
        colours: { top: "blue", merged: "cyan" },
      });
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

      expect(await loadConfig({ container, globalPath: join(dir, "absent.json") })).toEqual(
        DEFAULTS,
      );
    });
  });

  test("ignores a wrk key in the global file, whose sections sit at the root", async () => {
    // The other half of the asymmetric namespacing, and the mistake a user makes straight
    // after reading the per-repo example: a `wrk` wrapper belongs only in .project-meta.json.
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, { wrk: { search: { depth: 4 } } });

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });

  test("ignores a wrk key that is not an object", async () => {
    await withTemp(async (dir) => {
      const container = await withMeta(dir, { wrk: "yes please" });

      expect(await loadConfig({ container, globalPath: join(dir, "absent.json") })).toEqual(
        DEFAULTS,
      );
    });
  });

  test("skips the per-repo layer when no container is given", async () => {
    await withTemp(async (dir) => {
      // A `null` container is what `containerFor` answers outside a repository.
      expect(await loadConfig({ container: null, globalPath: join(dir, "absent.json") })).toEqual(
        DEFAULTS,
      );
    });
  });
});

describe("loadConfig degrades silently", () => {
  test("ignores a truncated JSON file", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeText(globalPath, '{"search": {"depth": 4');

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });

  test("ignores a JSON array at the root", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, [{ search: { depth: 4 } }]);

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });

  test("ignores a JSON scalar at the root", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, "depth 4 please");

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });

  test("ignores an empty file", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeText(globalPath, "");

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });

  test("ignores a file it cannot read", async () => {
    // Root can read a 0o000 file regardless of its mode, so the case is unprovable there.
    if (process.getuid?.() === 0) return;

    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, { search: { depth: 4 } });
      await chmod(globalPath, 0o000);

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });

  test("ignores a directory where the config file should be", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await mkdir(globalPath, { recursive: true });

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });
});

describe("loadConfig field validation", () => {
  test("ignores a roots that is not an array, keeping its well-formed sibling", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, { search: { roots: "/one-root", depth: 5 } });

      const config = await loadConfig({ globalPath });
      expect(config.search.roots).toEqual(DEFAULTS.search.roots);
      expect(config.search.depth).toBe(5);
    });
  });

  test("drops non-string entries from roots and keeps the rest", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, { search: { roots: ["/keep", 7, null, "/also-keep"] } });

      expect((await loadConfig({ globalPath })).search.roots).toEqual(["/keep", "/also-keep"]);
    });
  });

  test("rejects a depth that is not a non-negative integer", async () => {
    await withTemp(async (dir) => {
      for (const depth of ["2", -1, 1.5, Number.NaN, null]) {
        const globalPath = join(dir, `depth-${String(depth)}.json`);
        await writeJson(globalPath, { search: { depth } });

        expect((await loadConfig({ globalPath })).search.depth).toBe(DEFAULTS.search.depth);
      }
    });
  });

  test("accepts a depth of zero", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, { search: { depth: 0 } });

      expect((await loadConfig({ globalPath })).search.depth).toBe(0);
    });
  });

  test("rejects a malformed TTL without disturbing its neighbours", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, {
        cache: { ttls: { "pr-graph": "15m", stacks: -1, branches: 1000 } },
      });

      const { ttls } = (await loadConfig({ globalPath })).cache;
      expect(ttls["pr-graph"]).toBe(DEFAULTS.cache.ttls["pr-graph"]);
      expect(ttls.stacks).toBeUndefined();
      expect(ttls.branches).toBe(1000);
    });
  });

  test("accepts a TTL of zero, which means always refresh", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, { cache: { ttls: { "pr-graph": 0 } } });

      expect((await loadConfig({ globalPath })).cache.ttls["pr-graph"]).toBe(0);
    });
  });

  test("rejects a non-finite TTL", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      // `Infinity` has no JSON literal, so it is spelled as an overflowing exponent —
      // which `JSON.parse` turns into `Infinity` rather than rejecting.
      await writeText(globalPath, '{"cache": {"ttls": {"pr-graph": 1e400}}}');

      expect((await loadConfig({ globalPath })).cache.ttls["pr-graph"]).toBe(
        DEFAULTS.cache.ttls["pr-graph"],
      );
    });
  });

  test("rejects an empty or non-string glyph, keeping its well-formed sibling", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, { glyphs: { top: "", bottom: 3, merged: "M" } });

      const { glyphs } = await loadConfig({ globalPath });
      expect(glyphs.top).toBe(DEFAULTS.glyphs.top);
      expect(glyphs.bottom).toBe(DEFAULTS.glyphs.bottom);
      expect(glyphs.merged).toBe("M");
    });
  });

  test("ignores an unknown key in a known section", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, { glyphs: { sideways: "S" } });

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });

  test("ignores a section that is not an object", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, { search: 4, glyphs: null, cache: [] });

      expect(await loadConfig({ globalPath })).toEqual(DEFAULTS);
    });
  });
});

describe("loadConfig root expansion", () => {
  test("expands a leading ~/ against the home directory", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, { search: { roots: ["~/Code/work"] } });

      expect((await loadConfig({ globalPath })).search.roots).toEqual([
        join(homedir(), "Code/work"),
      ]);
    });
  });

  test("expands a bare ~ to the home directory", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, { search: { roots: ["~"] } });

      expect((await loadConfig({ globalPath })).search.roots).toEqual([homedir()]);
    });
  });

  test("passes an already-absolute root through untouched", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, { search: { roots: ["/srv/repos"] } });

      expect((await loadConfig({ globalPath })).search.roots).toEqual(["/srv/repos"]);
    });
  });

  test("falls through when every root is relative", async () => {
    // A root that is not absolute would be scanned from wherever the user happened to be
    // standing, so a typo'd `GitLocal` must yield the defaults rather than a search of
    // somewhere arbitrary. `~other` is deliberately among them: another user's home is not
    // expanded, so it stays relative and is dropped like any other relative root.
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, { search: { roots: ["GitLocal", "./repos", "~other/repos"] } });

      expect((await loadConfig({ globalPath })).search.roots).toEqual(DEFAULTS.search.roots);
    });
  });

  test("falls through on an empty roots array", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, { search: { roots: [] } });

      expect((await loadConfig({ globalPath })).search.roots).toEqual(DEFAULTS.search.roots);
    });
  });
});

describe("loadConfig merge semantics", () => {
  test("replaces roots wholesale rather than appending to the defaults", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, { search: { roots: ["/only/this"] } });

      expect((await loadConfig({ globalPath })).search.roots).toEqual(["/only/this"]);
    });
  });

  test("merges ttls key by key across all three layers", async () => {
    await withTemp(async (dir) => {
      const globalPath = join(dir, "config.json");
      await writeJson(globalPath, { cache: { ttls: { stacks: 111, branches: 222 } } });
      const container = await withMeta(dir, { wrk: { cache: { ttls: { branches: 333 } } } });

      const { ttls } = (await loadConfig({ container, globalPath })).cache;
      expect(ttls).toEqual({ "pr-graph": 900_000, stacks: 111, branches: 333 });
    });
  });
});
