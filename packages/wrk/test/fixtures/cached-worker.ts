/**
 * One process in the refresh-debounce burst that `cache.test.ts` measures.
 *
 * Not a test file, and deliberately outside the `*.test.ts` glob `bun test` collects. It
 * exists because the debounce is a property of concurrent *processes*: an in-process
 * approximation shares one event loop and one module instance, so it cannot fail against
 * an unlocked implementation for the right reason.
 *
 * Everything it needs arrives through the environment, including a shared wall-clock
 * deadline. That barrier is what makes the case a regression guard rather than a coin
 * flip — process boot jitter alone staggers the burst by more than the window being
 * tested, so without it a stampede and a correctly-serialised refresh look alike.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { cached } from "../../src/cache";

/** Reads a required environment variable, failing loudly rather than defaulting. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);

  return value;
}

const root = required("WRK_CACHE_ROOT");
const container = required("WRK_CONTAINER");
const name = required("WRK_ENTRY");
const markers = required("WRK_MARKERS");
const ttl = Number(required("WRK_TTL"));
const deadline = Number(required("WRK_DEADLINE"));

/** How long before the deadline the timed sleep hands over to the spin below. */
const SPIN_MS = 20;

const wait = deadline - Date.now();
if (wait < 0) {
  // A worker that boots too slowly to join the burst measures nothing, so it fails the
  // test loudly rather than starting late and passing for the wrong reason.
  throw new Error(`missed the barrier by ${-wait}ms`);
}
await Bun.sleep(Math.max(wait - SPIN_MS, 0));

// The last stretch is spun rather than slept. A timer wakes on roughly a millisecond
// boundary, and the window this measures — between one process reading the entry's mtime
// and another stamping it — is tens of microseconds wide, so a slept barrier lets a
// worker get far enough ahead to claim the window legitimately and the burst stops being
// a burst. Spinning costs 20ms of one core per worker and makes the release simultaneous.
while (Date.now() < deadline) {
  // Deliberately empty: the condition is the work.
}

await cached({ name, container, root }, ttl, async () => {
  await writeFile(join(markers, String(process.pid)), "");
  // Holds the refresh window open long enough that a second process racing in overlaps
  // with this one rather than arriving after it has already published.
  await Bun.sleep(300);

  return `refreshed by ${process.pid}`;
});
