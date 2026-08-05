/**
 * Contract of the worktree provisioning pipeline: which steps run, in what order, in which
 * directory, what gates each one, and where their output goes.
 *
 * **The ordering assertions are the point of this suite**, so they are made against evidence
 * the pipeline cannot fake. `codegraph` and `mise` are replaced with real executables on
 * `PATH` that append `<cwd>\t<argv>` to a log, so the sequence asserted is the sequence that
 * actually ran rather than a restatement of the source. Two orderings matter and each is
 * pinned by a *consequence* rather than by a log line alone: the refresh must precede the
 * copy, which is proved by a marker the fake `codegraph index` drops into the source's index
 * and which can only reach the worktree if it was written before the copy; and the copy must
 * precede the sync, which is proved by the worktree sync happening at all, since it is gated
 * on a `.codegraph` only the copy can have put there.
 *
 * `process.env.PATH` is set in-process rather than passed through: `proc.ts`'s `run` reads
 * `process.env` at call time, so the fakes reach the real `provision` with no injection seam
 * added to production code for the tests' benefit.
 *
 * Fixtures are built with `execFileSync` rather than with this package's own wrappers, for
 * `worktree.test.ts`'s reason — a broken wrapper must not be able to build the repository
 * that then proves it correct. The helpers are copied from that suite rather than lifted into
 * a shared module, which is EXC-1003's explicit scope.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { provision } from "../src/provision";

/** Temp roots to delete once the suite finishes. */
const roots: string[] = [];

/**
 * A fresh temp directory, resolved through `realpathSync`.
 *
 * The resolution is load-bearing on macOS, where `tmpdir()` is a symlink into `/private`.
 * The fakes log `pwd`, which is resolved, so an unresolved fixture path fails every
 * comparison for a reason that has nothing to do with the code.
 */
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wrk-provision-")));
  roots.push(dir);
  return dir;
}

/**
 * The environment for fixture commands: this process's, minus everything binding git to a
 * repository.
 *
 * This suite runs under the repository's own pre-push hook, and git exports `GIT_DIR` to
 * every hook — under which `git init <dir>` re-initialises *that* repository and leaves
 * `<dir>` empty, so every fixture collapses.
 */
const FIXTURE_ENV: Record<string, string | undefined> = {
  ...process.env,
  ...Object.fromEntries(
    execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" })
      .split("\n")
      .filter((name) => name !== "")
      .map((name) => [name, undefined]),
  ),
};

/** Runs `git` with any inherited repository binding shed. */
function fixtureGit(args: string[], cwd?: string): void {
  execFileSync("git", args, { cwd, env: FIXTURE_ENV, encoding: "utf8" });
}

/** The real `git`, so a `PATH` holding nothing else still lets the copy read the index. */
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

/** Where the log the fakes append to lives inside a fixture root. */
function logPath(bin: string): string {
  return join(bin, "log.tsv");
}

/** Options for {@link makeBin}. */
interface BinOptions {
  /** Exit status the fake `mise` gives `tasks info setup` — 0 means the project has one. */
  tasksExit?: number;

  /** Exit status the fake `mise` gives the install itself. */
  installExit?: number;
}

/**
 * A directory holding fake `codegraph` and `mise` executables plus a real `git`.
 *
 * Each fake appends one `<cwd>\t<program> <argv…>` line to the log and exits. `codegraph
 * index` additionally writes a marker into the index it was pointed at, which is what makes
 * "the refresh ran before the copy" an observable fact rather than an assumption.
 *
 * @returns The directory, to be used as the whole of `PATH`.
 */
function makeBin(options: BinOptions = {}): string {
  const bin = tempDir();
  const log = logPath(bin);

  const script = (body: string): string => `#!/bin/sh\n${body}\n`;
  const record = (name: string): string =>
    `printf '%s\\t%s\\n' "$(pwd)" "${name} $*" >> ${JSON.stringify(log)}`;

  writeFileSync(
    join(bin, "codegraph"),
    script(
      [
        record("codegraph"),
        // Redirection only — `PATH` is the fake bin alone during a test, so a fake that
        // shelled out to `mkdir` would fail for a reason that has nothing to do with the
        // pipeline. `index` runs only where an index already exists, so there is none to make.
        `if [ "$1" = "index" ]; then : > .codegraph/refreshed; fi`,
        "exit 0",
      ].join("\n"),
    ),
  );
  writeFileSync(
    join(bin, "mise"),
    script(
      [
        record("mise"),
        `case "$*" in "tasks info setup") exit ${options.tasksExit ?? 0} ;; esac`,
        `exit ${options.installExit ?? 0}`,
      ].join("\n"),
    ),
  );

  chmodSync(join(bin, "codegraph"), 0o755);
  chmodSync(join(bin, "mise"), 0o755);
  symlinkSync(REAL_GIT, join(bin, "git"));
  return bin;
}

