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
import { chmod, copyFile, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { buildProgram } from "../scripts/tasks/cli";
import { formatCommand } from "../scripts/tasks/format";
import { runForward } from "../scripts/tasks/lib/exec";
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

  test("a flag commander owns is forwarded once a positional has been seen", async () => {
    // The one case that actually discriminates passThroughOptions: allowUnknownOption
    // alone already forwards flags commander does not know, so only a flag it *does*
    // own — `--help` — can tell the two settings apart. Without passThroughOptions
    // commander prints its own help here and never calls the action.
    expect((await capture(["test", "foo.test.ts", "--help"])).args).toEqual([
      "foo.test.ts",
      "--help",
    ]);
  });
});

describe("forwarding a tool's outcome", () => {
  test("runForward resolves the child's exit code", async () => {
    expect(await runForward([process.execPath, "-e", "process.exit(3)"])).toBe(3);
    expect(await runForward([process.execPath, "-e", "process.exit(0)"])).toBe(0);
  });

  test("execAndExit stops at the first failure and exits with its code", async () => {
    // Run in a child because execAndExit ends the process it runs in. The second
    // command writes a marker; if sequencing regresses to run-everything, the
    // marker appears and this fails.
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        'import { execAndExit } from "./scripts/tasks/lib/exec";' +
          `await execAndExit([["${process.execPath}", "-e", "process.exit(3)"],` +
          ` ["${process.execPath}", "-e", "console.log('SECOND')"]]);`,
      ],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
    );

    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);

    expect(code).toBe(3);
    expect(stdout).not.toContain("SECOND");
  });
});

describe("the bootstrap guard", () => {
  /**
   * Runs the real `scripts/bootstrap.sh` against stub tools on a scrubbed PATH.
   *
   * The guard's whole purpose is a checkout where the toolchain is absent, which
   * is unreproducible in this repo — so the tools are stubs and PATH is emptied
   * of everything else. Sourced exactly as a forwarder sources it, `|| exit 1`
   * included, since that is what disables errexit inside the file.
   */
  async function runGuard(stubs: Record<string, string>): Promise<{ code: number; out: string }> {
    const dir = await mkdtemp(join(tmpdir(), "wrk-guard-"));
    const bin = join(dir, "bin");
    await mkdir(join(dir, "repo", "scripts"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await copyFile(
      join(repoRoot, "scripts", "bootstrap.sh"),
      join(dir, "repo/scripts/bootstrap.sh"),
    );

    for (const [name, body] of Object.entries(stubs)) {
      await writeFile(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
      await chmod(join(bin, name), 0o755);
    }

    const child = Bun.spawn(
      [
        "bash",
        "-c",
        // `command -v bun` afterwards proves the PATH repair reached the caller,
        // which is what the forwarder's own `exec bun` depends on.
        'source repo/scripts/bootstrap.sh || exit 1; echo "GUARD_OK"; command -v bun >/dev/null && echo "BUN_ON_PATH"',
      ],
      {
        cwd: dir,
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    return { code, out: stdout + stderr };
  }

  test("a cold checkout is installed, and the repaired PATH reaches the caller", async () => {
    const result = await runGuard({
      // `bun` exists only inside the directory mise reports, so it is reachable
      // afterwards only if the guard actually prepended that directory to PATH.
      mise: 'if [[ $1 == "bin-paths" ]]; then echo "$HOME/toolbin"; else mkdir -p "$HOME/toolbin"; printf "#!/usr/bin/env bash\\nmkdir -p node_modules\\n" > "$HOME/toolbin/bun"; chmod +x "$HOME/toolbin/bun"; fi',
    });

    expect(result.out).toContain("GUARD_OK");
    expect(result.out).toContain("BUN_ON_PATH");
    expect(result.code).toBe(0);
  });

  test("a missing mise fails loudly instead of dying later on an import", async () => {
    const result = await runGuard({});

    expect(result.code).toBe(1);
    expect(result.out).toContain("mise is not installed");
    expect(result.out).not.toContain("GUARD_OK");
  });

  test("a failed install stops the task rather than reporting success", async () => {
    // The errexit trap the header warns about: sourced under `||`, a bare failing
    // command would be ignored. This fails unless the `|| return 1` is present.
    const result = await runGuard({ mise: "exit 1" });

    expect(result.code).toBe(1);
    expect(result.out).not.toContain("GUARD_OK");
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
    // Compared against the real tree rather than a literal, so this holds in both
    // directions as tasks come and go. Building the program spawns nothing.
    const defined = buildProgram()
      .commands.map((command) => command.name())
      .sort();

    expect(names).toEqual(defined);
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
