/**
 * The program root: that `--json` is genuinely global, and that a failure reaching the top
 * becomes the right exit status.
 *
 * Both properties are exercised through a probe command this file registers on the real
 * `buildProgram()` output. That is the point rather than a workaround: a flag declared on
 * the root has to be readable from a *subcommand's* action, which is the one thing testing
 * the root's own options would not prove.
 *
 * The exit-status cases run in a child process. `main` assigns `process.exitCode`, so
 * asserting it in process would leave the test runner itself exiting nonzero, and the
 * message it writes would land in the suite's own output.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { buildProgram, wantsJson } from "../src/cli";
import { type RunResult, run } from "../src/proc";

const CLI_MODULE = join(import.meta.dir, "../src/cli");
const OUTPUT_MODULE = join(import.meta.dir, "../src/output");

/**
 * Runs the real program in a child, with one probe command whose action is `body`.
 *
 * `body` is source rather than a function, because the child needs its own instance of
 * whichever error class it throws, from its own import of the module.
 */
function inChild(body: string): Promise<RunResult> {
  return run(process.execPath, [
    "-e",
    [
      `import { buildProgram, main } from ${JSON.stringify(CLI_MODULE)};`,
      `import * as output from ${JSON.stringify(OUTPUT_MODULE)};`,
      "const program = buildProgram();",
      `program.command("probe").action(() => { ${body} });`,
      'await main(["probe"], program);',
    ].join("\n"),
  ]);
}

/** The real program with a probe command that records how it saw the global flag. */
function withProbe(): { program: ReturnType<typeof buildProgram>; seen: boolean[] } {
  const program = buildProgram();
  const seen: boolean[] = [];

  program.command("probe").action((_options, command) => {
    seen.push(wantsJson(command));
  });

  return { program, seen };
}

describe("buildProgram", () => {
  test("is named for the binary it becomes", () => {
    expect(buildProgram().name()).toBe("wrk");
  });

  test("declares --json once, on the root", () => {
    const flags = buildProgram()
      .options.map((option) => option.long)
      .filter((long) => long === "--json");

    expect(flags).toEqual(["--json"]);
  });
});

describe("the global --json flag", () => {
  test("reaches a subcommand's action from before the subcommand name", async () => {
    // The whole claim of "global": it is declared on the root and read by a command that
    // never declares it. Without optsWithGlobals this is silently false.
    const { program, seen } = withProbe();

    await program.parseAsync(["--json", "probe"], { from: "user" });

    expect(seen).toEqual([true]);
  });

  test("reaches it from after the subcommand's own arguments too", async () => {
    // Not a second spelling of the case above: this one holds only because the root
    // declines commander's positional-options settings, which the module header calls out
    // as its one deliberate divergence from `scripts/tasks/cli.ts`. Adding either of them
    // would leave `--json` here unclaimed, and every case that puts the flag first green.
    const { program, seen } = withProbe();

    await program.parseAsync(["probe", "--json"], { from: "user" });

    expect(seen).toEqual([true]);
  });

  test("is off when it was not asked for", async () => {
    const { program, seen } = withProbe();

    await program.parseAsync(["probe"], { from: "user" });

    expect(seen).toEqual([false]);
  });
});

describe("main", () => {
  test("turns a refusal into exit 1 and one line on stderr", async () => {
    const result = await inChild('throw new output.Refusal("cwd is not empty");');

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("wrk: cwd is not empty\n");
    expect(result.stdout).toBe("");
  });

  test("inherits the exit status of a command that failed underneath it", async () => {
    const result = await inChild(
      'throw new output.CommandFailed(["git", "rev-parse"], 128, "fatal: not a repository");',
    );

    expect(result.code).toBe(128);
    expect(result.stdout).toBe("");
  });

  test("leaves a run that emitted a verdict at 0", async () => {
    // The case every caller actually hits. A `main` that set a nonzero status
    // unconditionally would still pass both cases above.
    const result = await inChild('output.emit({ verdict: "blocked", reason: "container-cwd" });');

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ verdict: "blocked", reason: "container-cwd" });
  });
});