/** Every line the fakes recorded, in order, as `<cwd>\t<program> <argv…>`. */
function recorded(bin: string): string[] {
  const log = logPath(bin);
  return existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
    : [];
}

/**
 * A source checkout: a real git repository carrying an index, a tracked file inside it, and
 * an untracked `.env`.
 *
 * The tracked `.codegraph/.gitignore` is what the copy has to leave behind. It is genuinely
 * how a repository commits part of its index, and copying it would land an untracked file
 * that fails the next rebase onto a branch adding it.
 */
function makeSource(): string {
  const dir = tempDir();
  fixtureGit(["init", "-q", "-b", "main", dir]);
  mkdirSync(join(dir, ".codegraph"));
  writeFileSync(join(dir, ".codegraph", "index.db"), "source index");
  writeFileSync(join(dir, ".codegraph", ".gitignore"), "*.db\n");
  fixtureGit(["add", ".codegraph/.gitignore"], dir);
  fixtureGit(
    ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "init"],
    dir,
  );
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  return dir;
}

/** An empty destination, standing in for the worktree git has just created. */
function makeWorktree(options: { mise?: boolean } = {}): string {
  const dir = tempDir();
  if (options.mise === true) writeFileSync(join(dir, "mise.toml"), "[tools]\n");
  return dir;
}

let written: string[] = [];
const originalWrite = process.stderr.write;
const originalPath = process.env.PATH;

