/**
 * The four ways Ink surprises a picker, each pinned so it surprises nobody twice.
 *
 * Companion to [`./inline-rendering.test.ts`](./inline-rendering.test.ts), which settles
 * the substrate question itself. These four are the sharp edges found on the way, and each
 * one is here rather than in a document because a document does not fail.
 *
 * **1. `useInput` throws on non-TTY stdin, and the obvious guard does not stop it.** Raw
 * mode is a TTY capability, so Ink raises `Raw mode is not supported…` the moment a picker
 * is run with its stdin piped. The documented guard is `useStdin().isRawModeSupported` —
 * but that value is `stdin.isTTY`, which Node leaves **`undefined`** on a pipe rather than
 * `false`, while Ink's own opt-out is the strict `options.isActive === false`. So
 * `useInput(fn, { isActive: isRawModeSupported })` type-checks (the field is declared
 * `boolean`), reads as a guard, and crashes in the place it was written to protect.
 * `Boolean(isRawModeSupported)` is what makes it hold, and the two are asserted separately
 * below so the distinction cannot be lost.
 *
 * **The coercion is necessary but not sufficient, and EXC-1011 must not stop there.** It
 * turns the crash into an `isActive: false` — a picker that renders, accepts no key, and
 * waits forever. Silence is not better than a crash. Whatever the picker does about piped
 * stdin, it has to be a *decision*: refuse with a clear message, fall back to a
 * non-interactive path, or open `/dev/tty` for input while stdin carries data. This file
 * settles that the guard is needed and how to write one that works; it does not settle
 * which of those three the picker should choose.
 *
 * **2. `NO_COLOR` does nothing; `FORCE_COLOR=0` works.** Ink colours through chalk, and
 * under Bun a run with `NO_COLOR=1` in a terminal still emits SGR sequences. A picker that
 * means to honour [no-color.org](https://no-color.org) has to read the variable itself and
 * turn its own styling off — inheriting the convention from the library is not an option on
 * this runtime.
 *
 * **3. A fixed-width child wraps rather than clips, and `wrap="truncate"` is the setting
 * that stops it.** Measured at width 20 with a 57-character label, in a pty:
 *
 * | `flexShrink={0}` | `wrap="truncate"` | Rows |
 * | --- | --- | --- |
 * | no | no | 3 |
 * | yes | no | 3 |
 * | no | yes | 1 |
 * | yes | yes | 1 |
 *
 * So the pair is not a pair: `wrap="truncate"` does the clipping and `flexShrink={0}` alone
 * changes nothing at this shape. (It still earns its place on a real picker row, where the
 * column competes with siblings for width — but it is not what keeps the row one row tall,
 * and a row that relies on it for that will wrap.) This is a height-budget bug, not a
 * cosmetic one: the picker's whole safety margin is staying strictly under the viewport
 * (see `inline-rendering.test.ts`), and a row that grows under some input is how a frame
 * crosses that line on someone else's terminal and in nobody's tests.
 *
 * **4. Bundling Ink fails on a dependency the runtime never loads.** `reconciler.js`
 * reaches its devtools through `await import('./devtools.js')` behind an
 * `import.meta.resolve` probe in a try/catch, so at runtime the branch is simply not taken.
 * A bundler follows the dynamic import statically anyway and dies on `devtools.js`'s
 * `react-devtools-core` import. `--external react-devtools-core` clears it without adding a
 * React devtools package to a CLI's dependency tree — for EXC-986 and EXC-1014, which are
 * the issues that will actually ship a bundle. Only that one module needs excluding: `ws`,
 * the other import in `devtools.js`, is a real dependency of Ink and resolves.
 *
 * @packageDocumentation
 */

import { describe, expect, test } from "bun:test";

import { frameHeight, hasColour, runInPty } from "./fixtures/pty";

/** A probe invocation, with the given environment prefixed and the given shell suffix. */
function probe(env: string, suffix = ""): string {
  return `${env} "${process.execPath}" "${import.meta.dir}/fixtures/inline-probe.tsx" ${suffix}`;
}

