/**
 * The `wrk` program root: the one commander tree every command hangs off.
 *
 * This module owns three things and deliberately nothing else — the program's identity,
 * the global `--json` flag, and the top-level failure handler that turns a thrown value
 * into an exit status. Commands are registered by the issues that build them, and each is
 * wired here rather than exported as a builder from its own module: the work a command does
 * lives in a module of its own, but the handful of lines that name it, describe it and pick
 * its output channel are the tree's business, and one command per module does not earn an
 * indirection to say so.
 *
 * It follows [`scripts/tasks/cli.ts`](../../../scripts/tasks/cli.ts), this repository's
 * existing commander tree, in the ways that matter: `@commander-js/extra-typings`, a
 * `buildProgram()` factory returning an unparsed tree so tests drive the real thing, and
 * an `import.meta.main` guard so importing this module from a test does not parse the test
 * runner's own argv. One divergence, and only one: that tree sets
 * `enablePositionalOptions()` and `passThroughOptions()` because its job is to forward
 * unknown flags on to another tool, and `wrk` owns its own flags, so neither is carried
 * over — an unknown flag here is a mistake worth rejecting.
 *
 * The contract this program's output obeys lives in [`./output`](./output), whose header
 * is the specification; this module is only where the flag is declared and where the exit
 * rules are applied.
 *
 * @packageDocumentation
 */

import { Command } from "@commander-js/extra-typings";

import { renderConversion, resolveConversion } from "./convert";
import { Refusal } from "./errors";
import { emit, emitLine, note, reportFailure } from "./output";
import { preflight } from "./preflight";
import { repoSetup } from "./setup";
import { createWorktree } from "./worktree";

/**
 * Assembles the commander tree.
 *
 * `repo convert` **prints and never runs** the conversion recipe: its first step renames the
 * checkout the caller is standing in, so executing it under them is the one thing the
 * command must not do. See [`./convert`](./convert)'s header.
 *
 * Its human output goes to stderr through {@link note}, not to stdout. That is
 * [`./output`](./output)'s rule rather than a preference — `emit` owns stdout so that a
 * run's stdout is one JSON document, and the only stdout this program allows past it are
 * commander's own `--help` and an interactive component's escape sequences, neither of which
 * a printed recipe is. `--json` is what puts the same answer on the envelope instead.
 *
 * `agent preflight` takes the opposite side of that flag and never consults it: its only
 * output is the envelope, because every one of its callers is a script that parses it. See
 * [`./preflight`](./preflight)'s header for the contract, including why a blocking verdict
 * still exits `0`.
 *
 * `agent create` never consults {@link wantsJson} either, for the same reason, and is
 * additionally the reason `emitLine` exists. `--hook` is not a human-output mode returning
 * through the back door: it is a *second machine* shape, for the editor's `WorktreeCreate`
 * hook, whose consumer is a `cd` rather than a parser. Which of the two it writes is the
 * only thing that flag decides.
 *
 * `--branch` is a `requiredOption` rather than validated in the action, which puts its
 * absence on the route this module's own `main` documents as already correct: commander
 * writes its message to stderr and exits `1` itself, before the action runs and therefore
 * before anything could have reached stdout.
 *
 * @returns The configured program, not yet parsed.
 */
