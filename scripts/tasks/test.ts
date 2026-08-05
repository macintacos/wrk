/** The `test` task: run the workspace's test suite. */

import { type Argv, execAndExit } from "./lib/exec";

/**
 * Builds the argv for `test`.
 *
 * Reaches `bun test` directly rather than through `hk run test`, because that
 * lane takes no filter — a forwarded path or `-t` pattern would have nowhere to
 * go, which is most of what anyone wants from a test task. (`hk test` is hk's own
 * fixture runner and unrelated to either.)
 *
 * @param args - Extra arguments forwarded to the test runner: paths, `-t`, `--bail`.
 */
export function testCommand(args: string[]): Argv {
  return ["bun", "test", ...args];
}

/** Runs {@link testCommand} and exits with its status. */
export function runTest(args: string[]): Promise<never> {
  return execAndExit([testCommand(args)]);
}
