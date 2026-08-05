/** The `setup` task: bring a checkout's toolchain and dependencies up to date. */

import { execAndExit } from "./lib/exec";

/**
 * Builds the command sequence for `setup`.
 *
 * Both steps run unconditionally, which is what makes this useful on a checkout
 * that is already warm: after a `mise.lock` or `bun.lock` change it is the one
 * command that reconciles both. On a cold clone the bootstrap guard has usually
 * done this already, so `setup` is then a fast no-op rather than a special case.
 */
export function setupCommands(): string[][] {
  return [
    ["mise", "install"],
    ["bun", "install"],
  ];
}

/**
 * Runs {@link setupCommands} in order and exits with the first failure's status.
 *
 * Unlike the other tasks there is no underlying tool to forward to, so anything
 * passed here would be silently dropped. Rejecting it is the difference between
 * a mistyped flag doing nothing and a mistyped flag saying so.
 *
 * @param args - Must be empty; anything else is a usage error.
 */
export function runSetup(args: string[]): Promise<never> {
  if (args.length > 0) {
    console.error(`wrk: setup takes no arguments (got: ${args.join(" ")})`);
    process.exit(2);
  }

  return execAndExit(setupCommands());
}
