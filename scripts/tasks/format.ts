/** The `format` task: rewrite every file in the repo to its formatter's output. */

import { execAndExit } from "./lib/exec";

/**
 * Builds the argv for `format`.
 *
 * `--no-stage` is what keeps this safe to run mid-commit: hk otherwise stages the
 * fixes it made, quietly widening a commit the user was assembling by hand.
 *
 * @param args - Extra arguments forwarded to hk.
 */
export function formatCommand(args: string[]): string[] {
  return ["hk", "fix", "--all", "--no-stage", ...args];
}

/** Runs {@link formatCommand} and exits with its status. */
export function runFormat(args: string[]): Promise<never> {
  return execAndExit([formatCommand(args)]);
}