describe("useInput throws when stdin is not a TTY", () => {
  test("unguarded, the probe dies on piped stdin", async () => {
    const { capture, exitCode } = await runInPty(
      probe("PROBE_MODE=input-unguarded", "< /dev/null"),
      { rows: 24 },
    );

    expect(exitCode).not.toBe(0);
    expect(capture).toContain("Raw mode is not supported");
  });

  test("the obvious guard does not help, because isTTY is undefined and not false", async () => {
    // The finding. `isRawModeSupported` is typed `boolean` and is really `stdin.isTTY`,
    // which Node leaves `undefined` on a pipe; Ink's own opt-out is
    // `options.isActive === false`, strict. So the guard compiles, reads right, and
    // crashes in exactly the place it was written to protect.
    const { capture, exitCode } = await runInPty(
      probe("PROBE_MODE=input-guard-uncoerced", "< /dev/null"),
      { rows: 24 },
    );

    expect(exitCode).not.toBe(0);
    expect(capture).toContain("Raw mode is not supported");
  });

  test("coercing it to a real boolean is what makes the guard hold", async () => {
    const { capture, exitCode } = await runInPty(probe("PROBE_MODE=input-guarded", "< /dev/null"), {
      rows: 24,
    });

    expect(exitCode).toBe(0);
    // Surviving is not the claim — rendering is. Without this the test would pass on a
    // picker that guarded itself by never drawing anything.
    expect(capture).toContain("item 0");
  });
});

describe("colour is switched off by FORCE_COLOR, not by NO_COLOR", () => {
  test("a plain run in a terminal is coloured", async () => {
    const { capture } = await runInPty(probe("PROBE_ROWS=5"), { rows: 24 });

    expect(hasColour(capture)).toBe(true);
  });

  test("NO_COLOR does not reach chalk under Bun", async () => {
    const { capture } = await runInPty(probe("PROBE_ROWS=5 NO_COLOR=1"), { rows: 24 });

    expect(hasColour(capture)).toBe(true);
  });

  test("FORCE_COLOR=0 does", async () => {
    const { capture } = await runInPty(probe("PROBE_ROWS=5 FORCE_COLOR=0"), { rows: 24 });

    expect(hasColour(capture)).toBe(false);
  });
});

describe("a fixed-width child wraps unless the text is told to truncate", () => {
  /** Rows the fixed-width scenario occupies under the given settings. */
  async function rows(settings: string): Promise<number> {
    const { capture } = await runInPty(probe(`PROBE_MODE=fixed-width ${settings}`), { rows: 24 });

    return frameHeight(capture);
  }

  test("by default the overflowing label costs extra rows", async () => {
    expect(await rows("")).toBe(3);
  });

  test("no-shrink alone changes nothing", async () => {
    // The half of the remedy that does not do the work. Asserted so nobody reaches for it
    // on its own and concludes the row is now a fixed height.
    expect(await rows("PROBE_SHRINK=1")).toBe(3);
  });

  test("truncate alone is what clips", async () => {
    expect(await rows("PROBE_TRUNCATE=1")).toBe(1);
  });

  test("and the two together behave as truncate alone", async () => {
    expect(await rows("PROBE_SHRINK=1 PROBE_TRUNCATE=1")).toBe(1);
  });
});

describe("bundling Ink pulls in a devtools dependency nobody installed", () => {
  /**
   * Bundles the probe, optionally excluding modules, and answers what the build did.
   *
   * `--target=node` because that is what the published artifact is — `packages/wrk`'s
   * output module says so, and Bun's default target is `browser`, which fails over
   * unrelated built-ins and would make this finding unreadable. `--outfile=/dev/null`
   * because only the exit status is being measured; nothing here wants the bundle.
   */
  async function build(...external: string[]): Promise<{ exitCode: number; stderr: string }> {
    const proc = Bun.spawn(
      [
        process.execPath,
        "build",
        "--target=node",
        ...external.flatMap((name) => ["--external", name]),
        "--outfile=/dev/null",
        `${import.meta.dir}/fixtures/inline-probe.tsx`,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );

    return { exitCode: await proc.exited, stderr: await new Response(proc.stderr).text() };
  }

  test("a plain bundle fails on a module the runtime never loads", async () => {
    // `ink/build/reconciler.js` reaches devtools through `await import('./devtools.js')`,
    // behind an `import.meta.resolve` probe in a try/catch — so at runtime the branch is
    // never taken when the package is absent. A bundler cannot see that guard: it follows
    // the dynamic import statically, lands in `devtools.js`, and fails on the
    // `react-devtools-core` import there. Nothing in the picker's own code is involved.
    const { exitCode, stderr } = await build();

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("react-devtools-core");
  });

  test("marking it external is enough — the dependency need not be installed", async () => {
    // The remedy for EXC-986 and EXC-1014, and the cheaper of the two the issue named: the
    // alternative is adding a React devtools package to a CLI's dependency tree to satisfy
    // a code path it will never run.
    const { exitCode } = await build("react-devtools-core");

    expect(exitCode).toBe(0);
  });
});
