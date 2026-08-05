/**
 * The one commander tree behind every `.mise/tasks/` forwarder.
 *
 * Each forwarder is a single meaningful line — `exec bun scripts/tasks/cli.ts
 * <name> "$@"` — so flags, defaults and `--help` are defined once here in
 * TypeScript rather than re-implemented in five bash scripts that drift apart.
 *
 * Actions are injectable so the parsing can be tested for real: `test/tasks.test.ts`
 * drives this exact tree and records what each task *would* have run, spawning
 * nothing.
 *
 * @packageDocumentation
 */

import { Command } from "@commander-js/extra-typings";

import { runFormat } from "./format";
import { runLint } from "./lint";
import { runSetup } from "./setup";
import { runTest } from "./test";
import { runTypecheck } from "./typecheck";

/**
 * What each task does when its subcommand is selected.
 *
 * The real implementations never return — they exit the process — which is why
 * `Promise<never>` satisfies this. A test substitutes recorders that return
 * normally.
 */
export interface TaskActions {
  format(args: string[]): void | Promise<void>;
  lint(args: string[]): void | Promise<void>;
  typecheck(args: string[]): void | Promise<void>;
  test(args: string[]): void | Promise<void>;
  setup(args: string[]): void | Promise<void>;
}

const realActions: TaskActions = {
  format: runFormat,
  lint: runLint,
  typecheck: runTypecheck,
  test: runTest,
  setup: () => runSetup(),
};

/**
 * The task list, in the order `--help` should present it: the two everyday
 * checks, the two heavier ones, then the housekeeping.
 *
 * Each description is also the `#MISE description=` a forwarder carries, so
 * `mise tasks` and `cli.ts --help` agree.
 */
const TASKS: ReadonlyArray<readonly [keyof TaskActions, string]> = [
  ["format", "Format every file in the repo, without staging the changes"],
  ["lint", "Report every formatter and linter finding"],
  ["typecheck", "Type-check the whole workspace"],
  ["test", "Run the test suite"],
  ["setup", "Install the toolchain and dependencies"],
];

/**
 * Assembles the commander tree.
 *
 * Every subcommand takes a variadic `[args...]` and sets `allowUnknownOption()`
 * plus `passThroughOptions()`, so a flag meant for the underlying tool — `--bail`
 * for `bun test`, `--pretty` for `tsc` — is forwarded rather than rejected by
 * commander as unknown. `enablePositionalOptions()` on the parent is what makes
 * that pass-through legal: without it commander keeps claiming options after the
 * subcommand name.
 *
 * @param overrides - Actions replacing the real ones, for tests.
 * @returns The configured program, not yet parsed.
 */
export function buildProgram(overrides: Partial<TaskActions> = {}): Command {
  const actions: TaskActions = { ...realActions, ...overrides };

  const program = new Command()
    .name("tasks")
    .description("Developer tasks for this repo, invoked as `mise run <task>`.")
    .enablePositionalOptions();

  for (const [name, description] of TASKS) {
    program
      .command(name)
      .description(description)
      .argument("[args...]", "arguments forwarded verbatim to the underlying tool")
      .allowUnknownOption()
      .passThroughOptions()
      .action((args: string[]) => actions[name](args));
  }

  return program;
}

// Guarded so importing this module from a test does not parse the test runner's
// own argv.
if (import.meta.main) {
  await buildProgram().parseAsync(Bun.argv.slice(2), { from: "user" });
}
