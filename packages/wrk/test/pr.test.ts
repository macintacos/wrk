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
 *
 * **The background-refresh case is a clock, and it runs against a whole process.** What it
 * guards is that `gh` is off the critical path, which is a claim about elapsed time and
 * therefore has to be measured rather than asserted: the fake sleeps for seconds and the
 * caller has to come back in milliseconds. It goes through
 * [`./fixtures/background-caller.ts`](./fixtures/background-caller.ts) rather than calling
 * `pullRequests` here, because half of what it measures — that the detached refresh holds no
 * descriptor of the caller's — exists only at the process boundary. See that fixture's header.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cachePath, writeCache } from "../src/cache";
import { pullRequests } from "../src/pr";

/** Temp roots to delete once the suite finishes. */
const roots: string[] = [];

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

/**
 * The container every case is keyed on, and the directory the fake `gh` is run in.
 *
 * A real directory rather than a plausible-looking string, because the module runs `gh` in the
 * container it files the answer under — and `run` rejects on a `cwd` that does not exist, which
 * would degrade every case here to "gh could not answer" for a reason unrelated to what it is
 * testing.
 */
const CONTAINER = tempDir();

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

  /**
   * Seconds the fake stalls before answering either query, for the clock case.
   *
   * Whole seconds because POSIX `sleep` is only required to accept an integer, and this is
   * the one place the suite calls a binary it did not write — see {@link SLEEP}.
   */
  delaySeconds?: number;
}

/**
 * Absolute path of `sleep`, resolved while `PATH` is still the real one.
 *
 * By absolute path because {@link withGh} replaces `PATH` with the fake's directory alone, so
 * a bare `sleep` inside the fake would not resolve — the same reason the fake carries its
 * payloads inline instead of reading them with `cat`. The fallback is `noUncheckedIndexedAccess`
 * in spirit rather than a case expected to fire: `sleep` is in POSIX.
 */
const SLEEP = Bun.which("sleep") ?? "/bin/sleep";

/**
 * A directory holding a fake `gh`, to be used as the whole of `PATH`.
 *
 * The fake logs one line of argv per invocation and then branches on `--state`, so the two
 * queries can succeed, fail and answer independently of each other — which is what the
 * write-gate cases need and what a single scripted answer could not express.
 *
 * The log line is **one** `printf`, and has to stay one: the module runs both queries
 * concurrently, so two copies of this fake append to the same file at once, and only a single
 * `O_APPEND` write keeps their lines whole. Split it in two and {@link recorded} starts
 * returning interleaved halves on an unlucky run.
 */
function makeBin(script: GhScript = {}): string {
  const bin = tempDir();

  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `printf '%s\\t%s\\n' "$(pwd)" "$*" >> ${shQuote(logPath(bin))}`,
      "read -r _ignored",
      ...(script.delaySeconds === undefined
        ? []
        : [`${shQuote(SLEEP)} ${String(script.delaySeconds)}`]),
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

/** One recorded invocation of the fake: where it ran, and what it ran as. */
interface Invocation {
  cwd: string;
  argv: string;
}

/** Every invocation the fake recorded, in order. */
function recorded(bin: string): Invocation[] {
  const log = logPath(bin);
  if (!existsSync(log)) return [];

  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [cwd = "", argv = ""] = line.split("\t");

      return { cwd, argv };
    });
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

/**
 * Backdates an entry so it reads as older than any TTL these cases use.
 *
 * `cache.test.ts`'s helper, copied for the reason that suite gives for manipulating mtimes
 * rather than sleeping: a test that waits out a real TTL is either slow or flaky, usually both.
 * A `ttl` of `0` is not the substitute it looks like — `Date.now()` is whole milliseconds and
 * `mtimeMs` is not, so an entry written in the same millisecond compares as *fresh*.
 */
