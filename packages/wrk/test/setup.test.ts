/**
 * Contract of the `repo-setup` engine and of the `wrk agent repo-setup` command over it: what
 * the container ends up holding, what git is asked in what order, what is refused and in which
 * order, and what is left on disk when a step fails.
 *
 * Every case drives the real `git` binary against real repositories built in temp directories.
 * Fixtures are built with `execFileSync` rather than with this package's own wrappers, so a
 * broken wrapper cannot quietly build the repository that then proves it correct. The fixture
 * helpers are copied from `worktree.test.ts` rather than lifted into a shared module: a shared
 * fixture-repo builder is the explicit scope of EXC-1003, and extracting one here would settle
 * that issue's design as a side effect.
 *
 * **Three of the six acceptance criteria are properties of the argv, not of the result**, and
 * one fixture pins all three: a `git` shim on `PATH` that appends its own environment and
 * arguments to a log and then `exec`s the real git. One successful run through it yields the
 * whole command sequence with each call's `GIT_TERMINAL_PROMPT` beside it — which is the only
 * way to assert `--`, the refspec and the terminal-prompt suppression against a *successful*
 * run rather than by inferring them from a failure message.
 *
 * The command cases run the real CLI in a child process, for `cli.test.ts`'s reason — `main`
 * assigns `process.exitCode` rather than calling `process.exit`, so asserting a status in
 * process would leave the test runner itself exiting nonzero — and because stdout as an actual
 * stream is the only way to assert that a failed run writes nothing to it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommandFailed, Refusal } from "../src/errors";
import { type RunResult, run } from "../src/proc";
import { repoSetup } from "../src/setup";

/** The CLI entry point, run as a script by the command cases below. */
const CLI = join(import.meta.dir, "../src/cli.ts");

/**
 * The environment for fixture commands: this process's, minus everything binding git to a
 * repository.
 *
 * Read from git itself rather than from `../src/git`, so the fixtures stay independent of the
 * module they build repositories for, and stay complete if git grows another variable.
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

/**
 * Runs `git` with any inherited repository binding shed, and returns its trimmed stdout.
 *
 * Shedding the environment is not a convenience. This suite runs under the repository's own
 * pre-push hook, and git exports `GIT_DIR` to every hook — under which `git init <dir>`
 * re-initialises *that* repository and leaves `<dir>` empty, so every fixture collapses.
 */
function fixtureGit(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, env: FIXTURE_ENV, encoding: "utf8" }).trim();
}

/** The real `git`, so a `PATH` holding nothing else still lets `wrk` run at all. */
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

/** Temp roots to delete once the suite finishes. */
const roots: string[] = [];

/**
 * A fresh temp directory, resolved through `realpathSync`.
 *
 * The resolution is load-bearing on macOS, where `tmpdir()` is `/var/folders/…`, a symlink to
 * `/private/var/folders/…`. Git answers with the resolved path, so an unresolved fixture path
 * fails every comparison for a reason that has nothing to do with the code.
 */
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wrk-setup-")));
  roots.push(dir);
  return dir;
}

/** Lands one empty commit, with an identity that does not depend on the runner's git config. */
function commit(repo: string, message: string): void {
  fixtureGit(
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      message,
    ],
    repo,
  );
}

/** A plain, non-bare repository on `branch` with exactly one commit. */
function makeRepo(branch = "main"): string {
  const dir = tempDir();
  fixtureGit(["init", "-q", "-b", branch, dir]);
  commit(dir, "init");
  return dir;
}

/**
 * A bare repository with no commits — the shape a just-created remote has.
 *
 * The one failure mode that gets past the clone: `remote set-head -a` cannot determine a HEAD
 * there and exits nonzero, by which point `.bare` and the `.git` pointer are already on disk.
 * That is what makes it the fixture the cleanup has to be proved against; see the cleanup case.
 */
function makeCommitlessRepo(): string {
  const dir = join(tempDir(), "empty.git");
  fixtureGit(["init", "-q", "--bare", dir]);
  return dir;
}

let seed: string;
let trunkSeed: string;
let commitlessSeed: string;

/** Restored at the end, since the whole suite runs in one process. */
const originalPath = process.env.PATH;

