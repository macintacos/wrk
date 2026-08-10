/**
 * The repository shapes `wrk`'s contracts are asserted against, built once and shared.
 *
 * One place that knows how to produce a container, a default-branch checkout, a run worktree, an
 * unconverted clone and a dirty tree — the five shapes `wrk`'s contracts are asserted against.
 *
 * **Six other test files carry their own copies of these helpers and are deliberately not
 * migrated onto this module.** The rewrite is large, cannot be mutation-tested cheaply, and would
 * put seven landed PRs' assertions at risk to tidy an internal seam. It is also not as mechanical
 * as it looks: those files need three shapes this module does not yet have — a checkout of an
 * existing branch, a container carrying a fetch refspec and `origin/HEAD` (the only shape in
 * which the default-branch sync runs in full), and a way to add commits to the seed. Any retrofit
 * adds those first.
 *
 * **It also holds the harness for running the real CLI against them** — {@link runCli} for the
 * cases a pipe can answer, {@link driveCli} for the ones only a terminal can, and the
 * {@link childEnv} that shields both from the developer's own cache, configuration and `gh`.
 * Those belong beside the repositories rather than in one suite, because every command that
 * takes a cwd needs both halves and the second suite to want them would otherwise copy them.
 *
 * Everything here builds *real* repositories with the real `git`. Nothing is stubbed: a
 * conformance suite that asserted against a mocked git would certify the mock.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type PtySession, runInPty, typeUntil } from "../../../picker/test/fixtures/pty";
import { worktreeDirName } from "../../src/naming";
import { type RunResult, run } from "../../src/proc";

/** The CLI entry point, run as a script by {@link runCli}. */
const CLI = join(import.meta.dir, "../../src/cli.ts");

/**
 * The environment for fixture commands: this process's, minus everything binding git to a
 * repository.
 *
 * Read from git itself rather than from `../../src/git`, so the fixtures stay independent of the
 * module they build repositories for, and stay complete if git grows another variable.
 *
 * Shedding the environment is not a convenience. This suite runs under the repository's own
 * pre-push hook, and git exports `GIT_DIR` to every hook — under which `git init <dir>`
 * re-initialises *that* repository and leaves `<dir>` empty, so every fixture collapses.
 */
export const FIXTURE_ENV: Record<string, string | undefined> = {
  ...process.env,
  ...Object.fromEntries(
    execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" })
      .split("\n")
      .filter((name) => name !== "")
      .map((name) => [name, undefined]),
  ),
};

/** A committer identity that does not depend on the runner's git config. */
const IDENTITY = ["-c", "user.email=t@example.com", "-c", "user.name=T"];

/** The tracked file every fixture repository carries, so {@link dirty} has something to modify. */
const TRACKED_FILE = "README";

/** Temp roots to delete once the suite finishes — see {@link cleanupFixtures}. */
const roots: string[] = [];

/**
 * Runs `git` with any inherited repository binding shed, and returns its trimmed stdout.
 *
 * @param args - Arguments after the program name.
 * @param cwd - Where to run; defaults to this process's cwd.
 * @returns The child's stdout, trimmed.
 */
export function fixtureGit(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, env: FIXTURE_ENV, encoding: "utf8" }).trim();
}

/**
 * A fresh temp directory, resolved through `realpathSync`.
 *
 * The resolution is load-bearing on macOS, where `tmpdir()` is `/var/folders/…`, a symlink to
 * `/private/var/folders/…`. Git answers with the resolved path, so an unresolved fixture path
 * fails every comparison for a reason that has nothing to do with the code — which in a
 * conformance suite would read as a contract violation rather than as a fixture bug.
 *
 * @returns The absolute, symlink-resolved path of a new empty directory.
 */
export function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wrk-conformance-")));
  roots.push(dir);
  return dir;
}

/**
 * Removes every directory {@link tempDir} handed out. Call from the suite's `afterAll`.
 *
 * The list is module-global, so the first suite whose `afterAll` runs removes every root handed
 * out so far — safe only because bun runs test files one at a time. A second importer arriving
 * alongside a parallel runner would need per-suite lists instead.
 */
