/**
 * Contract of the preview renderer: what reaches `gh`, what reaches the cache, and when each
 * of them is skipped.
 *
 * Nothing is mocked, for the two reasons the suites this one is modelled on give. `gh` is
 * replaced by a real executable on `PATH` that logs its argv and the width it was handed, then
 * emits scripted output — the width criterion is invisible in the returned string and
 * observable only in what the child actually saw, so asserting the returned text alone would
 * stay green through a renderer that never forced a TTY at all. And the cache is a real
 * directory under the system temp root, because "a second draw does not shell out" is a
 * property of files on disk rather than of this module's arithmetic.
 *
 * The invocation log is what most cases assert on. A cache hit and a cache miss return the
 * same string by construction, so the only evidence of which one happened is whether the fake
 * ran again.
 *
 * The fake reads a line from stdin before answering, so a `gh` left with an open stdin pipe
 * would hang every case here rather than passing quietly — the same enforcement `gh.test.ts`
 * builds into its own harness.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { cachePath, writeCache } from "../src/cache";
import { DEFAULTS } from "../src/config";
import { clearPreviews, previewPullRequest } from "../src/preview";

/** Temp roots to delete once the suite finishes. */
const roots: string[] = [];

/** A container path with enough separators to prove the per-repo directory is flattened. */
const CONTAINER = "/Users/me/GitLocal/thing";

/** The pull request every case here previews. */
const PR = 22;

/** A fresh temp directory, deleted when the suite ends. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** Where the log the fake appends to lives inside a fixture root. */
function logPath(bin: string): string {
  return join(bin, "log.tsv");
}

/**
 * Quotes `text` as a single `sh` word, safely for any byte `gh` can be scripted to emit.
 *
 * The fake carries its payloads inline because `PATH` is its own directory alone during a
 * case, so a fake that shelled out to `cat` would fail for a reason unrelated to this module.
 */
function shQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** What {@link makeBin}'s fake `gh` should say and how it should exit. */
interface BinOptions {
  /** What the fake writes to stdout. */
  stdout?: string;

  /** What the fake writes to stderr. */
  stderr?: string;

  /** The fake's exit status. */
  exit?: number;
}

/**
 * A directory holding a fake `gh`, to be used as the whole of `PATH`.
 *
 * Each invocation appends one `<argv>\t<GH_FORCE_TTY>` line. The width is recorded through
 * `${VAR-unset}` rather than `${VAR:-unset}`, so an unset variable and an empty one stay
 * distinguishable — the difference between "no width was forced" and "an empty width was".
 */
function makeBin(options: BinOptions = {}): string {
  const bin = tempDir("wrk-preview-bin-");

  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `printf '%s\\t%s\\n' "$*" "\${GH_FORCE_TTY-unset}" >> ${shQuote(logPath(bin))}`,
      "read -r _ignored",
      `printf '%s' ${shQuote(options.stdout ?? "")}`,
      `printf '%s' ${shQuote(options.stderr ?? "")} >&2`,
      `exit ${options.exit ?? 0}`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

/** A `PATH` with no `gh` on it at all. */
function makeEmptyBin(): string {
  return tempDir("wrk-preview-nogh-");
}

/** One recorded invocation of the fake: its argv, and the width it was told to render at. */
interface Invocation {
  argv: string;
  width: string;
}

/** Every invocation the fake recorded, in order. */
function recorded(bin: string): Invocation[] {
  const log = logPath(bin);
  if (!existsSync(log)) return [];

  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [argv = "", width = ""] = line.split("\t");
      return { argv, width };
    });
}

/** A throwaway cache root, deleted when the suite ends. */
function cacheRoot(): string {
  return tempDir("wrk-preview-cache-");
}

/**
 * The per-repo directory a container's entries land in under `root`.
 *
 * Derived through `cachePath` rather than spelled out, so these cases pin this module's
 * behaviour without also pinning `cacheSlug`'s folding rule, which they do not own.
 */
function containerDir(root: string, container = CONTAINER): string {
  return dirname(cachePath({ name: "any", container, root }));
}

/** Every entry the cache holds for `container`, by filename, sorted. */
async function entries(root: string, container = CONTAINER): Promise<string[]> {
  return (await readdir(containerDir(root, container))).sort();
}

/** Rewinds an entry's mtime by `ageMs`, which is what {@link previewPullRequest} ages on. */
async function backdate(path: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
}

