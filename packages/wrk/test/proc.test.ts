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
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detach, run } from "../src/proc";

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

    // Both sides go through realpath: the child's `process.cwd()` has resolved symlinks
    // and `import.meta.dir` has not, so a checkout under a symlinked prefix — `/tmp` on
    // macOS — would fail a literal comparison for no good reason.
    expect(realpathSync(result.stdout)).toBe(realpathSync(import.meta.dir));
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

  test("unsets an inherited variable given an undefined overlay value", async () => {
    // The other half of an honest overlay: shedding an inherited `GIT_DIR` needs removal,
    // not just addition. `PATH` stands in for it here — the child is spawned by absolute
    // path, so dropping `PATH` costs the test nothing.
    const result = await run(
      process.execPath,
      ["-e", "process.stdout.write(String(process.env.PATH))"],
      { env: { PATH: undefined } },
    );

    expect(result.stdout).toBe("undefined");
  });

  test("kills a child that outlives its timeout and still resolves", async () => {
    const result = await run(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
      timeout: 300,
    });

    // 128 + SIGTERM(15) — the same convention a shell uses to report a signal kill in `$?`.
    expect(result.code).toBe(143);
  });

  test("captures large multibyte output written right up to exit", async () => {
    // Pins `setEncoding("utf8")`: output large enough to span chunks puts a multibyte
    // character on a boundary, which per-chunk `toString()` would mojibake. Every other
    // test in this file writes a few bytes and stays green through that regression.
    //
    // It does not pin `close`-rather-than-`exit`; swapping those still passes, because the
    // parent has already buffered this much by the time `exit` fires. Catching that needs a
    // deliberate race, which is a flaky test, so the reasoning lives in `proc.ts` instead.
    const expected = "é😀".repeat(60_000);
    const result = await run(process.execPath, [
      "-e",
      'process.stdout.write("é😀".repeat(60_000)); process.exit(7)',
    ]);

    expect(result.stdout).toBe(expected);
    expect(result.code).toBe(7);
  });

  test("rejects when the command cannot be spawned at all", async () => {
    // The boundary between information and error: an exit code means the command ran and
    // had something to say, whereas a missing binary leaves the caller nothing to act on.
    await expect(run("wrk-definitely-not-a-real-binary-xyz", [])).rejects.toThrow();
  });
});

describe("detach", () => {
  test("returns before the child does, and the child finishes anyway", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrk-detach-"));
    const marker = join(directory, "done");

    const pid = detach(process.execPath, [
      "-e",
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, ""), 300)`,
    ]);

    // Both halves of "detached" in one pair of assertions: the call is already back while the
    // child is still working, and the child gets to finish regardless. Were `detach` awaiting
    // anything at all, the marker would already exist by the time this line ran.
    expect(pid).toBeGreaterThan(0);
    expect(existsSync(marker)).toBe(false);

    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await Bun.sleep(25);
    }

    expect(existsSync(marker)).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  }, 15_000);

  test("survives a command that cannot be spawned at all", async () => {
    // The case that would otherwise end the caller rather than the child: `spawn` reports a
    // failed start as an `error` event, and an `error` event with no listener is rethrown as an
    // uncaught exception. A background job nobody is waiting on must not be able to kill the
    // invocation that merely asked for one. The failure is asynchronous, so the tick below is
    // what gives it somewhere to land — without the listener, this suite dies here.
    expect(detach("wrk-definitely-not-a-real-binary-xyz", [])).toBeUndefined();

    await Bun.sleep(50);
  });
});
