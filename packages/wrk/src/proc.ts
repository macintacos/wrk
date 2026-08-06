/**
 * The subprocess helper the rest of the CLI builds on.
 *
 * `wrk` is mostly a well-behaved front-end to `git` and `gh`, so nearly every operation
 * bottoms out in "run this argv, tell me what it said and how it exited". {@link run} is
 * that one primitive; the git plumbing and the `gh` adapter are thin wrappers over it.
 *
 * {@link detach} is the other half of the same idea and the only other place in the package
 * a child is started: work whose *result* nobody waits for, running in a process that
 * outlives this one. It is here rather than beside its caller because what makes it correct
 * is three spawn settings that have to travel together — see its own documentation — and a
 * second `spawn` call site elsewhere in the package would be one edit away from losing one
 * of them, invisibly.
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

/**
 * Starts `cmd` in a process that outlives this one, and returns without waiting for it.
 *
 * For work whose result nobody is waiting on — a cache refreshed so that the *next*
 * invocation is fast, where paying for it now is the whole thing being avoided. There is no
 * promise, no output and no exit status, because a caller that wanted any of the three
 * wanted {@link run}.
 *
 * Three spawn settings make that true and none of them is decoration:
 *
 * - **`detached`** puts the child in a process group of its own, so a signal delivered to
 *   this process's group — the `^C` that ends a shell pipeline — does not take it along.
 * - **`stdio: "ignore"`** gives the child three descriptors onto `/dev/null` rather than
 *   this process's own. A child that inherits the parent's stdout holds that pipe open
 *   after the parent has exited, so whatever is capturing the parent's output blocks until
 *   the *child* finishes — reintroducing, from the far side, exactly the wait this function
 *   exists to avoid. That failure is invisible from everywhere else: the bytes, the ordering
 *   and the exit status all stay correct, and only a clock shows it.
 * - **`unref`** drops the child from this process's event loop, so an otherwise finished CLI
 *   exits rather than lingering until the child is done.
 *
 * A child that could not be started is **swallowed**, which is the one judgement here rather
 * than a mechanism. `spawn` reports that asynchronously as an `error` event, and an `error`
 * event with no listener is rethrown as an uncaught exception — so a background job that
 * could not start would take down the invocation that merely asked for one. There is nothing
 * a caller could do about it either: the work was optional, which is why it was detached.
 *
 * @param cmd - Executable to run, resolved against `PATH`.
 * @param args - Arguments passed verbatim, one array element per argv entry.
 * @returns The child's process id, or `undefined` when it could not be started — useful for
 *   a diagnostic, and the only evidence this function leaves behind.
 *
 * @example
 * ```ts
 * detach(process.execPath, [fileURLToPath(import.meta.url), container]);
 * ```
 */
export function detach(cmd: string, args: string[] = []): number | undefined {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();

  return child.pid;
}
