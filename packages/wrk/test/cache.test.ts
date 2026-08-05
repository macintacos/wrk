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
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
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

  test("replaces the entry by rename rather than writing over it", async () => {
    // The inode is the witness. An entry written in place keeps its inode; one renamed over
    // is a different file, so a `writeFile(path, …)` implementation fails here and only
    // here — every other case in this suite passes with atomicity removed.
    //
    // File permissions are not a usable witness: Bun writes straight through a read-only
    // entry the process owns, so a 0444 entry proves nothing about which call replaced it.
    await withRoot(async (root) => {
      const key = { name: "pr-graph", container: CONTAINER, root };
      await writeCache(key, "old");
      const before = (await stat(cachePath(key))).ino;

      await writeCache(key, "new");

      expect((await stat(cachePath(key))).ino).not.toBe(before);
    });
  });

  test("survives two concurrent writes to the same key in one process", async () => {
    // A staging name unique per process but not per call makes the two writes share one
    // temp file: the first rename publishes the second's bytes and the second rename fails
    // with ENOENT, so a caller whose promise resolved did not write what is on disk.
    await withRoot(async (root) => {
      const key = { name: "pr-graph", container: CONTAINER, root };
      const first = "a".repeat(4_000_000);
      const second = "b".repeat(4_000_000);

      const settled = await Promise.allSettled([writeCache(key, first), writeCache(key, second)]);

      expect(settled.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
      const stored = await readCache(key);
      expect(stored === first || stored === second).toBe(true);
      expect(await readdir(join(root, CONTAINER_SLUG))).toEqual(["pr-graph"]);
    });
  });

  test("a failed rename leaves the entry alone and clears the staging file", async () => {
    // The rename is the only thing that mutates the entry, and this is the deterministic
    // way to prove it cleans up after itself: a non-empty directory standing where the
    // entry belongs cannot be renamed over, so `writeCache` throws after staging its value.
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

  test("does not sweep away temp files it did not create", async () => {
    // The cleanup path removes its own staging file by name and nothing else, so another
    // process's half-written file survives a write here.
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
});

describe("readCache", () => {
  test("returns null for an entry that was never written", async () => {
    await withRoot(async (root) => {
      expect(await readCache({ name: "absent", container: CONTAINER, root })).toBeNull();
    });
  });

  test("reports an unreadable entry as a fault rather than a miss", async () => {
    // A file standing where the per-repo directory belongs makes the open fail with ENOTDIR
    // rather than ENOENT. Collapsing that to a miss would turn a broken cache root into an
    // unexplained refresh on every single invocation, which is the failure this distinction
    // exists to prevent.
    await withRoot(async (root) => {
      await writeFile(join(root, CONTAINER_SLUG), "not a directory");

      await expect(readCache({ name: "pr-graph", container: CONTAINER, root })).rejects.toThrow();
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

  test("surfaces a write failure rather than serving stale over a good refresh", async () => {
    // Only `refresh` gets the stale fallback. With `writeCache` inside the same `try`, an
    // unwritable cache directory makes a successful refresh indistinguishable from a failed
    // one, and the caller is handed stale text it had already paid the round-trip to
    // replace.
    await withRoot(async (root) => {
      const key = { name: "pr-graph", container: CONTAINER, root };
      await writeCache(key, "previous");
      await age(cachePath(key), 90_000);
      const dir = join(root, CONTAINER_SLUG);
      await chmod(dir, 0o555);

      try {
        await expect(cached(key, 60_000, async () => "fresh")).rejects.toThrow();
      } finally {
        // withRoot cannot remove the tree through a directory it may not write.
        await chmod(dir, 0o755);
      }
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

  test("starts one refresh per burst when whole processes find the same stale entry", async () => {
    // Real processes, because that is the only shape the defect has: within one process
    // the calls share an event loop, so the first `touch` lands before the second reads
    // the mtime and the debounce appears to work. Each worker records its refresh by
    // name in that burst's marker directory, so the count is the number of refreshes.
    //
    // Three bursts rather than one, and the whole sequence is the assertion. A single
    // burst is not a guard: this machine has more logical cores than performance cores,
    // so a worker scheduled onto a slow one wakes late enough to read a stamped mtime
    // honestly, and roughly one unfixed burst in six looks correct by luck. Three
    // independent bursts put that below a percent while a locked implementation stays
    // exactly `[1, 1, 1]`.
    await withRoot(async (root) => {
      const refreshes: number[] = [];

      for (let burst = 0; burst < 3; burst++) {
        const key = { name: "pr-graph", container: CONTAINER, root: join(root, `burst-${burst}`) };
        await writeCache(key, "stale");
        await age(cachePath(key), 90_000);

        const markers = join(root, `markers-${burst}`);
        await mkdir(markers, { recursive: true });

        const workers = Array.from({ length: 8 }, () =>
          Bun.spawn(["bun", join(import.meta.dir, "fixtures", "cached-worker.ts")], {
            env: {
              ...process.env,
              WRK_CACHE_ROOT: key.root,
              WRK_CONTAINER: key.container,
              WRK_ENTRY: key.name,
              WRK_TTL: "60000",
              WRK_DEADLINE: String(Date.now() + 750),
              WRK_MARKERS: markers,
            },
            stdout: "pipe",
            stderr: "pipe",
          }),
        );

        const outcomes = await Promise.all(
          workers.map(async (child) => ({
            code: await child.exited,
            err: await new Response(child.stderr).text(),
          })),
        );

        // Reported as stderr rather than as exit codes so a worker that died carries its
        // own stack trace into the failure message.
        const died = outcomes.filter((outcome) => outcome.code !== 0);
        expect(died.map((outcome) => outcome.err)).toEqual([]);

        refreshes.push((await readdir(markers)).length);
      }

      expect(refreshes).toEqual([1, 1, 1]);
    });
  }, 30_000);

  test("publishes nothing until the first refresh completes", async () => {
    // What a cold start must not do. `utimes` cannot create the entry, so there is no mtime
    // to stamp and no way to debounce the first burst; the tempting fix — staking a claim by
    // writing the entry early — would hand a concurrent reader `""` as a valid value.
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
