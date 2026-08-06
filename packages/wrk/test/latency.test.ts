/**
 * The latency budget: how long either picker may take to become interactive, proved against
 * a `gh` that is deliberately slow.
 *
 * The claim is **invocation to interactive**, not "the fetch returned quickly". `pr.test.ts`
 * already owns the second one — its background-refresh case times one child process against a
 * stalling `gh` — and it cannot see the thing a person actually waits through, because the
 * runtime's own cold start is outside its clock and is the same order of magnitude as the
 * fetch it is comparing against. These cases start the clock before `bash` does and stop it
 * when a row is on screen, so `bash`, `bun`, the module graph, `git`, the config read and the
 * cache read are all inside the number.
 *
 * **Two numbers, and conflating them is how a timing suite becomes a re-run ritual.**
 * {@link OBSERVED_MS} is what the commands cost — measured, recorded, and asserted on by
 * nothing. {@link INTERACTIVE_MS} is what the suite fails at, and it is set from the stub's
 * own delay rather than from the observed figure: at half of {@link DELAY_SECONDS} it is
 * roughly five times the worst run seen on a machine under eight spinning CPU burners, and
 * still half of what the fastest possible implementation that *waited* for `gh` could
 * achieve. Nothing between the two is a legitimate outcome, so a loaded machine cannot fail
 * these cases and a regression cannot pass them. `pr.test.ts`'s `CEILING_MS` is the same
 * construction, and it says the same thing about why: a regression guard rather than a
 * benchmark.
 *
 * **"Warm cache" means seeded *and stale*, not seeded and fresh.** A fresh entry runs no `gh`
 * at all, so a delay stubbed into one would prove nothing whatever. Back-dating the entry past
 * the TTL puts the run on the path the budget is a claim about: `cachedBehind` serves the
 * stored rows immediately and detaches a refresh that sleeps.
 *
 * **The cold-cache case is deliberately not here**, and the asymmetry is real rather than an
 * omission. `wrk wt` draws from git alone and stays inside the budget cold; `wrk pr`'s rows
 * *are* the cache, so a first run in a repository waits for `gh` once and is measured at the
 * stub's full delay. That is the exception `doc/ADVANCED.md` states beside the budget, and
 * asserting a budget it is documented to breach would only pin the exception in place.
 *
 * No case reaches the network. The `gh` here is a shell script on a `PATH` holding it, `git`,
 * `sleep` and `cat` — the third `gh`-shaped fixture over `shedGh`'s one directory, after
 * `wt.test.ts`'s gated one and `prpick.test.ts`'s logging one. A **delay** rather than a gate
 * because the question is elapsed time; a gate answers ordering, which is EXC-1017's.
 *
 * @packageDocumentation
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { KEY, SHOW_CURSOR, typeUntil } from "../../picker/test/fixtures/pty";
import { cachePath } from "../src/cache";
import type { PullRequest } from "../src/gh";
import {
  addRunWorktree,
  cleanupFixtures,
  driveCli,
  ENDED,
  makeContainer,
  shedGh,
  status,
  tempDir,
} from "./fixtures/repo";

afterAll(cleanupFixtures);

/**
 * How long the stubbed `gh` sleeps before answering anything — the wait that must not be paid.
 *
 * Four seconds rather than one: the delay is the discriminator, so it has to sit far enough
 * above a real invocation that no machine can blur the two. A `gh` that is merely slower than
 * the picker would make these cases a race.
 */
const DELAY_SECONDS = 4;

/**
 * What a picker must be interactive within, from process start. **The enforced budget.**
 *
 * Half the delay, which is what makes it a guard rather than a benchmark — see this module's
 * header. An implementation that waited for `gh` cannot come in under `DELAY_SECONDS`, however
 * fast the machine; a machine slow enough to push a ~300 ms invocation past two seconds is
 * slow enough that every other driven case in this repository has already timed out.
 */
