/**
 * What `wrk doctor` reports about the two tools `wrk` shells out to, and when it says no.
 *
 * Every case runs against **real executables on a fixture `PATH`** rather than a stubbed
 * `run`: `gh.test.ts` and `provision.test.ts` both do this, and the reason is the same here —
 * presence is detected by whether the spawn succeeds, so a fake that answered in-process would
 * be testing something other than the mechanism. `process.env.PATH` is set in-process because
 * `proc.ts`'s `run` reads `process.env` at call time, which is what lets the fakes reach the
 * real `doctor` with no injection seam added to production code for the tests' benefit.
 *
 * The versions asserted here are the fakes' own, never the machine's. A case that read the
 * real `git` would pass or fail depending on whose laptop it ran on, which is precisely the
 * question `doctor` exists to answer rather than to depend on.
 *
 * Fixture helpers are copied from `gh.test.ts` rather than lifted into a shared module,
 * following `provision.test.ts`'s note that sharing them is EXC-1003's scope.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DoctorReport, doctor, renderDoctor } from "../src/doctor";
import { type RunResult, run } from "../src/proc";

/** The CLI as an executable, for the cases that are about the process rather than the report. */
const CLI_ENTRY = join(import.meta.dir, "../src/cli.ts");

/** Temp roots to delete once the suite finishes. */
const roots: string[] = [];

/** A fresh temp directory, resolved through `realpathSync` as `provision.test.ts` resolves its own. */
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wrk-doctor-")));
  roots.push(dir);
  return dir;
}

/**
 * Quotes `text` as a single `sh` word.
 *
 * The fakes carry their banners inline because `PATH` is the fixture directory alone during a
 * case, so a fake that shelled out to `cat` would fail for a reason unrelated to `doctor`.
 */
function shQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** What one fake tool prints and how it exits. */
interface Fake {
  /** The `--version` banner it writes to stdout. */
  banner?: string;

  /** Its exit status. */
  exit?: number;
}

/**
 * A directory holding one fake per named tool, to be used as the whole of `PATH`.
 *
 * A tool left out of `tools` is a tool that is not installed — which is the whole of how the
 * absent cases are built, since `run` rejects on a spawn that finds nothing to start.
 */
function makeBin(tools: Record<string, Fake>): string {
  const bin = tempDir();

  for (const [name, fake] of Object.entries(tools)) {
    writeFileSync(
      join(bin, name),
      [
        "#!/bin/sh",
        `printf '%s\\n' ${shQuote(fake.banner ?? "")}`,
        `exit ${fake.exit ?? 0}`,
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, name), 0o755);
  }

  return bin;
}

/** A current `git` and a current `gh`, as each really spells its own banner. */
const HEALTHY = {
  git: { banner: "git version 2.51.0" },
  gh: {
    banner: "gh version 2.63.2 (2024-12-05)\nhttps://github.com/cli/cli/releases/tag/v2.63.2",
  },
} as const;