/** The variables these cases mutate on `process.env`, snapshotted so each starts clean. */
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("previewPullRequest", () => {
  test("renders through gh at the pane's exact width", async () => {
    const bin = makeBin({ stdout: "#22 Simplify README\n" });
    process.env.PATH = bin;

    const text = await previewPullRequest(PR, 100, { container: CONTAINER, root: cacheRoot() });

    expect(text).toBe("#22 Simplify README\n");
    expect(recorded(bin)).toEqual([{ argv: "pr view 22", width: "100" }]);
  });

  test("serves a redraw at the same width without shelling out again", async () => {
    const bin = makeBin({ stdout: "#22 Simplify README\n" });
    process.env.PATH = bin;
    const options = { container: CONTAINER, root: cacheRoot() };

    await previewPullRequest(PR, 100, options);
    const second = await previewPullRequest(PR, 100, options);

    expect(second).toBe("#22 Simplify README\n");
    expect(recorded(bin)).toHaveLength(1);
  });

  test("re-renders when the pane was resized, rather than replaying the old wrapping", async () => {
    const bin = makeBin({ stdout: "#22 Simplify README\n" });
    process.env.PATH = bin;
    const options = { container: CONTAINER, root: cacheRoot() };

    await previewPullRequest(PR, 100, options);
    await previewPullRequest(PR, 60, options);

    expect(recorded(bin).map((call) => call.width)).toEqual(["100", "60"]);
  });

  test("keys a second pull request apart from the first", async () => {
    const bin = makeBin({ stdout: "#22 Simplify README\n" });
    process.env.PATH = bin;
    const options = { container: CONTAINER, root: cacheRoot() };

    await previewPullRequest(PR, 100, options);
    await previewPullRequest(23, 100, options);

    expect(recorded(bin).map((call) => call.argv)).toEqual(["pr view 22", "pr view 23"]);
  });

  test("puts a failed lookup's own message in the pane instead of leaving it blank", async () => {
    // The composition is what is pinned here: `gh.ts` hands back the complaint, and this module
    // must neither throw it away nor turn a nonzero exit into an exception. Both are things a
    // renderer would plausibly do, and either leaves the pane empty at the moment it matters.
    const bin = makeBin({ stderr: "no pull requests found for branch\n", exit: 1 });
    process.env.PATH = bin;

    const text = await previewPullRequest(PR, 100, { container: CONTAINER, root: cacheRoot() });

    expect(text).toBe("no pull requests found for branch\n");
  });

  test("caches a failure like any other render, rather than re-running a failing gh", async () => {
    const bin = makeBin({ stderr: "could not resolve to a PullRequest\n", exit: 1 });
    process.env.PATH = bin;
    const options = { container: CONTAINER, root: cacheRoot() };

    await previewPullRequest(PR, 100, options);
    const second = await previewPullRequest(PR, 100, options);

    expect(second).toBe("could not resolve to a PullRequest\n");
    expect(recorded(bin)).toHaveLength(1);
  });

  test("says gh is missing rather than rendering an empty pane", async () => {
    // The one case with no message of its own: `viewPullRequest` answers null, so a sentence has
    // to be substituted here or the pane is blank for a reason the user cannot see.
    process.env.PATH = makeEmptyBin();

    const text = await previewPullRequest(PR, 100, { container: CONTAINER, root: cacheRoot() });

    expect(text).toContain("gh");
    expect(text).toContain("https://cli.github.com");
  });

  test("ages on the PR cache's own clock, so a preview never outlives its row", async () => {
    // The passive half of "invalidated together with the PR cache". The `?? 0` is the guard, not
    // a convenience: renaming that entry in a later issue drops this to zero, which fails the
    // assertion below rather than silently decoupling the two caches.
    const ttl = DEFAULTS.cache.ttls["pr-graph"] ?? 0;
    expect(ttl).toBeGreaterThan(0);

    const bin = makeBin({ stdout: "#22 Simplify README\n" });
    process.env.PATH = bin;
    const root = cacheRoot();
    const options = { container: CONTAINER, root };

    await previewPullRequest(PR, 100, options);
    const [name = ""] = await entries(root);
    const entry = join(containerDir(root), name);

    await backdate(entry, ttl - 60_000);
    await previewPullRequest(PR, 100, options);
    expect(recorded(bin)).toHaveLength(1);

    await backdate(entry, ttl + 60_000);
    await previewPullRequest(PR, 100, options);
    expect(recorded(bin)).toHaveLength(2);
  });

  test("honours a caller's own staleness threshold over the inherited one", async () => {
    // Asserted in the direction only the option can explain: the entry is backdated well past
    // the inherited threshold, so a render that came back without shelling out again did so
    // because the longer threshold was honoured. The opposite direction — a threshold shorter
    // than the default — cannot be pinned at `0`, since an entry written and read back inside
    // the same millisecond still reads as fresh (`Date.now()` is whole milliseconds while an
    // mtime is not), which is `cache.ts`'s comparison rather than this module's.
    const bin = makeBin({ stdout: "#22 Simplify README\n" });
    process.env.PATH = bin;
    const root = cacheRoot();
    const inherited = DEFAULTS.cache.ttls["pr-graph"] ?? 0;

    await previewPullRequest(PR, 100, { container: CONTAINER, root });
    const [name = ""] = await entries(root);
    await backdate(join(containerDir(root), name), inherited * 2);

    await previewPullRequest(PR, 100, { container: CONTAINER, root, ttl: inherited * 4 });

    expect(recorded(bin)).toHaveLength(1);
  });
});

