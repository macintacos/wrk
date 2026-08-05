/** The `typecheck` task: type-check the whole workspace in one program. */

import { execAndExit } from "./lib/exec";

/**
 * Builds the argv for `typecheck`.
 *
 * Reaches `tsc` directly rather than through `hk run typecheck`. hk adds nothing
 * to a whole-program check that takes no file list, and going direct is what lets
 * a forwarded flag like `--pretty` land somewhere — `hk run` has nowhere to put
 * it. TypeScript is a dev dependency rather than a mise tool, hence `bun x`.
 *
 * @param args - Extra arguments forwarded to tsc.
 */
export function typecheckCommand(args: string[]): string[] {
  return ["bun", "x", "tsc", "--noEmit", "-p", "tsconfig.json", ...args];
}

/** Runs {@link typecheckCommand} and exits with its status. */
export function runTypecheck(args: string[]): Promise<never> {
  return execAndExit([typecheckCommand(args)]);
}
