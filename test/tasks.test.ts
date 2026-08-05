/**
 * Invariants of the task-running surface: the commander tree in `scripts/tasks/`
 * and the `.mise/tasks/` forwarders that reach it.
 *
 * Two distinct risks are covered. The parsing tests drive the *real* commander
 * tree with injected actions, so a flag that stops reaching its tool — the
 * failure mode `passThroughOptions` exists to prevent — fails here rather than
 * silently dropping `--bail` in someone's terminal. The structural test walks
 * the forwarders themselves, because a forwarder that skips the bootstrap
 * preamble works perfectly on a warm checkout and dies only on a fresh clone,
 * which is exactly where nobody is watching.
 */

import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { buildProgram } from "../scripts/tasks/cli";
import { formatCommand } from "../scripts/tasks/format";
import { lintCommand } from "../scripts/tasks/lint";
import { setupCommands } from "../scripts/tasks/setup";
import { testCommand } from "../scripts/tasks/test";
import { typecheckCommand } from "../scripts/tasks/typecheck";

const repoRoot = join(import.meta.dir, "..");
const taskDir = join(repoRoot, ".mise", "tasks");

/**
 * Parses `argv` through the real commander tree, recording what the named task
 * would have run instead of spawning it.
 */
async function capture(argv: string[]): Promise<{ task: string; args: string[] }> {
  const calls: Array<{ task: string; args: string[] }> = [];
  const record =
    (task: string) =>
    (args: string[]): void => {
      calls.push({ task, args });
    };

  const program = buildProgram({
    format: record("format"),
    lint: record("lint"),
    typecheck: record("typecheck"),
    test: record("test"),
    setup: record("setup"),
  });

  await program.parseAsync(argv, { from: "user" });

  expect(calls).toHaveLength(1);
  return calls[0] as { task: string; args: string[] };
}

describe("argv builders", () => {
  test("lint checks the whole repo through hk", () => {
    expect(lintCommand([])).toEqual(["hk", "check", "--all"]);
  });

  test("format fixes in place without staging what it touched", () => {
    // --no-stage matters: hk otherwise stages its own fixes, which silently
    // widens a commit the user was assembling by hand.
    expect(formatCommand([])).toEqual(["hk", "fix", "--all", "--no-stage"]);
  });

  test("typecheck runs the whole program through the workspace tsc", () => {
    expect(typecheckCommand([])).toEqual(["bun", "x", "tsc", "--noEmit", "-p", "tsconfig.json"]);
  });

  test("test runs bun's runner", () => {
    expect(testCommand([])).toEqual(["bun", "test"]);
  });

  test("setup installs the toolchain before the dependencies that need it", () => {
    expect(setupCommands()).toEqual([
      ["mise", "install"],
      ["bun", "install"],
    ]);
  });

  test("extra arguments land after the tool's own flags", () => {
    expect(testCommand(["test/tasks.test.ts"])).toEqual(["bun", "test", "test/tasks.test.ts"]);
    expect(typecheckCommand(["--pretty"])).toEqual([
      "bun",
      "x",
      "tsc",
      "--noEmit",
      "-p",
      "tsconfig.json",
      "--pretty",
    ]);
  });
});

describe("the commander tree", () => {
  test("each task name reaches its own action", async () => {
    for (const task of ["format", "lint", "typecheck", "test", "setup"]) {
      expect((await capture([task])).task).toBe(task);
    }
  });

  test("a positional argument is forwarded verbatim", async () => {
    expect((await capture(["test", "test/tasks.test.ts"])).args).toEqual(["test/tasks.test.ts"]);
  });

  test("an unknown flag is forwarded rather than rejected", async () => {
    // The whole point of allowUnknownOption + passThroughOptions: commander must
    // not try to own `--bail`, which belongs to `bun test`.
    expect((await capture(["test", "--bail"])).args).toEqual(["--bail"]);
  });

  test("a flag that collides with commander's own is still forwarded", async () => {
    // `-p` is commander-shaped and tsc-meaningful. If passThroughOptions ever
    // regresses, this is the case that breaks first.
    expect((await capture(["typecheck", "--pretty", "false"])).args).toEqual(["--pretty", "false"]);
  });
});

describe(".mise/tasks forwarders", () => {
  /** Every file under `.mise/tasks`, recursively — mise namespaces subdirectories. */
  async function forwarders(): Promise<string[]> {
    const entries = await readdir(taskDir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
  }

  test("there is a forwarder for every task the CLI defines", async () => {
    const names = (await forwarders()).map((path) => basename(path)).sort();

    expect(names).toEqual(["format", "lint", "setup", "test", "typecheck"]);
  });

  test("every forwarder sources the bootstrap guard before exec'ing the CLI", async () => {
    for (const path of await forwarders()) {
      const lines = (await Bun.file(path).text()).split("\n");

      // Matched on the statement itself, not on a mention of the path — the
      // `# shellcheck source=` directive above it names the same file.
      const sourceLine = lines.findIndex((line) => line.startsWith("source "));
      const execLine = lines.findIndex((line) => line.startsWith("exec "));

      expect(sourceLine).toBeGreaterThanOrEqual(0);
      expect(execLine).toBeGreaterThanOrEqual(0);
      // Sourcing after the exec would never run: exec replaces the process.
      expect(sourceLine).toBeLessThan(execLine);
      expect(lines[sourceLine]).toContain("scripts/bootstrap.sh");
      // The guard returns nonzero on a failed install; without this the task
      // would carry on and die on an unresolvable import instead.
      expect(lines[sourceLine]).toContain("|| exit 1");
    }
  });

  test("every forwarder declares its description and takes raw args", async () => {
    for (const path of await forwarders()) {
      const text = await Bun.file(path).text();

      expect(text).toContain("#MISE description=");
      // Without raw_args, mise answers `--help` itself and the CLI never sees it.
      expect(text).toContain("#MISE raw_args=true");
    }
  });

  test("every forwarder execs the CLI with its own filename as the subcommand", async () => {
    for (const path of await forwarders()) {
      const text = await Bun.file(path).text();

      expect(text).toContain(`exec bun scripts/tasks/cli.ts ${basename(path)} "$@"`);
    }
  });

  test("every forwarder is executable", async () => {
    for (const path of await forwarders()) {
      const { mode } = await Bun.file(path).stat();

      expect(mode & 0o111).toBeGreaterThan(0);
    }
  });
});