export function cleanupFixtures(): void {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Lands one commit carrying {@link TRACKED_FILE}. */
function commit(repo: string, message: string): void {
  writeFileSync(join(repo, TRACKED_FILE), `${message}\n`);
  fixtureGit(["add", "--", TRACKED_FILE], repo);
  fixtureGit([...IDENTITY, "commit", "-q", "-m", message], repo);
}

/**
 * A plain, non-bare repository on `branch` with one commit — the source the containers clone.
 *
 * @param branch - The branch to initialise on.
 * @returns The repository's absolute path.
 */
function makeSeed(branch = "main"): string {
  const dir = tempDir();
  fixtureGit(["init", "-q", "-b", branch, dir]);
  commit(dir, "init");
  return dir;
}

/** What {@link makeContainer} built. */
export interface Container {
  /** The container: `.bare` plus the `.git` pointer, and the checkouts beside them. */
  container: string;

  /** The default-branch checkout inside it. */
  checkout: string;
}

/**
 * A bare-repo container with its default-branch checkout in place — the shape `wrk` operates on.
 *
 * One per test rather than one for the suite: each case creates worktrees and branches in it, and
 * a shared container would make every later case depend on which ones ran first.
 *
 * The checkout's directory name is folded, for the reason {@link addRunWorktree} folds: a checkout
 * is a flat sibling of `.bare`, so a default branch carrying a `/` would otherwise be built as a
 * nested directory that is not the layout at all. `setup.ts` folds here too.
 *
 * @param branch - The default branch to build on.
 * @param at - Where to build it. Its leading directories are created by the `clone` below, so it
 *   need not exist. Defaults to a fresh {@link tempDir}. For the one caller that needs a
 *   container at a *chosen* path rather than at an arbitrary one: a directory scan is defined by
 *   how far below a root a container sits, so a fixture placed wherever `mkdtemp` felt like
 *   putting it cannot express the thing under test.
 * @returns The container and its default-branch checkout — see {@link Container}.
 */
export function makeContainer(branch = "main", at?: string): Container {
  const container = at ?? tempDir();
  const checkout = join(container, worktreeDirName(branch));
  fixtureGit(["clone", "-q", "--bare", makeSeed(branch), join(container, ".bare")]);
  writeFileSync(join(container, ".git"), "gitdir: ./.bare\n");
  fixtureGit(["worktree", "add", "-q", checkout, branch], container);
  return { container, checkout };
}

/**
 * Adds a run worktree to a container: a new branch, in the directory its folded form names.
 *
 * The directory name comes from {@link worktreeDirName} rather than from a literal, because
 * `isRunWorktree` requires the directory and the branch to agree — a hand-folded name that
 * drifted from the rule would produce a fixture that silently is not a run worktree, and the
 * `resumed` and `unrelated-worktree` cases would both quietly test something else.
 *
 * @param container - The container to place it in.
 * @param branch - The run branch, e.g. `EXC-1/add-thing`.
 * @returns The worktree's absolute path.
 */
export function addRunWorktree(container: string, branch: string): string {
  const path = join(container, worktreeDirName(branch));
  fixtureGit(["worktree", "add", "-q", "-b", branch, path], container);
  return path;
}

/**
 * An ordinary clone: a work tree with a real `.git` directory, and so not the bare layout.
 *
 * What `preflight` answers `unconverted-repo` for, and what `create` refuses.
 *
 * @param branch - The branch to build on.
 * @returns The clone's absolute path.
 */
export function makeUnconverted(branch = "main"): string {
  const dir = tempDir();
  fixtureGit(["clone", "-q", makeSeed(branch), join(dir, "work")]);
  return join(dir, "work");
}

/**
 * Makes a checkout's tree dirty in the way that blocks a switch and a pull.
 *
 * A **tracked** modification specifically: `preflight` excludes untracked files from its dirty
 * check on purpose, so an untracked scratch file here would produce a fixture that never trips
 * the verdict it exists to trip.
 *
 * @param checkout - The checkout to dirty.
 */
export function dirty(checkout: string): void {
  writeFileSync(join(checkout, TRACKED_FILE), "modified\n");
}

/**
 * Runs the real `wrk` CLI in a child process and reports what it wrote and how it exited.
 *
 * `process.execPath` is the runtime already running this suite, so no toolchain lookup is
 * involved and the child is the same binary a user's `wrk` would be. The git-binding variables
 * are shed here for the same reason {@link FIXTURE_ENV} sheds them: under the repository's own
 * pre-push hook an inherited `GIT_DIR` would point every fixture run at this repository.
 *
 * @param args - Arguments after `wrk`.
 * @param cwd - The directory to run from — which is the whole input for most of these contracts.
 * @param env - Extra environment for the child, merged over the shed baseline.
 * @returns The child's stdout, stderr and exit status — see `RunResult`.
 */
export function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = {},
): Promise<RunResult> {
  return run(process.execPath, [CLI, ...args], { cwd, env: { ...FIXTURE_ENV, ...env } });
}