describe("clearPreviews", () => {
  test("removes every width's render for its container", async () => {
    const bin = makeBin({ stdout: "#22 Simplify README\n" });
    process.env.PATH = bin;
    const root = cacheRoot();
    const options = { container: CONTAINER, root };

    await previewPullRequest(PR, 100, options);
    await previewPullRequest(PR, 60, options);
    await previewPullRequest(23, 100, options);
    expect(await entries(root)).toHaveLength(3);

    await clearPreviews({ container: CONTAINER, root });

    expect(await entries(root)).toEqual([]);
  });

  test("leaves the PR cache itself standing", async () => {
    // The prefix test has to distinguish a preview from the entry it shares a clock with:
    // purging the PR graph here would turn a preview refresh into a full re-query of GitHub.
    const bin = makeBin({ stdout: "#22 Simplify README\n" });
    process.env.PATH = bin;
    const root = cacheRoot();

    await previewPullRequest(PR, 100, { container: CONTAINER, root });
    await writeCache({ name: "pr-graph", container: CONTAINER, root }, "the open graph");

    await clearPreviews({ container: CONTAINER, root });

    expect(await entries(root)).toHaveLength(1);
  });

  test("leaves another repository's previews alone", async () => {
    const other = "/Users/me/GitLocal/other";
    const bin = makeBin({ stdout: "#22 Simplify README\n" });
    process.env.PATH = bin;
    const root = cacheRoot();

    await previewPullRequest(PR, 100, { container: CONTAINER, root });
    await previewPullRequest(PR, 100, { container: other, root });

    await clearPreviews({ container: CONTAINER, root });

    expect(await entries(root)).toEqual([]);
    expect(await entries(root, other)).toHaveLength(1);
  });

  test("leaves a refresh lock in place rather than taking it from its holder", async () => {
    // `cache.ts` documents at length why breaking a lock is a larger problem than it looks. A
    // purge that swept them would do exactly that to a render running concurrently with it.
    const bin = makeBin({ stdout: "#22 Simplify README\n" });
    process.env.PATH = bin;
    const root = cacheRoot();

    await previewPullRequest(PR, 100, { container: CONTAINER, root });
    const [name = ""] = await entries(root);
    await mkdir(join(containerDir(root), `${name}.lock`));

    await clearPreviews({ container: CONTAINER, root });

    expect(await entries(root)).toEqual([`${name}.lock`]);
  });

  test("leaves a staging file in place rather than breaking the write it belongs to", async () => {
    // `cache.ts` stages every write to `<entry>.<pid>.<n>.tmp` and then renames it over the
    // entry. Removing one mid-flight makes that rename fail `ENOENT`, and `cached` writes
    // outside its own stale-contents fallback — so the rejection reaches whatever was drawing.
    // A purge is designed to run concurrently with a render, so this is the same reasoning the
    // lock case above rests on, applied to the other sibling a cache write leaves beside an entry.
    const bin = makeBin({ stdout: "#22 Simplify README\n" });
    process.env.PATH = bin;
    const root = cacheRoot();

    await previewPullRequest(PR, 100, { container: CONTAINER, root });
    const [name = ""] = await entries(root);
    const staging = `${name}.${process.pid}.0.tmp`;
    writeFileSync(join(containerDir(root), staging), "half a render");

    await clearPreviews({ container: CONTAINER, root });

    expect(await entries(root)).toEqual([staging]);
  });

  test("is a no-op when nothing was ever cached for the container", async () => {
    await expect(
      clearPreviews({ container: CONTAINER, root: cacheRoot() }),
    ).resolves.toBeUndefined();
  });
});