beforeAll(() => {
  seed = makeRepo("main");
  trunkSeed = makeRepo("trunk");
  commitlessSeed = makeCommitlessRepo();

  // `PATH` holds one `git` and nothing else for the whole file, following `provision.test.ts`:
  // `run` reads `process.env` at call time, so this is the injection seam the real `provision`
  // does not otherwise have. Every successful run here ends in `provisionCheckout`, and what
  // that step does with a real `codegraph` or `mise` is `provision.test.ts`'s subject, not this
  // file's — leaving them reachable would index a temp repository and start a daemon per case.
  const bin = tempDir();
  symlinkSync(REAL_GIT, join(bin, "git"));
  process.env.PATH = bin;
});

afterAll(() => {
  process.env.PATH = originalPath;
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("repoSetup", () => {
  test("builds the container in the cwd and reports what it made", async () => {
    const container = tempDir();

    const built = await repoSetup(container, seed);

    expect(built).toEqual({
      container,
      checkout_path: join(container, "main"),
      default_branch: "main",
    });
    // A directory at the right path is not yet a checkout; git saying it is one is.
    expect(fixtureGit(["rev-parse", "--show-toplevel"], built.checkout_path)).toBe(
      built.checkout_path,
    );
    expect(fixtureGit(["config", "core.bare"], join(container, ".bare"))).toBe("true");
  });

  test("writes the .git pointer file that makes the container a repository", async () => {
    // A *file*, not a directory: `isBareLayout` requires exactly that, so a container missing
    // it is one every later `wrk agent create` refuses.
    const container = tempDir();

    await repoSetup(container, seed);

    expect(readFileSync(join(container, ".git"), "utf8")).toBe("gitdir: ./.bare\n");
  });

  test("sets the fetch refspec a bare clone omits, and populates the tracking refs", async () => {
    // `git clone --bare` configures no refspec, so without this nothing ever writes
    // refs/remotes/origin/* — and the refs are asserted rather than the config alone, because
    // the config without the fetch that follows it leaves them just as empty.
    const container = tempDir();

    await repoSetup(container, seed);

    const bare = join(container, ".bare");
    expect(fixtureGit(["config", "--get", "remote.origin.fetch"], bare)).toBe(
      "+refs/heads/*:refs/remotes/origin/*",
    );
    expect(fixtureGit(["for-each-ref", "--format=%(refname)", "refs/remotes/origin"], bare)).toBe(
      "refs/remotes/origin/HEAD\nrefs/remotes/origin/main",
    );
  });

  test("points origin/HEAD at the default branch, which git before 2.47 does not", async () => {
    const container = tempDir();

    await repoSetup(container, seed);

    expect(fixtureGit(["symbolic-ref", "refs/remotes/origin/HEAD"], join(container, ".bare"))).toBe(
      "refs/remotes/origin/main",
    );
  });

  test("gives the checkout an upstream, so a later pull has something to fast-forward", async () => {
    const container = tempDir();

    const built = await repoSetup(container, seed);

    expect(fixtureGit(["rev-parse", "--abbrev-ref", "@{upstream}"], built.checkout_path)).toBe(
      "origin/main",
    );
  });

  test("names the checkout from the resolved default branch rather than assuming one", async () => {
    // The whole reason the branch is resolved rather than hard-coded: a `main` literal passes
    // every case above and produces a container with no checkout at all here.
    const container = tempDir();

    const built = await repoSetup(container, trunkSeed);

    expect(built.default_branch).toBe("trunk");
    expect(built.checkout_path).toBe(join(container, "trunk"));
    expect(fixtureGit(["symbolic-ref", "HEAD"], built.checkout_path)).toBe("refs/heads/trunk");
  });

  test("folds the checkout directory while the branch keeps its slashes", async () => {
    // The one deliberate divergence from `agent_exec_worktree.py`, which names the directory
    // after the branch as it found it. The checkout is a flat sibling of `.bare`, so a default
    // branch carrying a `/` has to fold exactly as a run worktree's does — unfolded, git makes
    // `release/` a directory and the container gains a level nothing else in `wrk` expects.
    const container = tempDir();

    const built = await repoSetup(container, makeRepo("release/2.0"));

    expect(built.default_branch).toBe("release/2.0");
    expect(built.checkout_path).toBe(join(container, "release+2.0"));
    expect(fixtureGit(["symbolic-ref", "HEAD"], built.checkout_path)).toBe(
      "refs/heads/release/2.0",
    );
  });

  test("refuses a directory inside a repository first, though it is also not empty", async () => {
    // The ordering criterion, and it needs both conditions true at once: an existing checkout
    // trips *both* refusals, and only this one has advice that applies. A swapped pair would
    // send someone standing in their own repository off to find an empty directory.
    const failure: unknown = await repoSetup(seed, trunkSeed).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Refusal);
    expect((failure as Refusal).message).toMatch(/already inside a git repository/);
    expect((failure as Refusal).message).toMatch(/repo-setup skill/);
    expect((failure as Refusal).message).not.toMatch(/not empty/);
  });

  test("refuses a non-empty directory that is in no repository, with the other remedy", async () => {
    // The two refusals carry different remedies on purpose. Telling someone in a plain
    // directory of files to "convert that repository instead" names one that is not there.
    const occupied = tempDir();
    writeFileSync(join(occupied, "notes.txt"), "hello\n");

    const failure: unknown = await repoSetup(occupied, seed).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Refusal);
    expect((failure as Refusal).message).toMatch(/not empty/);
    expect((failure as Refusal).message).toMatch(/empty directory/);
    expect((failure as Refusal).message).not.toMatch(/convert/);
  });

  test("empties the cwd when a step after the clone fails", async () => {
    // Cleanup is mandatory rather than tidy: `.bare` plus the `.git` pointer *is* a repository,
    // so wreckage left behind trips the inside-a-repository refusal on the next run and sends
    // the user off to convert a container with no checkout in it.
    //
    // The seed is commitless rather than absent, and that is the whole point of this case. A
    // *failed clone* leaves nothing behind — git removes its own partial directory — so a case
    // built on one asserts an empty directory that would be empty with no cleanup at all. Here
    // the clone succeeds and `remote set-head -a` is the step that cannot: by then both `.bare`
    // and the pointer file are on disk, and only this function's `catch` removes them.
    const container = tempDir();

    const failure: unknown = await repoSetup(container, commitlessSeed).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CommandFailed);
    expect((failure as CommandFailed).code).not.toBe(0);
    expect(readdirSync(container)).toEqual([]);
  });

  test("still reports a clone that could not start, without inventing an exit status", async () => {
    const container = tempDir();

    const failure: unknown = await repoSetup(container, join(container, "nope")).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CommandFailed);
    expect((failure as CommandFailed).code).not.toBe(0);
  });

  test("passes the URL after a --, so an option-shaped one is not read as a flag", async () => {
    // The URL crosses a trust boundary — an agent relays whatever a human or a ticket body
    // supplied — and `--upload-pack=<cmd>` is a command git would run. Without the separator
    // git consumes it as its own option and reads `.bare` as the repository instead, which is
    // exactly what the second assertion catches.
    const container = tempDir();
    const hostile = "--upload-pack=/bin/false";

    const failure: unknown = await repoSetup(container, hostile).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CommandFailed);
    expect((failure as CommandFailed).message).toContain(hostile);
    expect((failure as CommandFailed).message).not.toContain("repository '.bare'");
  });
});