/**
 * A directory holding `git` and nothing else, to be used as a child's whole `PATH`.
 *
 * `gh.ts` makes the spawn itself the presence gate, so an unreachable `gh` is answered
 * instantly and locally — where leaving the real `gh` reachable puts an authenticating,
 * possibly networked binary on the critical path of every case that uses this, with latency
 * nothing here can bound. It is also the more faithful fixture: "absent" is one of the four
 * conditions `gh.ts` folds into "could not answer", and the only one producible without a
 * network.
 *
 * Binaries are symlinked into a fresh directory rather than the directory being prepended to
 * the real `PATH`, because prepending would leave `gh` findable further along it.
 *
 * **A fresh directory per call, never one memoised at module scope.** This module is imported
 * once per *process* while {@link cleanupFixtures} is called by each test file, so a directory
 * built at import is removed by whichever suite finishes first and every later suite runs with
 * a `PATH` naming a directory that is gone. The symptom is `Executable not found in $PATH:
 * "git"` from a suite that never mentions `PATH`, in the full run only.
 *
 * A suite wanting a `gh` that *answers* writes its own script in here afterwards — see
 * `wt.test.ts`'s gated one and `prpick.test.ts`'s logging one. Both are `gh`-shaped fixtures
 * over this one directory rather than a second way of building it.
 *
 * @param also - Further binaries to make reachable, by the name they are spelled on `PATH`. A
 *   fixture `gh` script runs with this directory as its own whole `PATH`, so anything it
 *   shells out to has to be named here.
 * @returns The directory.
 */
export function shedGh(...also: string[]): string {
  const dir = tempDir();
  for (const name of ["git", ...also]) {
    const binary = Bun.which(name);
    if (binary === null) throw new Error(`${name} is not on PATH, so no fixture can shed gh`);
    symlinkSync(binary, join(dir, name));
  }

  return dir;
}

/**
 * Environment for one CLI child: a cache of its own, no config at all, and no `gh` unless
 * `path` says otherwise.
 *
 * None of the redirections is tidiness. Without `XDG_CACHE_HOME` these runs read and write the
 * developer's real `~/.cache/wrk`, so a case would depend on what a previous *real* `wrk` had
 * left there — and would leave entries of its own behind. Without `XDG_CONFIG_HOME` they read
 * the developer's real `~/.config/wrk/config.toml`, so anyone who has ever set `[glyphs]` would
 * fail a suite asserting against `DEFAULTS` for a reason that has nothing to do with the code.
 * `config.test.ts` shields the same variable for the same reason.
 *
 * `WRK_DEBUG` is shed for that same reason and is the sharpest of the three, because it is the
 * variable a developer working on these features exports: `debug()` writes to stderr, which is
 * the channel the pickers draw on, and cases in both suites assert that nothing prefixed
 * `wrk: ` reaches the terminal. Empty rather than absent, since `debug()` tests the value for
 * truthiness and a `Record<string, string>` has no way to spell "unset".
 *
 * @param cacheHome - `XDG_CACHE_HOME` for the child. A private empty directory by default,
 *   which is the cold-cache case; pass one that has been seeded to get a warm one.
 * @param path - `PATH` for the child. A `gh`-less one by default; pass {@link shedGh}'s answer
 *   with a script written into it for a `gh` that answers.
 */
