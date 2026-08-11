/**
 * The health check: are the tools `wrk` shells out to installed, and new enough to trust?
 *
 * `wrk` is mostly a well-behaved front-end to `git` and `gh` — `proc.ts`'s own header says so
 * — which means every interesting failure of the machine it runs on is a failure of one of
 * those two. This module answers that question directly, so a user does not have to infer it
 * from a command that went wrong somewhere else.
 *
 * **The git floor is the reason this is more than a `which`.** `doc/ADVANCED.md` records that
 * `wrk` needs **git 2.36 or newer**, and that an older one fails *silently*: `rev-parse`
 * hand-rolls its option parsing and echoes an unrecognised `--path-format` back to stdout
 * while exiting `0`, so below 2.31 the repository resolves to a container named
 * `--path-format=absolute`. That answer is stable and wrong, and no error surfaces anywhere.
 * The README's advice for it is "run `git --version` before anything else"; this command is
 * that advice, mechanised. A present-but-old `git` is therefore reported as **present and not
 * ok**, never as missing — they are different problems with different fixes.
 *
 * **Both tools are required, so nothing here says so.** `git` is required outright, and `gh`
 * is what `wrk pr` and the stack annotations in `wrk wt` are built on. There is no second
 * case, so there is no `required` field to carry one: a genuinely optional tool earns that
 * field on the day one exists.
 *
 * **The presence gate is the spawn**, as in [`./gh`](./gh) and [`./provision`](./provision):
 * {@link run} rejects when the child could not be started, and that rejection *is* the
 * answer, so no `which` is reimplemented and no window opens between a probe and the run. It
 * calls `run` directly rather than reaching through this package's own wrappers, which cannot
 * serve it — [`./git`](./git)'s `git()` would reject on a missing binary rather than report
 * one, and [`./gh`](./gh) deliberately exports no escape hatch. One code path over both tools
 * is smaller than two special cases, and neither tool is being asked anything that needs a
 * wrapper's knowledge.
 *
 * **A version is compared by hand rather than by dependency.** `Bun.semver` is Bun-only and
 * this package targets Node — `proc.ts`'s reason for `node:child_process`, applied again —
 * and a semver dependency for one floor check is a package for what {@link atLeast}'s eight
 * lines do. Anything that does not parse as digits compares as *below* the floor, which is
 * the safe direction: an unreadable version cannot be evidence of a version that is fine.
 *
 * **Its exit status is the fifth of [`./output`](./output)'s four exit rules, and the only
 * command that adds one.** Everywhere else a verdict exits `0` and the caller branches on the
 * payload; here the caller is a shell running `wrk doctor || …` that parses nothing, so the
 * status has to carry the finding. It stays compatible with the promise the rest of the
 * contract rests on — that a run which *fails* writes nothing to stdout — because a failing
 * check is not a failed run: the envelope is complete on stdout either way, and only the
 * status differs. The assignment itself is `process.exitCode` in the command, per
 * `output.ts`'s flushing rule.
 *
 * @packageDocumentation
 */

import { run } from "./proc";

/** A tool `wrk` needs, and the oldest release of it this package will vouch for. */
interface Required {
  /** The executable's name, as it is spelled on `PATH` and reported back. */
  readonly name: string;

  /** The version floor, or `null` for a tool held to none. */
  readonly minimum: string | null;
}

/**
 * The tools checked, in the order they are reported.
 *
 * `git`'s floor is `doc/ADVANCED.md`'s, and it is stated as two segments because that is what
 * the documentation promises — {@link atLeast} compares only the segments the floor names, so
 * every 2.36.x satisfies it.
 *
 * `gh` is held to no floor. `wrk` uses `gh pr list --json` and `gh pr view`, both long
 * settled, and a floor invented here would fail machines that work.
 */
const REQUIRED: readonly Required[] = [
  { name: "git", minimum: "2.36" },
  { name: "gh", minimum: null },
];

/**
 * The first dotted number in a `--version` banner.
 *
 * Both tools bury their version in a sentence — `git version 2.51.0`, and `gh`'s
 * `gh version 2.63.2 (2024-12-05)` followed by a release URL carrying the same number — so the
 * first match is the answer and the rest of the banner is prose.
 */
const VERSION_PATTERN = /\d+(?:\.\d+)+/;

/** What one tool reported about itself. */
export interface ToolReport {
  /** The executable's name. */
  readonly name: string;

