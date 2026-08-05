/**
 * The cache layer, driven against a real filesystem.
 *
 * Nothing here is mocked. Every case creates a throwaway root under the system temp
 * directory and exercises the real `open`/`rename`/`utimes` calls, because the properties
 * under test — atomic replacement, mtime staleness, touch-debounce — are properties of the
 * filesystem rather than of this module's arithmetic. A stubbed `fs` would let all three
 * pass while the real thing corrupted a cache.
 *
 * The staleness and debounce cases manipulate mtimes directly rather than sleeping: a test
 * that waits out a real TTL is either slow or flaky, and usually both.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { cached, cachePath, readCache, writeCache } from "../src/cache";

/** A container path with enough separators to prove the per-repo directory is flattened. */
const CONTAINER = "/Users/me/GitLocal/thing";

/** What {@link CONTAINER} must collapse to — one segment, separators folded to `_`. */
const CONTAINER_SLUG = "_Users_me_GitLocal_thing";

/** Runs `body` against a throwaway cache root, removed afterwards even on failure. */
async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "wrk-cache-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Runs `body` with `XDG_CACHE_HOME` set to `value`, or unset when it is `undefined`. */
function withXdgCacheHome(value: string | undefined, body: () => void): void {
  const previous = process.env.XDG_CACHE_HOME;
  if (value === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = value;
  }
  try {
    body();
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = previous;
    }
  }
}

/** Backdates an entry so it reads as older than any TTL the tests use. */
async function age(path: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await utimes(path, when, when);
}

describe("cachePath", () => {
  test("roots under $XDG_CACHE_HOME when it is an absolute path", () => {
    withXdgCacheHome("/xdg/cache", () => {
      expect(cachePath({ name: "pr-graph", container: CONTAINER })).toBe(
        join("/xdg/cache", "wrk", CONTAINER_SLUG, "pr-graph"),
      );
    });
  });

  test("falls back to $HOME/.cache when XDG_CACHE_HOME is unset", () => {
    withXdgCacheHome(undefined, () => {
      expect(cachePath({ name: "pr-graph", container: CONTAINER })).toBe(
        join(homedir(), ".cache", "wrk", CONTAINER_SLUG, "pr-graph"),
      );
    });
  });

  test("falls back when XDG_CACHE_HOME is set but empty", () => {
    // An exported-but-empty variable is how a shell says "unset" in practice. Taking it
    // literally would `join("", …)` into a relative path under whatever directory the user
    // happened to be standing in.
    withXdgCacheHome("", () => {
      expect(cachePath({ name: "pr-graph", container: CONTAINER })).toBe(
        join(homedir(), ".cache", "wrk", CONTAINER_SLUG, "pr-graph"),
      );
    });
  });

  test("falls back when XDG_CACHE_HOME is relative", () => {
    // Required by the XDG base directory spec: a relative value is invalid and ignored.
    withXdgCacheHome("relative/cache", () => {
      expect(cachePath({ name: "pr-graph", container: CONTAINER })).toBe(
        join(homedir(), ".cache", "wrk", CONTAINER_SLUG, "pr-graph"),
      );
    });
  });

  test("keys the per-repo directory on the container path, separators folded", () => {
    expect(cachePath({ name: "pr-graph", container: CONTAINER, root: "/root" })).toBe(
      join("/root", CONTAINER_SLUG, "pr-graph"),
    );
  });

  test("keeps a dot-only container inside the cache root", () => {
    // The traversal `cacheSlug` was fixed for: a container of `..` must not resolve to the
    // cache root's parent. Asserted here as well as in the naming suite because this is the
    // call site where escaping the root would actually matter.
    const path = cachePath({ name: "pr-graph", container: "..", root: "/root" });

    expect(path.startsWith("/root/")).toBe(true);
  });

  test("keeps a name built from parent-directory segments inside the cache root", () => {
    const path = cachePath({ name: "../../elsewhere", container: CONTAINER, root: "/root" });

    expect(path.startsWith(join("/root", CONTAINER_SLUG, "/"))).toBe(true);
  });
});

describe("writeCache", () => {
  test("creates the per-repo directory and round-trips through readCache", async () => {
    await withRoot(async (root) => {
      const key = { name: "pr-graph", container: CONTAINER, root };

      await writeCache(key, "one\ttwo\n");

      expect(await readCache(key)).toBe("one\ttwo\n");
    });
  });

  test("leaves no temp file behind", async () => {
    await withRoot(async (root) => {
      const key = { name: "pr-graph", container: CONTAINER, root };

      await writeCache(key, "value");

      expect(await readdir(join(root, CONTAINER_SLUG))).toEqual(["pr-graph"]);
    });
  });

  test("replaces an existing entry rather than appending to it", async () => {
    await withRoot(async (root) => {
      const key = { name: "pr-graph", container: CONTAINER, root };

      await writeCache(key, "old");
      await writeCache(key, "new");

      expect(await readCache(key)).toBe("new");
    });
  });
});

describe("readCache", () => {
  test("returns null for an entry that was never written", async () => {
    await withRoot(async (root) => {
      expect(await readCache({ name: "absent", container: CONTAINER, root })).toBeNull();
    });
  });

  test("returns a stale entry — age is `cached`'s concern, not this one's", async () => {
    await withRoot(async (root) => {
      const key = { name: "pr-graph", container: CONTAINER, root };
      await writeCache(key, "ancient");
      await age(cachePath(key), 86_400_000);

      expect(await readCache(key)).toBe("ancient");
    });
  });
});

