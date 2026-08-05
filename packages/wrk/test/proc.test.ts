/**
 * Contract of the subprocess helper every other module builds on.
 *
 * The guarantee under test that is invisible from `run`'s signature: a nonzero exit is a
 * value, not an exception. `git rev-parse --verify` exits 128 to say "no such ref" and
 * `gh pr view` exits 1 to say "no PR here", so a helper that rejected on nonzero exit
 * would push every caller into a `try`/`catch` that digs the exit code back out of a
 * thrown object.
 *
 * Every case spawns `process.execPath` rather than a binary at a fixed path, so the suite
 * assumes nothing about `/bin` layout or about which runtime is executing it.
 */

import { describe, expect, test } from "bun:test";

import { run } from "../src/proc";

/** A name no binary on `PATH` will ever have, used to force a spawn failure. */
const MISSING_BINARY = "wrk-definitely-not-a-real-binary-xyz";

describe("run", () => {
  test("resolves with the exit code instead of throwing when the command fails", async () => {
    const result = await run(process.execPath, ["-e", "process.exit(3)"]);

    expect(result.code).toBe(3);
  });

  test("captures stdout and stderr separately", async () => {
    const result = await run(process.execPath, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err')",
    ]);

    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.code).toBe(0);
  });

  test("passes arguments literally, without shell interpretation", async () => {
    // Reaching the child verbatim is the whole point: were this routed through a shell,
    // the substitution would run and the trailing `ls /` with it.
    const hostile = "$(echo pwned); ls /";

    const result = await run(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[process.argv.length - 1])",
      hostile,
    ]);

    expect(result.stdout).toBe(hostile);
  });

  test("runs the child in the cwd override", async () => {
    const result = await run(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
      cwd: import.meta.dir,
    });

    expect(result.stdout).toBe(import.meta.dir);
  });

  test("overlays env onto the inherited environment rather than replacing it", async () => {
    const result = await run(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify([process.env.WRK_PROBE, Boolean(process.env.PATH)]))",
      ],
      { env: { WRK_PROBE: "overlaid" } },
    );

    // Both halves matter: an implementation that *replaces* the environment still passes
    // an assertion that only checks the injected variable.
    expect(JSON.parse(result.stdout)).toEqual(["overlaid", true]);
  });

  test("kills a child that outlives its timeout and still resolves", async () => {
    const result = await run(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
      timeout: 300,
    });

    // 128 + SIGTERM(15) — the same convention a shell uses to report a signal kill in `$?`.
    expect(result.code).toBe(143);
  });

  test("rejects when the command cannot be spawned at all", async () => {
    // The boundary between information and error: an exit code means the command ran and
    // had something to say, whereas a missing binary leaves the caller nothing to act on.
    await expect(run(MISSING_BINARY, [])).rejects.toThrow();
  });
});