  /** Whether it is installed and able to answer `--version`. */
  readonly present: boolean;

  /** The version it reported, or `null` when it is absent or its banner carried none. */
  readonly version: string | null;

  /** The floor it is held to, or `null` for a tool held to none. */
  readonly minimum: string | null;

  /**
   * Whether this tool is fit to use: installed, and — where it has a floor — provably at or
   * above it. A present tool whose version could not be read fails only when it has a floor,
   * since an unreadable banner is not evidence against a requirement that does not exist.
   */
  readonly ok: boolean;
}

/**
 * One `wrk doctor` run's answer, rendered as the single JSON object on stdout under `--json`.
 *
 * Declaration order is wire order, and `envelope` inherits it from the payload's own insertion
 * order — so both literals below are built whole, as `preflight.ts` builds its report.
 */
export interface DoctorReport {
  /** Whether every tool is ok. What the command's exit status is taken from. */
  readonly ok: boolean;

  /** One entry per tool, in {@link REQUIRED}'s order. */
  readonly tools: readonly ToolReport[];
}

/**
 * Whether `version` is at or above `minimum`, comparing only the segments `minimum` names.
 *
 * A floor of `"2.36"` is therefore met by `2.36.0` and by `2.36` alike, which is what lets the
 * floor be written the way the documentation states it. A segment that is not a number
 * compares as below, so an unreadable version is never mistaken for a sufficient one.
 *
 * @param version - The version found in a tool's banner, e.g. `2.51.0`.
 * @param minimum - The floor, e.g. `2.36`.
 */
function atLeast(version: string, minimum: string): boolean {
  const found = version.split(".").map(Number);

  for (const [index, want] of minimum.split(".").map(Number).entries()) {
    const have = found[index] ?? 0;
    if (have !== want) return have > want;
  }

  return true;
}

/**
 * What `name --version` printed, or `null` if it could not be run or refused.
 *
 * The rejection `run` raises for a child that never started is the presence gate — see this
 * module's header. A nonzero exit joins it: a binary on `PATH` that cannot answer is no more
 * usable than one that is not there, and `wrk` has nothing different to say about it.
 */
async function banner(name: string): Promise<string | null> {
  const result = await run(name, ["--version"]).catch(() => null);

  return result === null || result.code !== 0 ? null : result.stdout;
}

/** Asks one tool about itself and grades the answer. */
async function probe(tool: Required): Promise<ToolReport> {
  const said = await banner(tool.name);
  const version = said === null ? null : (VERSION_PATTERN.exec(said)?.[0] ?? null);

  return {
    name: tool.name,
    present: said !== null,
    version,
    minimum: tool.minimum,
    ok:
      said !== null &&
      (tool.minimum === null || (version !== null && atLeast(version, tool.minimum))),
  };
}

/**
 * Checks every tool `wrk` depends on and reports what it found.
 *
 * The probes run concurrently: they are independent spawns, and a machine missing both should
 * not wait for two timeouts in series.
 *
 * @returns The report — see {@link DoctorReport}. Never throws: a tool that cannot be run is
 *   the answer this function exists to give, not a failure to give one.
 *
 * @example
 * ```ts
 * const report = await doctor();
 * if (!report.ok) process.exitCode = 1;
 * ```
 */
export async function doctor(): Promise<DoctorReport> {
  const tools = await Promise.all(REQUIRED.map(probe));

  return { ok: tools.every((tool) => tool.ok), tools };
}

/**
 * Renders a report as the block `wrk doctor` writes to stderr for a human.
 *
 * One line per tool, names padded so the versions line up. stderr rather than stdout because
 * that is [`./output`](./output)'s rule for anything a person reads — `repo convert`'s recipe
 * takes the same route — and `--json` is what puts the same answer on the machine channel.
 *
 * @param report - What {@link doctor} found.
 * @returns The block, without a trailing newline; {@link note} adds it.
 */
export function renderDoctor(report: DoctorReport): string {
  const width = Math.max(...report.tools.map((tool) => tool.name.length));

  return report.tools.map((tool) => `${tool.name.padEnd(width)}  ${verdict(tool)}`).join("\n");
}

/** What one tool's line says after its name. */
function verdict(tool: ToolReport): string {
  if (!tool.present) return "missing";
  if (tool.ok) return tool.version ?? "installed";

  return `${tool.version ?? "unreadable version"} (needs ${tool.minimum} or newer)`;
}
