/**
 * The one primitive every task bottoms out in: run a tool, show the user what it
 * says, exit with what it returned.
 *
 * Deliberately *not* built on `packages/wrk/src/proc.ts`, for two reasons. That
 * helper captures stdout and stderr into strings because its callers parse `git`
 * output; a task runner needs the opposite — inherited stdio, so `tsc` and
 * `bun test` stream their progress live and keep the colours they only emit to a
 * TTY. Adding a `stdio` option to `run()` would make its `RunResult.stdout`
 * conditionally meaningless for every existing caller. It is also the wrong side
 * of a boundary: `packages/wrk` is source that ships in a published artifact,
 * `scripts/` is workspace tooling, and importing across that line to save ten
 * lines is coupling worth refusing.
 *
 * `proc.ts` avoids `Bun.spawn` because the published artifact targets Node.
 * Nothing here ever runs outside bun, so this file uses it freely.
 *
 * @packageDocumentation
 */

/**
 * Runs `cmd` with this process's stdio and resolves with its exit code.
 *
 * A nonzero exit is a value, not a throw: the caller decides whether to stop.
 * Bun reports a signal death as `128 + signum`, so a plain `code !== 0` check
 * stays correct for a killed child too.
 *
 * @param cmd - The executable and its arguments.
 * @returns The child's exit code.
 */
export async function runForward(cmd: string[]): Promise<number> {
  const child = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    // Passed explicitly so a variable set at runtime is not lost to the
    // environment Bun snapshotted at startup.
    env: process.env,
  });

  return await child.exited;
}

/**
 * Runs each command in order and ends the process with the first nonzero code.
 *
 * Sequential-and-stop is what a task expects: `setup` must not run `bun install`
 * after `mise install` failed, since the install it would attempt is the one
 * whose toolchain is missing.
 *
 * @param cmds - Commands to run in order.
 * @returns Never — the process exits.
 */
export async function execAndExit(cmds: string[][]): Promise<never> {
  for (const cmd of cmds) {
    const code = await runForward(cmd);

    if (code !== 0) process.exit(code);
  }

  process.exit(0);
}
