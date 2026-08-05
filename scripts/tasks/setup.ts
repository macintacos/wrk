/** The `setup` task: bring a checkout's toolchain and dependencies up to date. */

import { type Argv, execAndExit } from "./lib/exec";

/**
 * Builds the command sequence for `setup`.
 *
 * Both steps run unconditionally, which is what makes this useful on a checkout
 * that is already warm: after a `mise.lock` or `bun.lock` change it is the one
 * command that reconciles both. On a cold clone the bootstrap guard has usually
 * done this already, so `setup` is then a fast no-op rather than a special case.
 */
export function setupCommands(): Argv[] {
  return [
    ["mise", "install"],
    ["bun", "install"],
  ];
}

/** Runs {@link setupCommands} in order and exits with the first failure's status. */
export function runSetup(): Promise<never> {
  return execAndExit(setupCommands());
}