describe("cached", () => {
  test("serves a fresh entry without calling refresh", async () => {
    await withRoot(async (root) => {
      const key = { name: "pr-graph", container: CONTAINER, root };
      await writeCache(key, "fresh");
      let calls = 0;

      const value = await cached(key, 60_000, async () => {
        calls++;
        return "refreshed";
      });

      expect(value).toBe("fresh");
      expect(calls).toBe(0);
    });
  });

  test("refreshes an entry older than the TTL and writes the result back", async () => {
    await withRoot(async (root) => {
      const key = { name: "pr-graph", container: CONTAINER, root };
      await writeCache(key, "stale");
      await age(cachePath(key), 90_000);

      const value = await cached(key, 60_000, async () => "refreshed");

      expect(value).toBe("refreshed");
      expect(await readCache(key)).toBe("refreshed");
    });
  });

  test("refreshes when there is no entry at all", async () => {
    await withRoot(async (root) => {
      const key = { name: "pr-graph", container: CONTAINER, root };

      expect(await cached(key, 60_000, async () => "first")).toBe("first");
      expect(await readCache(key)).toBe("first");
    });
  });

  test("keeps the previous entry byte-identical when refresh rejects", async () => {
    await withRoot(async (root) => {
      const key = { name: "pr-graph", container: CONTAINER, root };
      await writeCache(key, "previous");
      await age(cachePath(key), 90_000);

      const value = await cached(key, 60_000, () => Promise.reject(new Error("gh exploded")));

      expect(value).toBe("previous");
      expect(await readFile(cachePath(key), "utf8")).toBe("previous");
      expect(await readdir(join(root, CONTAINER_SLUG))).toEqual(["pr-graph"]);
    });
  });

  test("propagates the failure when refresh rejects and nothing was cached", async () => {
    await withRoot(async (root) => {
      const key = { name: "pr-graph", container: CONTAINER, root };

      await expect(
        cached(key, 60_000, () => Promise.reject(new Error("gh exploded"))),
      ).rejects.toThrow("gh exploded");
    });
  });

  test("debounces a second call made while the first is still refreshing", async () => {
    await withRoot(async (root) => {
      const key = { name: "pr-graph", container: CONTAINER, root };
      await writeCache(key, "old");
      await age(cachePath(key), 90_000);

      let calls = 0;
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<string>();

      const first = cached(key, 60_000, () => {
        calls++;
        started.resolve();
        return finish.promise;
      });

      // Only once the first refresh has begun has its touch provably landed. Racing the
      // two calls instead would test the event-loop ordering, not the debounce.
      await started.promise;

      const second = await cached(key, 60_000, () => {
        calls++;
        return Promise.resolve("second refresh");
      });

      expect(second).toBe("old");
      expect(calls).toBe(1);

      finish.resolve("refreshed");
      expect(await first).toBe("refreshed");
      expect(await readCache(key)).toBe("refreshed");
    });
  });

  test("does not create an entry when there is nothing to touch", async () => {
    // A cold start deliberately skips the debounce: touching a missing entry means creating
    // it empty, and a concurrent reader would then get "" presented as valid data.
    await withRoot(async (root) => {
      const key = { name: "pr-graph", container: CONTAINER, root };
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<string>();

      const first = cached(key, 60_000, () => {
        started.resolve();
        return finish.promise;
      });
      await started.promise;

      expect(await readCache(key)).toBeNull();

      finish.resolve("first");
      await first;
    });
  });
});

test("a failed rename leaves the entry alone and clears the staging file", async () => {
  // The rename is the only thing that mutates the entry, and this is the deterministic way
  // to prove it: make the rename fail while the write itself succeeds. A non-empty
  // directory standing where the entry belongs cannot be renamed over, so `writeCache`
  // throws *after* staging its value — and the criterion "renamed into place on success
  // only" says the entry must be untouched and no debris left behind.
  //
  // In-process interleaving cannot test this instead: reads and writes only alternate at
  // await points, so an in-place `writeFile` is never caught half-done. The genuine
  // atomicity check is the cross-process probe run against a real filesystem.
  await withRoot(async (root) => {
    const key = { name: "pr-graph", container: CONTAINER, root };
    const path = cachePath(key);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "occupant"), "not the cache's to delete");

    await expect(writeCache(key, "value")).rejects.toThrow();

    expect(await readdir(path)).toEqual(["occupant"]);
    expect(await readdir(join(root, CONTAINER_SLUG))).toEqual(["pr-graph"]);
  });
});

test("a concurrent writer's temp file does not collide with ours", async () => {
  // The per-process temp name. Simulated here by planting a foreign process's staging file
  // and checking our write neither reads it nor removes it.
  await withRoot(async (root) => {
    const key = { name: "pr-graph", container: CONTAINER, root };
    await writeCache(key, "seed");
    const foreign = `${cachePath(key)}.999999.tmp`;
    await writeFile(foreign, "someone else's half-written file");

    await writeCache(key, "ours");

    expect(await readCache(key)).toBe("ours");
    expect(await readFile(foreign, "utf8")).toBe("someone else's half-written file");
  });
});
