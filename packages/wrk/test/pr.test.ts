/**
 * Contract of the unified PR cache: what it stores, which query gates the write, and how it
 * picks a winner when one head ref carries more than one pull request.
 *
 * Nothing is mocked. `gh` is a real executable on `PATH` that scripts the two queries apart,
 * and the cache is a real directory under the system temp root, because both properties under
 * test are properties of those two things rather than of this module's arithmetic — a stubbed
 * `gh` cannot show that a failed *merged* query still leaves a good open graph on disk, and a
 * stubbed filesystem cannot show that a failed *open* query leaves the previous file untouched.
 * The harness is `gh.test.ts`'s, copied for the reason that suite gives for copying
 * `provision.test.ts`'s, and narrowed: the fake here scripts a different answer per `--state`,
 * which is the whole point of a module that runs both.
 *
 * **The dedupe cases feed their fixtures in both orders.** The rule is that an open pull
 * request beats a merged one and the later update wins within a state — never that the last
 * row seen wins — so a case that fixed one order would stay green against a fold that is
 * simply `map.set` in disguise. Where a single order is used it is the adversarial one: the
 * loser is emitted last, and carries the newer timestamp.
 *
 * Every fake reads a line from stdin before answering, so the "stdin is closed" property
 * `proc.ts` promises is enforced by the whole suite — were stdin left as an open pipe, each
 * call would block until bun's per-test timeout killed it.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cachePath, writeCache } from "../src/cache";
import { pullRequests } from "../src/pr";

/** Temp roots to delete once the suite finishes. */
const roots: string[] = [];

/** A container path that never has to exist: nothing here resolves a repository. */
const CONTAINER = "/Users/me/GitLocal/thing";

/**
 * The cache entry every case reads and writes.
 *
 * Spelled literally rather than imported, deliberately. It is the key `config.ts`'s
 * `DEFAULTS.cache.ttls` already carries a TTL under, so renaming the entry silently detaches
 * every user's configured staleness from the cache it was written for — this literal is what
 * makes that a failing test rather than a silent regression.
 */
const ENTRY = "pr-graph";

/**
 * A fresh temp directory, resolved through `realpathSync`.
 *
 * The resolution is load-bearing on macOS, where `tmpdir()` is a symlink into `/private`, and
 * the cache root is compared against paths this module builds from it.
 */
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wrk-pr-")));
  roots.push(dir);

  return dir;
}

/** Where the log the fake appends to lives inside a fixture root. */
function logPath(bin: string): string {
  return join(bin, "log.txt");
}

/**
 * Quotes `text` as a single `sh` word, safely for any byte a PR title can hold.
 *
 * Single quotes make everything literal in `sh` except a single quote itself, which is closed,
 * escaped and reopened. This is what lets the fake carry its payloads inline: `PATH` is the
 * fake's directory alone during a test, so a fake that shelled out to `cat` to read them from
 * a file would fail for a reason that has nothing to do with this module.
 */
function shQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** What the fake `gh` answers, per query. */
interface GhScript {
  /** Rows the open query returns. */
  open?: Record<string, unknown>[];

  /** Rows the merged query returns. */
  merged?: Record<string, unknown>[];

  /** The open query's exit status. Nonzero is `gh` declining to answer. */
  openExit?: number;

  /** The merged query's exit status. Nonzero is `gh` declining to answer. */
  mergedExit?: number;
}

/**
 * A directory holding a fake `gh`, to be used as the whole of `PATH`.
 *
 * The fake logs one line of argv per invocation and then branches on `--state`, so the two
 * queries can succeed, fail and answer independently of each other — which is what the
 * write-gate cases need and what a single scripted answer could not express.
 */