export function childEnv(
  cacheHome: string = tempDir(),
  path: string = shedGh(),
): Record<string, string> {
  return { PATH: path, XDG_CACHE_HOME: cacheHome, XDG_CONFIG_HOME: tempDir(), WRK_DEBUG: "" };
}

/** What a {@link driveCli} script echoes once the CLI has exited, whatever its status. */
export const ENDED = "EXIT:";

/**
 * The exit status {@link driveCli}'s script echoed, since the shell's own status is bash's.
 *
 * The pattern is built from {@link ENDED} rather than written out, so the marker has one
 * definition. Spelled literally, changing it would leave every driven case reading `NaN` — a
 * failure that names neither the marker nor this function.
 */
export function status(capture: string): number {
  return Number(new RegExp(`${ENDED}(\\d+)`).exec(capture)?.[1] ?? Number.NaN);
}

/**
 * {@link typeUntil} for a key that ends the run, which {@link driveCli}'s script says out loud.
 *
 * The condition every driven CLI case shares, and one `typeUntil`'s repetition precondition is
 * satisfied by: an extra keystroke landing after the run has already ended reaches `bash`,
 * which is running a `-c` script and never reads its stdin.
 */
export function quit(session: PtySession, key: string): Promise<void> {
  return typeUntil(session, key, (text) => text.includes(ENDED), "ended");
}

/**
 * Runs the real `wrk` CLI inside a pty, from `cwd`, with stdout captured to a file.
 *
 * The counterpart to {@link runCli} for everything only true of a terminal: the pickers read
 * `isTTY` off stdin and stderr, and the `cd` protocol is a claim about stdout and an exit
 * status at once.
 *
 * **Stdout is redirected away from the terminal**, for the reason `picker.test.ts` gives: the
 * capture would otherwise hold the answer as well as the frames, and `frameLines` would count
 * it as one more rendered row. It is also the shape these commands actually ship in, both the
 * `cd` shim and every agent-facing caller having captured it.
 *
 * The environment is exported inside the script rather than passed through `runInPty`, so a
 * restricted `PATH` reaches the CLI child without also deciding where `bash` itself is found.
 *
 * @param cwd - Where to run the CLI from, which is the whole input for most of these cases.
 * @param argv - Arguments after `wrk`.
 * @param drive - Types keys and reads frames while the run is live.
 * @param options - {@link childEnv}'s two, as an object rather than trailing positionals —
 *   `RunOptions`, `PullRequestOptions`, `PtyOptions`, `PickOptions` and `CacheKey` all take
 *   this shape, and a caller wanting only the second would otherwise pass `undefined` first.
 * @returns The capture, bash's exit status, and what the CLI wrote to stdout. Read the CLI's
 *   own status with {@link status} rather than off `exitCode`, which is the shell's.
 */
export async function driveCli(
  cwd: string,
  argv: string[],
  drive: (session: PtySession) => Promise<void>,
  options: { cacheHome?: string; path?: string; rows?: number } = {},
): Promise<{ capture: string; exitCode: number; stdout: string }> {
  const out = join(tempDir(), "stdout");
  const quoted = argv.map((argument) => `"${argument}"`).join(" ");
  const exports = Object.entries(childEnv(options.cacheHome, options.path))
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ");

  const script = `cd "${cwd}" && ${exports} "${process.execPath}" "${CLI}" ${quoted} >"${out}"; echo "${ENDED}$?"`;
  const run = await runInPty(script, { rows: options.rows ?? 24, drive });

  return { ...run, stdout: await Bun.file(out).text() };
}