const INTERACTIVE_MS = (DELAY_SECONDS * 1000) / 2;

/**
 * What the two commands were actually measured at, for the reader comparing the assertion
 * above against reality. Recorded rather than asserted on.
 *
 * Apple silicon, warm-and-stale cache, `gh` stubbed as below, medians of five runs: `wrk wt`
 * 256 ms and `wrk pr` 279 ms idle; 312 ms and 322 ms under eight spinning CPU burners, worst
 * single run 384 ms. `doc/ADVANCED.md` carries the same figures for a user rather than for a
 * maintainer.
 */
const OBSERVED_MS = "≈260–320 ms";

/**
 * How long a case waits for a run to finish, and how long `bun test` gives it.
 *
 * Both are well past {@link DELAY_SECONDS} because dismissing does not stop an in-flight `gh`:
 * `wrk pr`'s preview pane has one out on the first frame, and the process stays alive until it
 * answers. `pr.test.ts`'s clock case takes an explicit timeout for the same reason.
 */
const SETTLE_MS = 20_000;
const CASE_TIMEOUT_MS = 30_000;

/** A pull-request row as `gh` reports one. */
function pull(number: number, head: string, extra: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    title: `the ${head} change`,
    headRefName: head,
    baseRefName: "trunk",
    state: "OPEN",
    updatedAt: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

/** A two-layer stack, one pull request per worktree, so `wt`'s annotation has both markers. */
const STACKED = [
  pull(11, "EXC-1/thing-1"),
  pull(12, "EXC-2/thing-2", { baseRefName: "EXC-1/thing-1" }),
];

/**
 * A `PATH` whose `gh` answers only after {@link DELAY_SECONDS}, whatever it is asked.
 *
 * Every subcommand sleeps, `pr view` included: the preview pane is one of the two things that
 * could put `gh` in front of a frame, and a stub that only stalled the listing would leave that
 * half untested.
 *
 * `sleep` and `cat` are symlinked in beside `git` rather than spelled absolutely, because the
 * script's own `PATH` is this directory — `wt.test.ts`'s gated fixture does the same, for the
 * same reason.
 */
function slowGh(rows: readonly PullRequest[]): string {
  const dir = shedGh("sleep", "cat");
  const answer = join(dir, "open.json");
  writeFileSync(answer, JSON.stringify(rows));
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      `sleep ${DELAY_SECONDS}`,
      'case "$*" in',
      // The merged query answers `[]` — `gh` saying "none" rather than "could not answer",
      // which is the distinction `gh.ts` documents and what lets an entry be written at all.
      `  *"--state open"*) cat "${answer}" ;;`,
      `  *" view "*) printf 'PREVIEW-BODY %s\\n' "$3" ;;`,
      "  *) echo '[]' ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return dir;
}

/**
 * Seeds the `pr-graph` entry and back-dates it past any TTL.
 *
 * The back-dating is the whole fixture. A freshly written entry is *fresh*, so the command
 * serves it and never runs `gh` — under which the stub's delay is not being avoided, it is
 * simply never reached, and the case would pass against an implementation that blocks. Aged,
 * the run takes the path that matters: stored rows served immediately, refresh detached.
 * `pr.test.ts` and `preview.test.ts` both age their entries this way.
 */
function seedStale(container: string, cacheHome: string, rows: readonly PullRequest[]): void {
  const entry = cachePath({ name: "pr-graph", container, root: join(cacheHome, "wrk") });
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, JSON.stringify(rows));

  const when = new Date(Date.now() - 86_400_000);
  utimesSync(entry, when, when);
}

/** What {@link warmRepo} built: somewhere to run from, a stale entry, and a slow `gh`. */
interface Fixture {
  checkout: string;
  cacheHome: string;
  path: string;
}