/**
 * A `PATH` holding one executable named `git`: a shim that records what it was asked, and with
 * which terminal-prompt setting, before `exec`ing the real git.
 *
 * Each line is tab-separated — `GIT_TERMINAL_PROMPT` first, then one field per argument — so a
 * value containing a space cannot be mistaken for two arguments. The variable is read with
 * `${…-unset}` rather than `${…:-unset}`: the distinction being asserted is *set to zero*
 * versus *not set at all*, and `:-` would collapse an explicit empty value into the latter.
 *
 * @returns The directory to put on `PATH`, and the log file the shim appends to.
 */
function makeRecordingGit(): { bin: string; log: string } {
  const bin = tempDir();
  const log = join(bin, "git.log");
  writeFileSync(
    join(bin, "git"),
    [
      "#!/bin/sh",
      // A template literal with the `$` escaped, so the shell's own `${…}` is written
      // literally: in a plain string biome reads it as a template placeholder someone forgot
      // to make interpolating, which is exactly the mistake the rule exists to catch.
      `{ printf "%s" "\${GIT_TERMINAL_PROMPT-unset}"; printf "\\t%s" "$@"; printf "\\n"; } >> "$WRK_GIT_LOG"`,
      `exec ${REAL_GIT} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "git"), 0o755);
  return { bin, log };
}

/** One recorded invocation: the git arguments, and whether the prompt was suppressed. */
interface Recorded {
  prompt: string;
  args: string[];
}

/** Every git invocation the shim saw, oldest first. */
function recorded(log: string): Recorded[] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [prompt, ...args] = line.split("\t");
      return { prompt: prompt ?? "", args };
    });
}

/** Runs `wrk agent repo-setup <url>` in a child process, from `cwd`. */
function agentRepoSetup(
  cwd: string,
  url: string,
  env?: Record<string, string | undefined>,
): Promise<RunResult> {
  return run(process.execPath, [CLI, "agent", "repo-setup", url], { cwd, env });
}

describe("the git calls repo-setup makes", () => {
  let calls: Recorded[];

  beforeAll(async () => {
    const { bin, log } = makeRecordingGit();
    const container = tempDir();

    const result = await agentRepoSetup(container, seed, { PATH: bin, WRK_GIT_LOG: log });
    expect(result.code).toBe(0);

    calls = recorded(log);
  });

  test("suppresses the credential prompt on every call that reaches the network", async () => {
    // git reads /dev/tty directly, so capturing output does not suppress its prompt — an
    // unauthenticated call would block forever with no output, wedging the calling agent's
    // subprocess rather than failing. All three talk to the remote, and a credential helper
    // that answered the clone need not still answer the two after it.
    const networked = calls.filter(({ args }) =>
      ["clone", "fetch", "remote"].includes(args[0] ?? ""),
    );

    expect(networked.map(({ args }) => args[0])).toEqual(["clone", "fetch", "remote"]);
    expect(networked.map(({ prompt }) => prompt)).toEqual(["0", "0", "0"]);
  });

  test("puts the -- immediately before the URL, where no option can precede it", async () => {
    const clone = calls.find(({ args }) => args[0] === "clone");

    expect(clone?.args).toEqual(["clone", "--bare", "--", seed, ".bare"]);
  });

  test("runs the conversion recipe's steps, in the recipe's order", async () => {
    // Parity with `agent_exec_worktree.py repo-setup`, which is the strongest evidence
    // available that this builds the layout the rest of `wrk` expects. Only the mutating and
    // networked steps are listed: the read-only probes between them are `repo.ts`'s business
    // and change as its resolution rules do.
    const steps = calls
      .map(({ args }) => args.slice(0, 3).join(" "))
      .filter((step) =>
        ["clone", "config remote.origin.fetch", "fetch origin", "remote set-head", "worktree add"]
          .map((prefix) => step.startsWith(prefix))
          .includes(true),
      );

    expect(steps).toEqual([
      "clone --bare --",
      "config remote.origin.fetch +refs/heads/*:refs/remotes/origin/*",
      "fetch origin",
      "remote set-head origin",
      `worktree add main`,
    ]);
  });
});

describe("wrk agent repo-setup", () => {
  test("emits the envelope, carrying container first", async () => {
    const container = tempDir();

    const result = await agentRepoSetup(container, seed);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      container,
      checkout_path: join(container, "main"),
      default_branch: "main",
    });
    // Key order is part of the contract, not an accident of the serializer: two runs of the
    // same command have to diff cleanly.
    expect(Object.keys(JSON.parse(result.stdout))).toEqual([
      "container",
      "checkout_path",
      "default_branch",
    ]);
    // A clone can run for minutes, and stderr is the only channel allowed to say so — the
    // envelope above is what stdout is reserved for.
    expect(result.stderr).toContain(`wrk: cloning ${seed} into ${container}`);
  });

  test("writes nothing to stdout when it refuses, so `jq -er` fails rather than exiting 0", async () => {
    const result = await agentRepoSetup(seed, trunkSeed);

    expect(result.stdout).toBe("");
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^wrk: .* is already inside a git repository/);
  });

  test("inherits git's own status rather than flattening it to the refusal code", async () => {
    // A clone of a path that is not there, because git answers *that* with 128 — a status
    // distinguishable from the `1` a refusal exits with, which is the whole claim. `set-head`'s
    // own failure exits 1 and would leave this case unable to tell inheriting from flattening.
    const container = tempDir();

    const result = await agentRepoSetup(container, join(container, "nope"));

    expect(result.stdout).toBe("");
    expect(result.code).not.toBe(0);
    expect(result.code).not.toBe(1);
    // `m`, not an anchor at the start: the progress line is written before the clone begins,
    // so the failure is never the first thing on the channel.
    expect(result.stderr).toMatch(/^wrk: git clone --bare -- /m);
  });

  test("says nothing on stdout and leaves the cwd empty when a step after the clone fails", async () => {
    // The commitless seed, for the engine case's reason: it is the failure that gets past the
    // clone, so the empty directory below is one the `catch` had to produce.
    const container = tempDir();

    const result = await agentRepoSetup(container, commitlessSeed);

    expect(result.stdout).toBe("");
    expect(result.code).not.toBe(0);
    expect(readdirSync(container)).toEqual([]);
  });
});
