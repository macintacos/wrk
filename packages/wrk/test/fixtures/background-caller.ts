/**
 * One invocation of the background read-through, as a whole process.
 *
 * Not a test file, and deliberately outside the `*.test.ts` glob `bun test` collects. It
 * exists because the property `pr.test.ts` measures through it is a property of the
 * *process*: the refresh must outlive this invocation without holding any descriptor of
 * it, and neither half of that is observable from inside one event loop. Called in-process,
 * a `pullRequests` that spawned a child sharing this process's stdout would look identical
 * to one that did not — the promise resolves either way, and only a reader on the far end
 * of the pipe ever finds out.
 *
 * So the caller measures two clocks against this: how long until stdout reaches EOF, and
 * how long until the process exits. A refresh holding either descriptor moves the first;
 * a refresh still referenced by the event loop moves the second.
 *
 * Everything it needs arrives through the environment, as `cached-worker.ts`'s does. The
 * row count goes to stdout — enough to say *which* answer was served, since the fixture is
 * seeded with one row and the fake `gh` answers with two.
 */

import { pullRequests } from "../../src/pr";

/** Reads a required environment variable, failing loudly rather than defaulting. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);

  return value;
}

const container = required("WRK_CONTAINER");
const root = required("WRK_CACHE_ROOT");
const ttl = Number(required("WRK_TTL"));

const prs = await pullRequests(container, ttl, { root, background: true });

process.stdout.write(`${prs.size}\n`);
