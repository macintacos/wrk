/**
 * Contract of the `gh` adapter: which argv reaches the GitHub CLI, what its output becomes,
 * and which of its failures are answers rather than errors.
 *
 * **The argv assertions are the point of this suite.** The separate-window rule the epic
 * rests on — open and merged PRs queried apart, each with its own `--limit` — is invisible
 * in the returned value and observable only in what was actually run, so `gh` is replaced by
 * a real executable on `PATH` that logs `<cwd>\t<argv>\t<GH_FORCE_TTY>\t<GH_PAGER set?>` and
 * emits scripted output. Asserting the parsed rows alone would stay green through a rewrite
 * that asked for `--state all` in one call.
 *
 * `process.env.PATH` is set in-process rather than passed through: `proc.ts`'s `run` reads
 * `process.env` at call time, so the fake reaches the real adapter with no injection seam
 * added to production code for the tests' benefit. The harness is modelled on the one in
 * `provision.test.ts` and copied rather than shared, for that suite's stated reason — the
 * fixtures module in `test/fixtures/` builds git repositories, which is a different shape of
 * problem from standing up a fake binary.
 *
 * Every fake reads a line from stdin before answering, so the "stdin is closed" criterion is
 * enforced by the whole suite rather than by one case: were stdin left as an open pipe, each
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

import { CommandFailed, Refusal } from "../src/errors";
import { checkoutPullRequest, listPullRequests, viewPullRequest } from "../src/gh";

/** Temp roots to delete once the suite finishes. */
const roots: string[] = [];

/**
 * A fresh temp directory, resolved through `realpathSync`.
 *
 * The resolution is load-bearing on macOS, where `tmpdir()` is a symlink into `/private`.
 * The fake logs `pwd`, which is resolved, so an unresolved fixture path fails the cwd
 * comparison for a reason that has nothing to do with the adapter.
 */
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wrk-gh-")));
  roots.push(dir);
  return dir;
}

/** Where the log the fake appends to lives inside a fixture root. */
function logPath(bin: string): string {
  return join(bin, "log.tsv");
}

/** What {@link makeBin}'s fake `gh` should say and how it should exit. */
interface BinOptions {
  /** What the fake writes to stdout. Defaults to an empty JSON array. */
  stdout?: string;

  /** What the fake writes to stderr. */
  stderr?: string;

  /** The fake's exit status. */
  exit?: number;
}

/**
 * Quotes `text` as a single `sh` word, safely for any byte a PR title can hold.
 *
 * Single quotes make everything literal in `sh` except a single quote itself, which is closed,
 * escaped and reopened. This is what lets the fake carry its payloads inline: `PATH` is the
 * fake's directory alone during a test, so a fake that shelled out to `cat` to read them from
 * a file would fail for a reason that has nothing to do with the adapter.
 */
function shQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * A directory holding a fake `gh`, to be used as the whole of `PATH`.
 *
 * The fake records one `<cwd>\t<argv…>\t<GH_FORCE_TTY or "unset">\t<"set" when GH_PAGER is
 * defined, empty otherwise>` line per invocation. `${GH_PAGER+set}` rather than
 * `${GH_PAGER:+set}` is deliberate: the adapter sets it to the *empty string*, which is what
 * `gh` reads as "no pager", and the `:+` form cannot tell that apart from unset.
 *
 * The `read` is what makes the stdin criterion enforceable — see this file's header.
 */
function makeBin(options: BinOptions = {}): string {
  const bin = tempDir();

  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `printf '%s\\t%s\\t%s\\t%s\\n' "$(pwd)" "$*" "\${GH_FORCE_TTY-unset}" "\${GH_PAGER+set}" >> ${shQuote(logPath(bin))}`,
      "read -r _ignored",
      `printf '%s' ${shQuote(options.stdout ?? "[]")}`,
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
  return tempDir();
}

/** One recorded invocation of the fake. */
interface Invocation {
  cwd: string;
  argv: string;
  forceTty: string;
  pagerSet: boolean;
}