function makeBin(script: GhScript = {}): string {
  const bin = tempDir();

  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shQuote(logPath(bin))}`,
      "read -r _ignored",
      'case "$*" in',
      `  *"--state merged"*)`,
      `    printf '%s' ${shQuote(JSON.stringify(script.merged ?? []))}`,
      `    exit ${script.mergedExit ?? 0} ;;`,
      "  *)",
      `    printf '%s' ${shQuote(JSON.stringify(script.open ?? []))}`,
      `    exit ${script.openExit ?? 0} ;;`,
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);

  return bin;
}

/** Every invocation the fake recorded, in order, as the argv it was handed. */
function recorded(bin: string): string[] {
  const log = logPath(bin);
  if (!existsSync(log)) return [];

  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** One PR as `gh pr list --json` reports it. */
function ghRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 22,
    title: "EXC-1031 Simplify README",
    headRefName: "EXC-1031/readme",
    baseRefName: "trunk",
    state: "OPEN",
    updatedAt: "2026-08-06T01:09:34Z",
    ...overrides,
  };
}

/** Points `PATH` at `script`'s fake `gh` and returns a throwaway cache root beside it. */
function withGh(script: GhScript = {}): { bin: string; root: string } {
  const bin = makeBin(script);
  process.env.PATH = bin;

  return { bin, root: tempDir() };
}

/** The stored entry's raw text, exactly as it sits on disk. */
function stored(root: string): string {
  return readFileSync(cachePath({ name: ENTRY, container: CONTAINER, root }), "utf8");
}

/** `PATH` is repointed at a fake by every case, so it is restored between them. */
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("pullRequests", () => {
  test("keys pull requests by their head ref", async () => {
    const { root } = withGh({ open: [ghRow()] });

    const prs = await pullRequests(CONTAINER, 0, { root });

    expect(prs.get("EXC-1031/readme")).toEqual({
      number: 22,
      title: "EXC-1031 Simplify README",
      headRefName: "EXC-1031/readme",
      baseRefName: "trunk",
      state: "OPEN",
      updatedAt: "2026-08-06T01:09:34Z",
    });
  });

  test("stores head ref, number, title, base ref and state in one entry", async () => {
    const { root } = withGh({
      open: [ghRow()],
      merged: [ghRow({ number: 21, headRefName: "EXC-1030/other", state: "MERGED" })],
    });

    await pullRequests(CONTAINER, 0, { root });

    const rows = JSON.parse(stored(root)) as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        "baseRefName",
        "headRefName",
        "number",
        "state",
        "title",
        "updatedAt",
      ]);
    }
  });

  test("an open pull request beats a merged one for the same head ref", async () => {
    // Adversarial on both counts the rule could be faked by: the merged row is emitted by the
    // second query, so it is folded last, and it carries the *newer* timestamp. Only an
    // explicit state ranking survives this.
    const { root } = withGh({
      open: [ghRow({ number: 7, updatedAt: "2026-08-01T00:00:00Z" })],
      merged: [ghRow({ number: 6, state: "MERGED", updatedAt: "2026-08-05T00:00:00Z" })],
    });

    const prs = await pullRequests(CONTAINER, 0, { root });

    expect(prs.get("EXC-1031/readme")?.number).toBe(7);
    expect(prs.size).toBe(1);
  });

  test("the most recently updated wins within a state, whatever order the rows arrive in", async () => {
    const older = ghRow({ number: 6, updatedAt: "2026-08-01T00:00:00Z" });
    const newer = ghRow({ number: 7, updatedAt: "2026-08-05T00:00:00Z" });

    for (const open of [
      [older, newer],
      [newer, older],
    ]) {
      const { root } = withGh({ open });

      const prs = await pullRequests(CONTAINER, 0, { root });

      expect(prs.get("EXC-1031/readme")?.number).toBe(7);
    }
  });

  test("a tie on state and timestamp breaks on the pull request number", async () => {
    const first = ghRow({ number: 6 });
    const second = ghRow({ number: 7 });

    for (const open of [
      [first, second],
      [second, first],
    ]) {
      const { root } = withGh({ open });

      const prs = await pullRequests(CONTAINER, 0, { root });

      expect(prs.get("EXC-1031/readme")?.number).toBe(7);
    }
  });

  test("round-trips a tab and a newline inside a title", async () => {
    const title = "EXC-1031\tSimplify\nREADME";
    const { root } = withGh({ open: [ghRow({ title })] });

    const prs = await pullRequests(CONTAINER, 0, { root });

    expect(prs.get("EXC-1031/readme")?.title).toBe(title);
    // Re-read from disk rather than trusting the in-memory answer: the format is what the
    // criterion is about, and a value that only survives inside one process has not been stored.
    expect((JSON.parse(stored(root)) as { title: string }[])[0]?.title).toBe(title);
  });

  test("stores the open graph even when the merged query fails", async () => {
    const { root } = withGh({ open: [ghRow()], mergedExit: 1 });

    const prs = await pullRequests(CONTAINER, 0, { root });

    expect(prs.get("EXC-1031/readme")?.number).toBe(22);
    expect(JSON.parse(stored(root))).toHaveLength(1);
  });

  test("leaves the previous entry standing when the open query fails", async () => {
    const { root } = withGh({ open: [ghRow({ number: 99 })], openExit: 1 });
    const seeded = JSON.stringify([ghRow({ number: 22 })]);
    await writeCache({ name: ENTRY, container: CONTAINER, root }, seeded);

    const prs = await pullRequests(CONTAINER, 0, { root });

    expect(prs.get("EXC-1031/readme")?.number).toBe(22);
    expect(stored(root)).toBe(seeded);
  });

  test("answers an empty map when the open query fails with nothing cached", async () => {
    const { root } = withGh({ openExit: 1 });

    expect(await pullRequests(CONTAINER, 0, { root })).toEqual(new Map());
  });

  test("serves a fresh entry without running gh at all", async () => {
    const { bin, root } = withGh({ open: [ghRow({ number: 99 })] });
    await writeCache(
      { name: ENTRY, container: CONTAINER, root },
      JSON.stringify([ghRow({ number: 22 })]),
    );

    const prs = await pullRequests(CONTAINER, 600_000, { root });

    expect(prs.get("EXC-1031/readme")?.number).toBe(22);
    expect(recorded(bin)).toEqual([]);
  });

  test("degrades to an empty map when the stored entry cannot be read", async () => {
    const { root } = withGh();
    await writeCache({ name: ENTRY, container: CONTAINER, root }, "not json at all");

    // Fresh by mtime, so this is the stored text being handed back — a picker drawing against a
    // corrupt or older-format entry gets no rows rather than an exception.
    expect(await pullRequests(CONTAINER, 600_000, { root })).toEqual(new Map());
  });

  test("asks each state in a call of its own", async () => {
    const { bin, root } = withGh({ open: [ghRow()] });

    await pullRequests(CONTAINER, 0, { root });

    // The separate-window rule `gh.ts` rests on is invisible in the returned map: a module that
    // asked for both states at once would produce an identical answer here and lose a long-lived
    // bottom layer to a busy month of merges. What was actually run is the only evidence.
    const argvs = recorded(bin);
    expect(argvs).toHaveLength(2);
    expect(argvs.filter((argv) => argv.includes("--state open"))).toHaveLength(1);
    expect(argvs.filter((argv) => argv.includes("--state merged"))).toHaveLength(1);
  });
});