export function buildProgram(): Command {
  const program = new Command()
    .name("wrk")
    .description("Worktree, PR-stack and agent-workflow tooling.")
    .option("--json", "Emit machine-readable JSON on stdout instead of human output");

  program
    .command("repo")
    .description("Operations on the repository as a whole.")
    .command("convert")
    .description("Print the recipe for converting this repository to the bare-repo layout")
    .action(async (_options, command) => {
      const conversion = await resolveConversion();
      if (conversion === null) {
        throw new Refusal(
          "not a git repository; run this from inside the repository you want to convert",
        );
      }

      const recipe = renderConversion(conversion);
      // Spread rather than a rebuilt literal: `envelope` inherits key order from the payload's
      // own insertion order, and `Conversion` is built as one literal, so this preserves it.
      if (wantsJson(command)) emit({ ...conversion, recipe });
      else note(recipe);
    });

  // Bound rather than chained straight into a subcommand: `.command()` answers the *sub*
  // command it just made, so chaining would leave no handle for the second one, and a
  // second `program.command("agent")` throws rather than reopening the group.
  const agent = program
    .command("agent")
    .description("Deterministic git mechanics for an agent's Setup Worktree phase.");

  agent
    .command("repo-setup")
    .description("Clone a repository into a bare-repo container in the current directory")
    .argument("<url>", "What to clone, in any form git clone accepts")
    .action(async (url: string) => {
      emit(await repoSetup(process.cwd(), url));
    });

  agent
    .command("preflight")
    .description("Run the Setup Worktree checks and print the verdict as JSON")
    .requiredOption("--issue <id>", "The run's primary issue identifier, e.g. EXC-997")
    .option("--base <branch>", "What the worktree will be based on; skips the default-branch sync")
    .action(async (options) => {
      emit(await preflight(options.issue, process.cwd(), { base: options.base }));
    });

  agent
    .command("create")
    .description("Create a worktree and the branch that goes with it")
    .requiredOption("--branch <name>", "The new branch; its folded form names the directory")
    .option("--base <commit-ish>", "What to branch from; defaults to the default branch")
    .option("--hook", "Print the worktree path alone, for the WorktreeCreate hook")
    .action(async ({ branch, base, hook }) => {
      const created = await createWorktree(process.cwd(), { branch, base });
      if (hook === true) emitLine(created.worktree_path);
      else emit(created);
    });

  return program;
}

/**
 * Whether this invocation asked for the JSON envelope.
 *
 * Read through `optsWithGlobals` rather than `opts`, which is the whole reason this is a
 * function: `--json` is declared on the root, and a subcommand's own `opts()` does not see
 * an option it did not declare. Passing the *running* command — the one commander hands a
 * subcommand's action as its last argument — is what makes the flag global in fact.
 *
 * Commands whose only output is the envelope ignore this: the agent-facing surface is JSON
 * unconditionally, because its callers parse it unconditionally. The flag is what puts a
 * command that would otherwise print for a human onto the same envelope.
 *
 * The parameter is the one method this needs rather than `Command` itself, and
 * deliberately so. `extra-typings` threads each command's options through the class's type
 * parameters, so a `Command` written without them resolves `optsWithGlobals()` to `{}` and
 * this would not compile — while spelling them out here would pin every future caller to
 * one exact instantiation. Naming the method is both looser and more honest: what this
 * asks of its argument is that it can report its merged options.
 *
 * @param command - The command whose invocation is being asked about.
 * @returns `true` when `--json` appeared anywhere in argv — before the subcommand name or
 *   after its arguments alike, which is the consequence of the header's decision not to
 *   enable positional options.
 *
 * @example
 * ```ts
 * program.command("doctor").action((_options, command) => {
 *   if (wantsJson(command)) emit(report);
 *   else note(render(report));
 * });
 * ```
 */
export function wantsJson(command: { optsWithGlobals(): { json?: unknown } }): boolean {
  return command.optsWithGlobals().json === true;
}

/**
 * Parses `argv` and maps any failure that reaches the top to an exit status.
 *
 * `process.exitCode` is assigned rather than `process.exit` called, for the reason
 * [`./output`](./output)'s header gives: stdout is a pipe on every agent-facing
 * invocation, and `process.exit` would discard the envelope still in flight.
 *
 * `program` is a parameter so a test can drive the real tree with a probe command
 * attached, the same seam `scripts/tasks/cli.ts` opens by injecting its actions.
 *
 * One failure route bypasses this: commander answers a malformed argv itself, printing its
 * own message and calling `process.exit(1)` without ever reaching the `catch`. That is
 * left alone rather than intercepted with `exitOverride`, because it lands on the right
 * side of both rules anyway — the message goes to stderr, and nothing has been written to
 * stdout yet, so there is no envelope in flight for the abrupt exit to truncate.
 *
 * @param argv - Arguments after the program name.
 * @param program - The tree to parse with. Defaults to {@link buildProgram}'s.
 * @throws Whatever {@link reportFailure} declines to map — an unexpected error is a bug in
 *   `wrk`, and the runtime's own report of it is the useful one.
 */
export async function main(argv: string[], program: Command = buildProgram()): Promise<void> {
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    process.exitCode = reportFailure(error);
  }
}

// Guarded so importing this module from a test does not parse the test runner's own argv.
if (import.meta.main) {
  await main(process.argv.slice(2));
}
