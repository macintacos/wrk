/**
 * The subprocess helper the rest of the CLI builds on.
 *
 * `wrk` is mostly a well-behaved front-end to `git` and `gh`, so nearly every operation
 * bottoms out in "run this argv, tell me what it said and how it exited". This module is
 * that one primitive; the git plumbing and the `gh` adapter are thin wrappers over it.
 *
 * Built on `node:child_process` rather than `Bun.spawn` deliberately: the published
 * artifact targets Node, so a Bun-only API here would have to be unpicked at build time.
 *
 * @packageDocumentation
 */

import { spawn } from "node:child_process";
import { constants } from "node:os";

/** Options for {@link run}. Every field is optional; the defaults inherit from this process. */
export interface RunOptions {
  /** Working directory for the child. Defaults to this process's cwd. */
  cwd?: string;

  /**
   * Variables layered *on top of* `process.env`, not a replacement for it — `git` and `gh`
   * both need the inherited `PATH` and `HOME` to function at all.
   */
  env?: Record<string, string>;

  /** Milliseconds to wait before killing the child with `SIGTERM`. Unlimited when unset. */
  timeout?: number;
}

/** What a finished child process reported. */
export interface RunResult {
  /** Everything the child wrote to stdout, decoded as UTF-8. */
  stdout: string;

  /** Everything the child wrote to stderr, decoded as UTF-8. */
  stderr: string;

  /**
   * The child's exit status. A child killed by a signal is reported as `128 + signum`, the
   * same convention a shell uses to populate `$?`, so a {@link RunOptions.timeout} kill
   * surfaces as `143` rather than as a separate field every caller has to remember.
   */
  code: number;
}

/**
 * Runs `cmd` with `args` and resolves with what it wrote and how it exited.
 *
 * **A nonzero exit is a value, not an error.** `git rev-parse --verify` exits 128 to say
 * "no such ref" and `gh pr view` exits 1 to say "no PR here"; both are ordinary control
 * flow here, so neither rejects. The promise rejects only when the child could not be
 * started at all (a missing binary, an unreadable `cwd`) — a failure the caller cannot
 * read an exit code off, because nothing ever ran.
 *
 * Arguments are passed as an argv array and never through a shell, so no element is
 * word-split, glob-expanded, or substituted. The child's stdin is closed rather than left
 * as an unwritten pipe, so a subprocess that reads stdin sees EOF immediately instead of
 * blocking until the timeout.
 *
 * @param cmd - Executable to run, resolved against `PATH`.
 * @param args - Arguments passed verbatim, one array element per argv entry.
 * @param options - See {@link RunOptions}.
 * @returns The child's output and exit status — see {@link RunResult}.
 * @throws If the child could not be spawned.
 *
 * @example
 * ```ts
 * const { stdout, code } = await run("git", ["rev-parse", "--verify", ref]);
 * if (code !== 0) return null; // no such ref — not exceptional
 * return stdout.trim();
 * ```
 */
export function run(
  cmd: string,
  args: string[] = [],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      timeout: options.timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // A promise settles once, so the ordering of these two is not load-bearing. It matters
    // anyway: Bun emits `error` *and then* `close` for a failed spawn, where Node emits
    // only `error`. `error` arrives first on both, so the rejection wins either way and
    // the trailing `close` is a no-op.
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ stdout, stderr, code: toExitStatus(code, signal) });
    });
  });
}

/**
 * Collapses `close`'s `(code, signal)` pair into one number.
 *
 * `code` is `null` exactly when the child was killed by a signal, which is what a timeout
 * produces. Mapping that to `128 + signum` keeps the shell convention and, more usefully,
 * keeps a plain `code !== 0` check correct at every call site.
 */
function toExitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;

  const signals: Partial<Record<NodeJS.Signals, number>> = constants.signals;
  return 128 + (signal === null ? 0 : (signals[signal] ?? 0));
}