/** A container with two run worktrees, a stale `pr-graph` entry, and {@link slowGh} on `PATH`. */
function warmRepo(): Fixture {
  const { container, checkout } = makeContainer("trunk");
  addRunWorktree(container, "EXC-1/thing-1");
  addRunWorktree(container, "EXC-2/thing-2");

  const cacheHome = tempDir();
  seedStale(container, cacheHome, STACKED);

  return { checkout, cacheHome, path: slowGh(STACKED) };
}

/**
 * Runs `wrk <command> --print-path` and answers how long it took to become interactive.
 *
 * The clock starts here rather than inside the driver, which is the only place it can include
 * process start — `driveCli`'s driver is handed a session that already exists. What sits
 * between this line and the spawn is two `mkdtemp` calls, so the figure **over**-counts by
 * well under a millisecond and can never under-count.
 *
 * `drawn` is waited for rather than the first row: it names the **last** row the frame holds,
 * so a frame still being written cannot satisfy it and be read as an interactive picker.
 *
 * The dismissal is two steps rather than `quit`. `quit` waits for the script's exit line, and
 * an escape re-typed past Ink's unmount is echoed by the line discipline into a `bash` that
 * never reads it — which is exactly what happens here, because the process outlives the pick by
 * whatever the in-flight `gh` has left. So the keystroke is aimed at the unmount, and the exit
 * is waited for separately. `wt.test.ts`'s "a refresh still running when the picker closes"
 * case established the pattern.
 */
async function timeToInteractive(
  fixture: Fixture,
  command: string,
  drawn: string,
): Promise<{ interactive: number; exit: number }> {
  let interactive = 0;
  const started = Date.now();

  const { capture } = await driveCli(
    fixture.checkout,
    [command, "--print-path"],
    async (session) => {
      await session.waitFor(drawn, SETTLE_MS);
      interactive = Date.now() - started;

      await typeUntil(session, KEY.escape, (text) => text.includes(SHOW_CURSOR), "closed");
      await session.waitFor(ENDED, SETTLE_MS);
    },
    { cacheHome: fixture.cacheHome, path: fixture.path, rows: 24 },
  );

  // Dismissed, so the run must have taken the cancellation path — a case that measured a fast
  // frame from a command that then failed would be measuring a refusal being printed.
  expect(status(capture)).toBe(130);

  return { interactive, exit: Date.now() - started };
}

describe(`the picker latency budget — interactive within ${INTERACTIVE_MS} ms, observed ${OBSERVED_MS}`, () => {
  test(
    "wrk wt draws its worktrees, annotated from the stale entry, without waiting for gh",
    async () => {
      // The needle is the **annotated** frame rather than the bare one, which is strictly the
      // later of the two and therefore a conservative clock — and it is what makes this a
      // *warm-cache* claim rather than a claim about an empty picker: the `#11` on screen came
      // off disk while the only `gh` on `PATH` has answered nothing. That the bare list precedes
      // it at all is `wt.test.ts`'s claim, proved there with a gate rather than a delay.
      const fixture = warmRepo();
      const { interactive, exit } = await timeToInteractive(fixture, "wt", "#11");

      expect(interactive).toBeLessThan(INTERACTIVE_MS);

      // The whole run, not just the frame: `wt`'s refresh is detached, so a slow `gh` costs the
      // *process* nothing either. This is the half `pr.test.ts` proves for one child call and
      // this file proves for the command a person actually types.
      expect(exit).toBeLessThan(INTERACTIVE_MS);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "wrk pr draws its pull requests without waiting for gh",
    async () => {
      // The stronger of the two: `prpick.ts` awaits `pullRequests` *in front of* its draw, so
      // there is nothing behind which a blocking fetch could hide. The preview pane's own
      // `gh pr view` is the same sleeping stub and is deliberately not waited for — a list you
      // can type into and choose from is interactive whether or not the pane has landed.
      const fixture = warmRepo();
      const { interactive } = await timeToInteractive(fixture, "pr", "#11");

      expect(interactive).toBeLessThan(INTERACTIVE_MS);
    },
    CASE_TIMEOUT_MS,
  );
});