/** Every invocation the fake recorded, in order. */
function recorded(bin: string): Invocation[] {
  const log = logPath(bin);
  if (!existsSync(log)) return [];

  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [cwd = "", argv = "", forceTty = "", pagerSet = ""] = line.split("\t");
      return { cwd, argv, forceTty, pagerSet: pagerSet === "set" };
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

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("listPullRequests", () => {
  test("parses gh's JSON into typed rows", async () => {
    const bin = makeBin({ stdout: JSON.stringify([ghRow()]) });
    process.env.PATH = bin;

    expect(await listPullRequests("OPEN")).toEqual([
      {
        number: 22,
        title: "EXC-1031 Simplify README",
        headRefName: "EXC-1031/readme",
        baseRefName: "trunk",
        state: "OPEN",
        updatedAt: "2026-08-06T01:09:34Z",
      },
    ]);
  });

  test("asks for open PRs in a window of their own", async () => {
    const bin = makeBin();
    process.env.PATH = bin;

    await listPullRequests("OPEN");

    expect(recorded(bin)[0]?.argv).toBe(
      "pr list --state open --limit 100 --search sort:updated-desc --json number,title,headRefName,baseRefName,state,updatedAt",
    );
  });

  test("asks for merged PRs in a window of their own", async () => {
    const bin = makeBin();
    process.env.PATH = bin;

    await listPullRequests("MERGED");

    // The separate limit is the whole rule: sharing one window lets a busy month of merges
    // push a long-lived bottom layer out of the feed, after which the stack walk reads a
    // middle layer as the root.
    expect(recorded(bin)[0]?.argv).toContain("--state merged --limit 50");
  });

  test("never asks for both states in one call", async () => {
    const bin = makeBin();
    process.env.PATH = bin;

    await listPullRequests("OPEN");
    await listPullRequests("MERGED");

    const argvs = recorded(bin).map((invocation) => invocation.argv);
    expect(argvs).toHaveLength(2);
    for (const argv of argvs) expect(argv).not.toContain("--state all");
  });

  test("answers an empty array rather than null when there are no matching PRs", async () => {
    const bin = makeBin({ stdout: "[]" });
    process.env.PATH = bin;

    // The distinction the unified cache's write gate depends on: "gh says none" must not
    // read the same as "gh could not say".
    expect(await listPullRequests("OPEN")).toEqual([]);
  });

  test("answers null when gh is not installed", async () => {
    process.env.PATH = makeEmptyBin();

    expect(await listPullRequests("OPEN")).toBeNull();
  });

  test("answers null when gh exits nonzero", async () => {
    // Stands in for unauthenticated, offline and rate-limited alike — gh reports all three
    // as a nonzero exit with a message on stderr, and the caller's next move is the same.
    const bin = makeBin({ stderr: "gh: not authenticated\n", exit: 1 });
    process.env.PATH = bin;

    expect(await listPullRequests("OPEN")).toBeNull();
  });

  test("throws when gh emits JSON the schema rejects", async () => {
    // A gh whose JSON shape changed is a fault, not a normal outcome — the same call
    // git.ts's parseWorktree makes about an unreadable worktree record.
    const bin = makeBin({ stdout: JSON.stringify([{ number: "twenty-two" }]) });
    process.env.PATH = bin;

    await expect(listPullRequests("OPEN")).rejects.toThrow(/unreadable/);
  });

  test("throws when gh emits something that is not JSON at all", async () => {
    const bin = makeBin({ stdout: "not json" });
    process.env.PATH = bin;

    await expect(listPullRequests("OPEN")).rejects.toThrow(/unreadable/);
  });

  test("keeps a title holding a tab and a newline intact", async () => {
    const title = "fix\tthe\nthing";
    const bin = makeBin({ stdout: JSON.stringify([ghRow({ title })]) });
    process.env.PATH = bin;

    const prs = await listPullRequests("OPEN");

    expect(prs?.[0]?.title).toBe(title);
  });

  test("runs gh in the cwd it was given", async () => {
    const bin = makeBin();
    const elsewhere = tempDir();
    process.env.PATH = bin;

    await listPullRequests("OPEN", elsewhere);

    expect(recorded(bin)[0]?.cwd).toBe(elsewhere);
  });

  test("closes the child's stdin so a gh that reads it cannot block", async () => {
    // The fake reads a line before answering. With stdin left as an open pipe this call
    // never settles and the test times out; with it closed the read sees EOF at once.
    const bin = makeBin({ stdout: JSON.stringify([ghRow()]) });
    process.env.PATH = bin;

    expect(await listPullRequests("OPEN")).toHaveLength(1);
  });

  test("empties GH_PAGER so no invocation can start a pager", async () => {
    const bin = makeBin();
    process.env.PATH = bin;

    await listPullRequests("OPEN");

    expect(recorded(bin)[0]?.pagerSet).toBe(true);
  });
});

describe("viewPullRequest", () => {
  test("returns gh's rendering of the PR", async () => {
    const bin = makeBin({ stdout: "EXC-1031 Simplify README\n" });
    process.env.PATH = bin;

    expect(await viewPullRequest(22)).toBe("EXC-1031 Simplify README\n");
  });

  test("asks gh to view the numbered PR", async () => {
    const bin = makeBin();
    process.env.PATH = bin;

    await viewPullRequest(22);

    expect(recorded(bin)[0]?.argv).toBe("pr view 22");
  });

  test("forces a TTY at the requested width so gh renders markdown", async () => {
    const bin = makeBin();
    process.env.PATH = bin;

    await viewPullRequest(22, undefined, { width: 80 });

    expect(recorded(bin)[0]?.forceTty).toBe("80");
  });

  test("leaves GH_FORCE_TTY unset when no width is given", async () => {
    const bin = makeBin();
    process.env.PATH = bin;

    await viewPullRequest(22);

    expect(recorded(bin)[0]?.forceTty).toBe("unset");
  });

  test("returns gh's stderr when the lookup failed", async () => {
    // So a failed lookup shows its message in the preview pane instead of leaving it blank.
    const bin = makeBin({ stdout: "", stderr: "no pull requests found for branch\n", exit: 1 });
    process.env.PATH = bin;

    expect(await viewPullRequest(999)).toBe("no pull requests found for branch\n");
  });

  test("keeps both streams when gh wrote to each", async () => {
    // A partial render followed by an error must lose neither half.
    const bin = makeBin({ stdout: "partial\n", stderr: "and then it failed\n", exit: 1 });
    process.env.PATH = bin;

    expect(await viewPullRequest(22)).toBe("partial\nand then it failed\n");
  });

  test("answers null when gh is not installed", async () => {
    process.env.PATH = makeEmptyBin();

    expect(await viewPullRequest(22)).toBeNull();
  });

  test("runs gh in the cwd it was given", async () => {
    const bin = makeBin();
    const elsewhere = tempDir();
    process.env.PATH = bin;

    await viewPullRequest(22, elsewhere);

    expect(recorded(bin)[0]?.cwd).toBe(elsewhere);
  });
});

describe("checkoutPullRequest", () => {
  test("asks gh to check the numbered PR out in the cwd it was given", async () => {
    const bin = makeBin();
    const elsewhere = tempDir();
    process.env.PATH = bin;

    await checkoutPullRequest(22, elsewhere);

    expect(recorded(bin)[0]).toMatchObject({ argv: "pr checkout 22", cwd: elsewhere });
  });

  test("throws CommandFailed carrying gh's exit status and stderr", async () => {
    const bin = makeBin({ stderr: "branch already checked out\n", exit: 4 });
    process.env.PATH = bin;

    // The status is what lets `wrk` exit with the code of the command that failed under it,
    // exactly as git.ts's mutating wrappers do.
    const failure = await checkoutPullRequest(22).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommandFailed);
    expect((failure as CommandFailed).code).toBe(4);
    expect((failure as CommandFailed).message).toContain("branch already checked out");
  });

  test("refuses rather than crashing when gh is not installed", async () => {
    process.env.PATH = makeEmptyBin();

    await expect(checkoutPullRequest(22)).rejects.toBeInstanceOf(Refusal);
  });
});