function age(path: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(path, when, when);
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
    const { bin, root } = withGh();
    await writeCache({ name: ENTRY, container: CONTAINER, root }, "not json at all");

    // Fresh by mtime, so this is the stored text being handed back — a picker drawing against a
    // corrupt or older-format entry gets no rows rather than an exception.
    expect(await pullRequests(CONTAINER, 600_000, { root })).toEqual(new Map());
    // Without this the case would also pass for an implementation that treated the corrupt
    // entry as stale and refreshed, since the fake's default answer is an empty listing too.
    expect(recorded(bin)).toEqual([]);
  });

  test("reads back what it wrote, without asking gh twice", async () => {
    const { bin, root } = withGh({ open: [ghRow()] });

    const written = await pullRequests(CONTAINER, 0, { root });
    const read = await pullRequests(CONTAINER, 600_000, { root });

    expect(read).toEqual(written);
    expect(recorded(bin)).toHaveLength(2);
  });

  test("asks each state in a call of its own", async () => {
    const { bin, root } = withGh({ open: [ghRow()] });

    await pullRequests(CONTAINER, 0, { root });

    // The separate-window rule `gh.ts` rests on is invisible in the returned map: a module that
    // asked for both states at once would produce an identical answer here and lose a long-lived
    // bottom layer to a busy month of merges. What was actually run is the only evidence.
    const calls = recorded(bin);
    expect(calls).toHaveLength(2);
    expect(calls.filter(({ argv }) => argv.includes("--state open"))).toHaveLength(1);
    expect(calls.filter(({ argv }) => argv.includes("--state merged"))).toHaveLength(1);
  });

  test("runs gh in the container the answer is filed under", async () => {
    const { bin, root } = withGh({ open: [ghRow()] });

    await pullRequests(CONTAINER, 0, { root });

    // The one invariant that cannot be seen in the returned map: query the wrong directory and
    // one repository's pull requests are stored under another's key, on a cache every process
    // reads, for a full TTL. Nothing downstream could tell.
    expect(recorded(bin).map(({ cwd }) => cwd)).toEqual([CONTAINER, CONTAINER]);
  });
});

/** How long the fake `gh` stalls in the clock case — the wait that must not be paid. */
const DELAY_SECONDS = 3;

/**
 * What the caller's whole process must finish inside, in milliseconds.
 *
 * Half the delay, which is the margin that makes this a regression guard rather than a
 * benchmark: a `bun` boot and a module graph is a couple of hundred milliseconds, and an
 * implementation that awaited `gh` could not come in under `DELAY_SECONDS` however fast the
 * machine is. Nothing between the two numbers is a legitimate outcome.
 */
const CEILING_MS = (DELAY_SECONDS * 1000) / 2;

/** How long the case waits for the detached refresh to publish, and how often it looks. */
const LANDING_MS = 20_000;
const POLL_MS = 50;

describe("background refresh", () => {
  test("answers from the stored entry without waiting for gh, and lands the refresh behind it", async () => {
    const { root } = withGh({
      open: [ghRow({ number: 22 }), ghRow({ number: 23, headRefName: "EXC-1030/other" })],
      delaySeconds: DELAY_SECONDS,
    });
    const key = { name: ENTRY, container: CONTAINER, root };
    await writeCache(key, JSON.stringify([ghRow({ number: 7 })]));
    age(cachePath(key), 90_000);

    const started = Date.now();
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "fixtures", "background-caller.ts")],
      {
        env: {
          ...process.env,
          WRK_CONTAINER: CONTAINER,
          WRK_CACHE_ROOT: root,
          WRK_TTL: "60000",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    // All three awaited together, and the elapsed figure covers the slowest of them. Draining
    // concurrently with the wait is `cache.test.ts`'s rule — awaiting `exited` first deadlocks
    // a child that fills the pipe buffer — but here the stdout clock is also half the
    // assertion: a refresh holding the caller's stdout leaves the pipe open until it exits, so
    // the read reaches EOF three seconds after the process itself is gone.
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const elapsed = Date.now() - started;

    expect(err).toBe("");
    expect(code).toBe(0);
    // One row, so this is the seeded entry rather than the fake's two-row answer — the caller
    // returned the stale graph rather than a fresh one it had waited for.
    expect(out.trim()).toBe("1");
    expect(elapsed).toBeLessThan(CEILING_MS);

    // Condition-based rather than a fixed sleep: what is being waited for is a file appearing,
    // and the delay above is a floor on when it can, not a prediction of when it will.
    const deadline = Date.now() + LANDING_MS;
    let numbers: number[] = [];
    while (Date.now() < deadline) {
      numbers = (JSON.parse(stored(root)) as { number: number }[])
        .map(({ number }) => number)
        .sort((a, b) => a - b);
      if (numbers.length > 1) break;
      await Bun.sleep(POLL_MS);
    }

    expect(numbers).toEqual([22, 23]);
  }, 30_000);
});
