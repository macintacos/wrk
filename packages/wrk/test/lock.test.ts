/**
 * The blocking half of the mutex: that a waiter really waits, that it stops waiting on a
 * lock nobody is holding, and that the lock is always removed on the way out.
 *
 * Every case drives the real filesystem in a temp directory. A mocked `mkdir` would prove
 * nothing at all here — the entire mechanism is that one syscall either creates the
 * directory or fails `EEXIST`, so a stub of it is a stub of the thing under test.
 *
 * Concurrency is in-process, which is enough and is deliberate: the exclusion is a property
 * of the directory on disk rather than of the process asking for it, so overlapping promises
 * contend exactly as overlapping processes do. `preflight.test.ts` is where real child
 * processes race, because there the contended resources are git's.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { LOCK_STALE_MS, withLock } from "../src/lock";

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "wrk-lock-")));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("withLock", () => {
  test("never lets two holders run at the same time", async () => {
    // The whole point of the module. Four callers arrive together on one lock; the counter is
    // what a serialised region looks like from inside — it is never above one.
    const lock = join(root, "exclusive.lock");
    let inside = 0;
    let highWater = 0;

    await Promise.all(
      Array.from({ length: 4 }, () =>
        withLock(lock, async () => {
          inside += 1;
          highWater = Math.max(highWater, inside);
          await sleep(20);
          inside -= 1;
        }),
      ),
    );

    expect(highWater).toBe(1);
  });

  test("returns what the work returned", async () => {
    expect(await withLock(join(root, "value.lock"), async () => 42)).toBe(42);
  });

  test("removes the lock once the work is done", async () => {
    const lock = join(root, "released.lock");

    await withLock(lock, async () => undefined);

    expect(existsSync(lock)).toBe(false);
  });

  test("removes the lock when the work throws, and rethrows", async () => {
    // The case that decides whether a single failure wedges the repository for a full
    // staleness window. The release has to be in a `finally`, not on the success path.
    const lock = join(root, "threw.lock");

    await expect(withLock(lock, () => Promise.reject(new Error("work failed")))).rejects.toThrow(
      "work failed",
    );
    expect(existsSync(lock)).toBe(false);
  });

  test("steps past a lock older than the staleness bound instead of waiting forever", async () => {
    // A holder killed mid-work leaves its lock behind and nothing else ever removes it. The
    // bound is what stops that from wedging every later caller permanently; without it this
    // case does not fail, it hangs.
    const lock = join(root, "abandoned.lock");
    mkdirSync(lock);
    const old = new Date(Date.now() - LOCK_STALE_MS - 1_000);
    utimesSync(lock, old, old);

    expect(await withLock(lock, async () => "ran anyway")).toBe("ran anyway");
  });

  test("waits for a fresh lock rather than stepping past it", async () => {
    // The other side of the bound: a lock young enough to belong to a live holder is waited
    // on. Asserted by the wait actually taking time — the waiter cannot start until the
    // holder's `finally` has removed the directory.
    const lock = join(root, "fresh.lock");
    const order: string[] = [];

    await Promise.all([
      withLock(lock, async () => {
        await sleep(60);
        order.push("holder");
      }),
      sleep(10).then(() =>
        withLock(lock, async () => {
          order.push("waiter");
        }),
      ),
    ]);

    expect(order).toEqual(["holder", "waiter"]);
  });
});