beforeEach(() => {
  written = [];
  process.stderr.write = ((chunk: string): boolean => {
    written.push(chunk);
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalWrite;
  process.env.PATH = originalPath;
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** Everything `provision` wrote to the human channel during one test. */
function stderrText(): string {
  return written.join("");
}

describe("provision", () => {
  test("runs refresh, copy, sync and install in that order, each in its own directory", async () => {
    const bin = makeBin();
    process.env.PATH = bin;
    const source = makeSource();
    const worktree = makeWorktree({ mise: true });

    await provision(source, worktree);

    expect(recorded(bin)).toEqual([
      `${source}\tcodegraph index`,
      `${source}\tcodegraph sync`,
      `${worktree}\tcodegraph sync`,
      `${worktree}\tmise trust --quiet`,
      `${worktree}\tmise tasks info setup`,
      `${worktree}\tmise run setup`,
    ]);
  });

  test("refreshes the source index before copying it, not after", async () => {
    // The log alone cannot tell the two apart — `codegraph index` is first either way. What
    // separates them is whether what the refresh produced reached the worktree, so the fake
    // writes a marker and the assertion is that the copy carried it.
    const bin = makeBin();
    process.env.PATH = bin;
    const source = makeSource();
    const worktree = makeWorktree();

    await provision(source, worktree);

    expect(existsSync(join(source, ".codegraph", "refreshed"))).toBe(true);
    expect(existsSync(join(worktree, ".codegraph", "refreshed"))).toBe(true);
  });

  test("syncs the copied index after the copy, never before it", async () => {
    // The worktree sync is gated on the worktree having an index, and only the copy can have
    // put one there — so the sync appearing in the log at all is the ordering proof.
    const bin = makeBin();
    process.env.PATH = bin;
    const worktree = makeWorktree();

    await provision(makeSource(), worktree);

    expect(recorded(bin)).toContain(`${worktree}\tcodegraph sync`);
  });

  test("skips codegraph entirely when the source has no index", async () => {
    const bin = makeBin();
    process.env.PATH = bin;
    const source = tempDir();
    const worktree = makeWorktree();

    await provision(source, worktree);

    expect(recorded(bin).filter((line) => line.includes("codegraph"))).toEqual([]);
  });

  test("is silent and harmless when neither tool is installed", async () => {
    // An absent tool is not a problem to report: a machine without codegraph is a machine
    // that never wanted an index, and a warning per worktree would be pure noise.
    const bin = tempDir();
    symlinkSync(REAL_GIT, join(bin, "git"));
    process.env.PATH = bin;
    const source = makeSource();
    const worktree = makeWorktree({ mise: true });

    await provision(source, worktree);

    expect(stderrText()).toBe("");
    // The copy needs no tool, so it is the one step that must still have happened.
    expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  test("runs no mise at all in a worktree that is not a mise project", async () => {
    const bin = makeBin();
    process.env.PATH = bin;
    const worktree = makeWorktree();

    await provision(makeSource(), worktree);

    expect(recorded(bin).filter((line) => line.includes("mise"))).toEqual([]);
  });

  test("falls back to `mise install` when the project defines no setup task", async () => {
    const bin = makeBin({ tasksExit: 1 });
    process.env.PATH = bin;
    const worktree = makeWorktree({ mise: true });

    await provision(makeSource(), worktree);

    expect(recorded(bin)).toContain(`${worktree}\tmise install`);
    expect(recorded(bin)).not.toContain(`${worktree}\tmise run setup`);
  });

  test("reports the install's outcome on stderr without failing the run", async () => {
    const bin = makeBin({ installExit: 3 });
    process.env.PATH = bin;
    const worktree = makeWorktree({ mise: true });

    await provision(makeSource(), worktree);

    expect(stderrText()).toContain("provisioning mise tooling");
    expect(stderrText()).toContain("failed (exit 3)");
  });

  test("seeds .env, and leaves an existing one alone", async () => {
    const bin = makeBin();
    process.env.PATH = bin;
    const source = makeSource();
    const fresh = makeWorktree();
    const occupied = makeWorktree();
    writeFileSync(join(occupied, ".env"), "MINE=1\n");

    await provision(source, fresh);
    await provision(source, occupied);

    expect(readFileSync(join(fresh, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(readFileSync(join(occupied, ".env"), "utf8")).toBe("MINE=1\n");
  });

  test("copies the untracked index but never a file git already tracks", async () => {
    // A tracked file arrives in a real worktree through the checkout. Copying it would land
    // an untracked duplicate, and the next rebase onto a branch that adds it fails before it
    // starts — so this is the one exclusion the "already there?" guard cannot express.
    const bin = makeBin();
    process.env.PATH = bin;
    const worktree = makeWorktree();

    await provision(makeSource(), worktree);

    expect(readFileSync(join(worktree, ".codegraph", "index.db"), "utf8")).toBe("source index");
    expect(existsSync(join(worktree, ".codegraph", ".gitignore"))).toBe(false);
  });

  test("copies past a unix socket in the index rather than failing on it", async () => {
    // The live failure in the Python implementation this replaces: `.codegraph/daemon.sock`
    // is a socket, no recursive copy can carry one, and the whole step died on it — printing
    // a warning on every single worktree creation.
    const bin = makeBin();
    process.env.PATH = bin;
    const source = makeSource();
    const worktree = makeWorktree();
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(join(source, ".codegraph", "daemon.sock"), resolve);
    });

    try {
      await provision(source, worktree);
    } finally {
      server.close();
    }

    expect(stderrText()).not.toContain("failed");
    expect(existsSync(join(worktree, ".codegraph", "index.db"))).toBe(true);
    expect(existsSync(join(worktree, ".codegraph", "daemon.sock"))).toBe(false);
  });

  test("warns on a failed step and still runs the steps after it", async () => {
    // A plain file where the index directory belongs is a copy that cannot succeed. The point
    // is not the errno — it is that one broken step neither throws nor takes the install down
    // with it, and that it says so rather than leaving an unexplained gap.
    const bin = makeBin();
    process.env.PATH = bin;
    const worktree = makeWorktree({ mise: true });
    writeFileSync(join(worktree, ".codegraph"), "not a directory\n");

    await provision(makeSource(), worktree);

    expect(stderrText()).toContain("wrk: context copy failed:");
    expect(recorded(bin)).toContain(`${worktree}\tmise run setup`);
  });

  test("never rejects, whatever a step does", async () => {
    const bin = makeBin({ installExit: 3 });
    process.env.PATH = bin;
    const worktree = makeWorktree({ mise: true });
    writeFileSync(join(worktree, ".codegraph"), "not a directory\n");

    expect(await provision(makeSource(), worktree).then(() => "resolved")).toBe("resolved");
  });
});
