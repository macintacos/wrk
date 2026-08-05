/**
 * The output contract, pinned.
 *
 * Everything here is a promise made to code nobody in this repository controls: ten-plus
 * skill files across two agent trees parse this tool's stdout with `jq` and branch on the
 * fields they find. So the cases that look pedantic are the ones that matter — a dropped
 * key, a progress line on the wrong stream, or a blocking verdict that exits nonzero each
 * break a caller silently rather than loudly.
 *
 * The channel and exit-code cases run in a **child process** rather than against spies.
 * Both properties are properties of a real process — which stream a byte landed on, and
 * what status the runtime reported — so a spy would pin the call rather than the outcome.
 * It also keeps the suite's own output pristine: a `reportFailure` case asserted in
 * process would print its message into the test run.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { CommandFailed, envelope, Refusal, reportFailure } from "../src/output";
import { type RunResult, run } from "../src/proc";

/** Absolute, so the child resolves the module regardless of where the suite was started. */
const OUTPUT_MODULE = join(import.meta.dir, "../src/output");

/** Runs `script` in a child with the output module bound to `output`. */
function inChild(script: string): Promise<RunResult> {
  return run(process.execPath, [
    "-e",
    `import * as output from ${JSON.stringify(OUTPUT_MODULE)};\n${script}`,
  ]);
}

describe("envelope", () => {
  test("fills an absent value with null rather than dropping its key", () => {
    // The whole guarantee: `JSON.stringify` omits an `undefined`-valued key outright, so a
    // caller reading `.reason` unconditionally would get `null` from jq on a key that is
    // absent and `null` on one that is present — but only the second is true of every run.
    const text = envelope({ verdict: "proceed", reason: undefined });

    expect(JSON.parse(text)).toEqual({ verdict: "proceed", reason: null });
    expect(text).toContain('"reason"');
  });

  test("keeps false, zero and the empty string as themselves", () => {
    // The case a `value || null` fill gets wrong while every null-versus-undefined test
    // above stays green.
    expect(JSON.parse(envelope({ dirty: false, ahead: 0, note: "" }))).toEqual({
      dirty: false,
      ahead: 0,
      note: "",
    });
  });

  test("fills an absent value nested inside the payload", () => {
    expect(JSON.parse(envelope({ repo: { root: "/tmp/x", branch: undefined } }))).toEqual({
      repo: { root: "/tmp/x", branch: null },
    });
  });

  test("emits the payload's keys in the order it declares them", () => {
    const text = envelope({ verdict: "blocked", reason: "dirty-checkout", repo_root: "/tmp/x" });

    expect(Object.keys(JSON.parse(text) as object)).toEqual(["verdict", "reason", "repo_root"]);
  });

  test("indents so a human reading a captured run can follow it", () => {
    expect(envelope({ verdict: "proceed" })).toBe('{\n  "verdict": "proceed"\n}');
  });
});

describe("the two channels", () => {
  test("stdout carries the envelope alone, with progress on stderr", async () => {
    const result = await inChild(
      'output.note("cloning"); output.emit({ verdict: "blocked", reason: null });',
    );

    // Parsed rather than matched: stdout has to be a whole JSON document by itself, which
    // is what every consumer's `jq` assumes and what a stray progress line would break.
    expect(JSON.parse(result.stdout)).toEqual({ verdict: "blocked", reason: null });
    expect(result.stderr).toBe("cloning\n");
  });

  test("a blocking verdict is still a successful run", async () => {
    // The rule every caller depends on: they branch on the verdict field, never on the
    // exit status, so a well-formed refusal to proceed must not look like a failure.
    const result = await inChild('output.emit({ verdict: "blocked", reason: "container-cwd" });');

    expect(result.code).toBe(0);
  });
});

describe("reportFailure", () => {
  test("answers 1 for a refusal, on stderr, with no stack and nothing on stdout", async () => {
    const result = await inChild(
      'process.exitCode = output.reportFailure(new output.Refusal("cwd is not empty"));',
    );

    expect(result.code).toBe(1);
    // Exact, which is what pins "no stack trace": a thrown-and-printed Error would carry
    // `at <frame>` lines after the message.
    expect(result.stderr).toBe("wrk: cwd is not empty\n");
    expect(result.stdout).toBe("");
  });

  test("answers the underlying command's own exit status, and names what it said", async () => {
    const result = await inChild(
      "process.exitCode = output.reportFailure(" +
        'new output.CommandFailed(["git", "rev-parse", "--git-dir"], 128, "fatal: not a repository\\n"));',
    );

    expect(result.code).toBe(128);
    expect(result.stderr).toContain("git rev-parse --git-dir");
    expect(result.stderr).toContain("fatal: not a repository");
    expect(result.stdout).toBe("");
  });

  test("still answers 1 when the failed command somehow exited 0", async () => {
    // `git worktree add` failing with status 0 is not a thing that happens, but an exit
    // code of 0 here would report a failed run as a successful one — the one outcome this
    // module exists to prevent.
    const result = await inChild(
      'process.exitCode = output.reportFailure(new output.CommandFailed(["git", "status"], 0, ""));',
    );

    expect(result.code).toBe(1);
  });

  test("rethrows anything else, before writing a word", () => {
    // An unexpected error is a bug in wrk, and its stack is the only useful thing about
    // it. Laundering it into a tidy one-line message and an exit code would hide that.
    expect(() => reportFailure(new Error("boom"))).toThrow("boom");
  });
});

describe("Refusal and CommandFailed", () => {
  test("a refusal carries only the sentence a user has to read", () => {
    expect(new Refusal("cwd is not empty").message).toBe("cwd is not empty");
  });

  test("a failed command names itself, its status and what it said", () => {
    const failure = new CommandFailed(["git", "status"], 128, "fatal: not a repository\n");

    expect(failure.message).toContain("git status");
    expect(failure.message).toContain("128");
    expect(failure.message).toContain("fatal: not a repository");
    expect(failure.code).toBe(128);
  });
});
