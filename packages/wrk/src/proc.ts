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

/** Options for {@link run}. */
export interface RunOptions {
  /** Working directory for the child. Defaults to this process's cwd. */
  cwd?: string;

  /**
   * Variables layered *on top of* `process.env`, not a replacement for it — `git` and `gh`
   * both need the inherited `PATH` and `HOME` to function at all. An `undefined` value
   * unsets an inherited variable, which is how a caller sheds a `GIT_DIR` or
   * `GIT_WORK_TREE` that would otherwise silently override {@link RunOptions.cwd}.
   */
  env?: Record<string, string | undefined>;

  /**
   * Milliseconds after which the child is sent `SIGTERM`. Unlimited when unset.
   *
   * Best-effort rather than a deadline: there is no `SIGKILL` escalation, and the promise
   * settles when the output pipes close rather than when the child exits — so a child that
   * traps `SIGTERM`, or any descendant still holding the inherited stdout pipe, outlives
   * it.
   */
  // ponytail: one SIGTERM, no escalation. Add a SIGKILL grace timer if a real hang shows up.
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
      env: { ...process.env, ...options.env },
      timeout: options.timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // `error` on the child covers the spawn and the kill, never the pipes. An unhandled
    // `error` on either stream would take the whole CLI down instead of rejecting here.
    child.stdout.on("error", reject);
    child.stderr.on("error", reject);

    // A failed spawn emits `error` and then `close` with code -2, on both Node and Bun.
    // `error` arrives first, so the rejection wins and the trailing `close` is a no-op — a
    // promise settles once.
    child.on("error", reject);

    // `close` rather than `exit`: `exit` can fire while output is still in flight.
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
 * keeps a plain `code !== 0` check correct at every call site. The `SIGTERM` fallback is
 * unreachable — `close` never reports both as `null` — and exists only to keep the lookup
 * total; it names the signal a timeout would have sent rather than inventing a code.
 */
function toExitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? 128 + constants.signals[signal ?? "SIGTERM"];
}
