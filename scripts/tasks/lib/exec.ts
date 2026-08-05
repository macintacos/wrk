/**
 * The one primitive every task bottoms out in: run a tool, show the user what it
 * says, exit with what it returned.
 *
 * Deliberately *not* built on `packages/wrk/src/proc.ts`. That helper captures
 * stdout and stderr into strings because its callers parse `git` output; a task
 * runner needs the opposite — inherited stdio, so `tsc` and `bun test` stream
 * their progress live and keep the colours they only emit to a TTY. Buffering
 * that until exit would be a worse task runner, not a shared one.
 *
 * @packageDocumentation
 */

/**
 * A command as an argv array: the executable, then its arguments.
 *
 * A non-empty tuple rather than `string[]` so the executable is statically known
 * to exist — under `noUncheckedIndexedAccess` a plain array would make every
 * spawn site assert on `cmd[0]`.
 */
export type Argv = [string, ...string[]];

/**
 * Runs `cmd` with this process's stdio and resolves with its exit code.
 *
 * A nonzero exit is a value, not a throw: the caller decides whether to stop.
 * `env` is passed explicitly because `Bun.spawn` otherwise uses the environment
 * snapshotted at startup, which drops anything the bootstrap guard exported into
 * `process.env` on its way through.
 *
 * @param cmd - The executable and its arguments.
 * @returns The child's exit code.
 */
export async function runForward(cmd: Argv): Promise<number> {
  const [bin, ...args] = cmd;

  const child = Bun.spawn([bin, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
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
export async function execAndExit(cmds: Argv[]): Promise<never> {
  for (const cmd of cmds) {
    const code = await runForward(cmd);

    if (code !== 0) process.exit(code);
  }

  process.exit(0);
}