const originalPath = process.env.PATH;

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("doctor", () => {
  test("reports every tool, its version and the floor it is held to", async () => {
    // Whole-report equality rather than field probes: the envelope's key set and key order are
    // what callers read, so a case that checked `.ok` alone would not notice either changing.
    // `gh`'s banner is two lines with a version in each, which pins that the *first* is taken.
    process.env.PATH = makeBin(HEALTHY);

    expect(await doctor()).toEqual({
      ok: true,
      tools: [
        { name: "git", present: true, version: "2.51.0", minimum: "2.36", ok: true },
        { name: "gh", present: true, version: "2.63.2", minimum: null, ok: true },
      ],
    });
  });

  test("fails a git below the floor, while still reporting it as present", async () => {
    // The failure `doc/ADVANCED.md` calls silent, stable and wrong. Present but not ok is the
    // distinction the whole floor check exists to draw — "missing" would be the wrong report.
    process.env.PATH = makeBin({ ...HEALTHY, git: { banner: "git version 2.30.0" } });

    const report = await doctor();

    expect(report.ok).toBe(false);
    expect(report.tools[0]).toEqual({
      name: "git",
      present: true,
      version: "2.30.0",
      minimum: "2.36",
      ok: false,
    });
  });

  test("accepts a git exactly at the floor", async () => {
    // The off-by-one the comparison is most likely to get wrong: 2.36 meets "2.36 or newer",
    // and a `>` written where `>=` was meant passes every other case in this file.
    process.env.PATH = makeBin({ ...HEALTHY, git: { banner: "git version 2.36.0" } });

    expect((await doctor()).ok).toBe(true);
  });

  test("orders version segments numerically rather than as text", async () => {
    // `"2.9" < "2.36"` as text and the other way round as versions. A comparison that split on
    // dots but compared the pieces as strings passes the two cases above and fails here.
    process.env.PATH = makeBin({ ...HEALTHY, git: { banner: "git version 2.9.5" } });

    expect((await doctor()).ok).toBe(false);
  });

  test("reports a tool that is not installed as absent, with no version", async () => {
    process.env.PATH = makeBin({ git: HEALTHY.git });

    const report = await doctor();

    expect(report.ok).toBe(false);
    expect(report.tools[1]).toEqual({
      name: "gh",
      present: false,
      version: null,
      minimum: null,
      ok: false,
    });
  });

  test("reports a tool that ran and refused as absent too", async () => {
    // A binary on `PATH` that cannot answer `--version` is no more usable than one that is not
    // there, and `wrk` has nothing different to say about it.
    process.env.PATH = makeBin({ ...HEALTHY, gh: { banner: "not enough shell", exit: 1 } });

    expect((await doctor()).tools[1]?.present).toBe(false);
  });

  test("passes a tool whose banner carries no version, when it has no floor to meet", async () => {
    // Present and unreadable is not a finding on its own: `gh` is held to no minimum, so there
    // is nothing the unparsed banner could have disproved, and failing here would be a false
    // alarm on a working machine.
    process.env.PATH = makeBin({ ...HEALTHY, gh: { banner: "gh, somehow" } });

    const report = await doctor();

    expect(report.ok).toBe(true);
    expect(report.tools[1]).toEqual({
      name: "gh",
      present: true,
      version: null,
      minimum: null,
      ok: true,
    });
  });
});

describe("renderDoctor", () => {
  test("lines the tools up, one per line, with the versions they reported", async () => {
    process.env.PATH = makeBin(HEALTHY);

    expect(renderDoctor(await doctor())).toBe("git  2.51.0\ngh   2.63.2");
  });

  test("names the floor when the floor is what failed", async () => {
    // The line a human acts on: "2.30.0" alone does not say what is wrong with it.
    process.env.PATH = makeBin({ ...HEALTHY, git: { banner: "git version 2.30.0" } });

    expect(renderDoctor(await doctor())).toContain("2.30.0 (needs 2.36 or newer)");
  });

  test("says which tool is missing", async () => {
    process.env.PATH = makeBin({ git: HEALTHY.git });

    expect(renderDoctor(await doctor())).toContain("gh   missing");
  });
});

describe("wrk doctor", () => {
  /** Drives the real CLI with `bin` as the whole of the child's `PATH`. */
  function driven(bin: string, ...args: string[]): Promise<RunResult> {
    return run(process.execPath, [CLI_ENTRY, "doctor", ...args], { env: { PATH: bin } });
  }

  test("exits 0 and writes the block to stderr when every tool checks out", async () => {
    // stdout stays empty on the human path: the block is prose, and `output.ts` reserves the
    // machine channel for the envelope.
    const result = await driven(makeBin(HEALTHY));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("git  2.51.0\ngh   2.63.2\n");
  });

  test("exits nonzero when a required tool is missing, and says which", async () => {
    // The issue's own criterion, and the one thing no in-process assertion can make: the exit
    // status is what a `wrk doctor || …` caller reads. The block is asserted alongside it
    // because a status on its own is also what an unknown command exits with.
    const result = await driven(makeBin({ git: HEALTHY.git }));

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("git  2.51.0\ngh   missing\n");
  });

  test("still prints a whole envelope on the run it exits nonzero from", async () => {
    // The fifth exit rule's safety condition. Every other command promises that a nonzero exit
    // leaves stdout empty; this one carries a complete document alongside the status, so a
    // caller piping through `jq` reads the finding rather than a truncated object.
    const result = await driven(makeBin({ git: HEALTHY.git }), "--json");

    expect(result.code).toBe(1);
    expect((JSON.parse(result.stdout) as DoctorReport).ok).toBe(false);
    expect(result.stderr).toBe("");
  });
});
