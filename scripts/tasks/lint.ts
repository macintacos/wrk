/** The `lint` task: report every formatter and linter finding without fixing any. */

import { type Argv, execAndExit } from "./lib/exec";

/**
 * Builds the argv for `lint`.
 *
 * `hk check` is the read-only half of the pair `format` writes with, so this is
 * the one to run in anger — it fails on a finding instead of silently repairing
 * it.
 *
 * @param args - Extra arguments forwarded to hk.
 */
export function lintCommand(args: string[]): Argv {
  return ["hk", "check", "--all", ...args];
}

/** Runs {@link lintCommand} and exits with its status. */
export function runLint(args: string[]): Promise<never> {
  return execAndExit([lintCommand(args)]);
}
