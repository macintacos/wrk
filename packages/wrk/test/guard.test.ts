/**
 * Contract of the cross-checkout edit decision.
 *
 * The pure cases run against synthetic paths with no repository on disk, mirroring the
 * `BlockReasonTests` in the Claude Code hook's own suite so the parity between the two stays
 * checkable by eye. That is what `verdict` being separable from `guardEdit` buys: the layouts
 * that matter — a converted container, an unconverted plain clone, a target that is not a
 * checkout at all — are three strings each, and describing them costs nothing next to building
 * them.
 *
 * The driven cases build real containers and are the only place the git calls themselves run.
 * They are deliberately few: what they prove is that `guardEdit` wires the right facts into
 * `verdict`, not the rule, which the pure cases already pin exhaustively.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { currentBranch } from "../src/git";
import type { Session, Verdict } from "../src/guard";
import { guardEdit, targetCheckout, verdict } from "../src/guard";
import {
  addRunWorktree,
  cleanupFixtures,
  FIXTURE_ENV,
  fixtureGit,
  IDENTITY,
  makeContainer,
  tempDir,
} from "./fixtures/repo";

afterAll(cleanupFixtures);

/**
 * A converted repository: worktrees are siblings of the default-branch checkout inside the
 * container, and the container is the parent of the bare git dir.
 *
 * The pairing of directory name and branch is what `isRunWorktree` reads, so the two travel
 * together in every constant here.
 */
const CONTAINER = "/Users/me/project";
const CHECKOUT = `${CONTAINER}/main`;
const WORKTREE = `${CONTAINER}/EXC-1+feature`;
const SIBLING = `${CONTAINER}/EXC-2+other`;

const CHECKOUT_BRANCH = "main";
const WORKTREE_BRANCH = "EXC-1/feature";
const SIBLING_BRANCH = "EXC-2/other";

/** The session working in the run worktree — what the Claude Code hook sees once it has entered. */
const fromWorktree: Session = { container: CONTAINER, checkout: WORKTREE, branch: WORKTREE_BRANCH };

/** The session working in the default-branch checkout — an orchestrated implementer. */
const fromCheckout: Session = { container: CONTAINER, checkout: CHECKOUT, branch: CHECKOUT_BRANCH };

/**
 * The block reason, or `null` when the edit is allowed.
 *
 * Collapses the union so every case below asserts on one value: `toBeNull()` reads as "allowed"
 * and `toContain(…)` reaches the message without a narrowing dance at each call site.
 */
function reason(decided: Verdict): string | null {
  return decided.allowed ? null : decided.reason;
}

describe("verdict — the accidents it exists for", () => {
  test("blocks the default-branch checkout from a run worktree", () => {
    // The primary accident, and the direction the sanctioned crossing deliberately leaves
    // blocked: the relaxation runs one way only.
    const message = reason(verdict(`${CHECKOUT}/src/app.ts`, fromWorktree, CHECKOUT_BRANCH));

    expect(message).toContain(`${CHECKOUT}/src/app.ts`);
    expect(message).toContain(WORKTREE);
  });

  test("blocks a sibling run worktree from a run worktree", () => {
    // New under the bare layout: siblings are peers rather than children, so a stray path lands
    // in somebody else's worktree just as easily as in the default-branch checkout.
    expect(reason(verdict(`${SIBLING}/src/app.ts`, fromWorktree, SIBLING_BRANCH))).not.toBeNull();
  });

  test("blocks the container root itself", () => {
    expect(reason(verdict(`${CONTAINER}/notes.md`, fromWorktree, ""))).not.toBeNull();
  });

  test("blocks the bare repository", () => {
    expect(reason(verdict(`${CONTAINER}/.bare/config`, fromWorktree, ""))).not.toBeNull();
  });

  test("blocks a sibling whose directory and branch do not pair", () => {
    // Half of `isRunWorktree` is never enough: an issue-shaped branch in a directory that is not
    // the one it would have been given is a checkout parked on a feature branch, not a worktree
    // this tool made — and in the bare layout git-directory identity tells them apart no better.
    expect(
      reason(verdict(`${CONTAINER}/scratch/app.ts`, fromCheckout, "EXC-3/thing")),
    ).not.toBeNull();
  });
});

describe("verdict — what it allows", () => {
  test("allows an edit inside the session's own checkout", () => {
    expect(reason(verdict(`${WORKTREE}/src/app.ts`, fromWorktree, WORKTREE_BRANCH))).toBeNull();
  });

  test("allows the checkout root itself", () => {
    expect(reason(verdict(WORKTREE, fromWorktree, WORKTREE_BRANCH))).toBeNull();
  });

  test("allows a relative path, which no rule here can resolve", () => {
    expect(reason(verdict("src/app.ts", fromWorktree, ""))).toBeNull();
  });

  test("allows the one sanctioned crossing: default-branch checkout into a run worktree", () => {
    // An orchestrated implementer's cwd is pinned to the checkout it was dispatched from and
    // cannot follow it into the worktree it created, so every write it makes crosses here.
    expect(reason(verdict(`${WORKTREE}/src/app.ts`, fromCheckout, WORKTREE_BRANCH))).toBeNull();
  });

  test("allows everything in an unconverted plain clone", () => {
    // Container and checkout coincide, so no path can be inside the first and outside the second,
    // and the guard has nothing to say about a layout it does not manage.
    const plain: Session = {
      container: "/Users/me/plain",
      checkout: "/Users/me/plain",
      branch: "main",
    };

    expect(reason(verdict("/Users/me/plain/src/app.ts", plain, "main"))).toBeNull();
  });

  test("allows a path outside the container entirely", () => {
    expect(reason(verdict("/tmp/scratch.md", fromWorktree, ""))).toBeNull();
  });

  test("allows the exec plan store — the plan-store carve-out", () => {
    // `/linear-plan` writes to `~/.claude/__exec-plans__/<repo-key>/plans/` from wherever the
    // session happens to be, and `/linear-exec` reads it back from inside its worktree. Being
    // outside every container is the clause that permits it; it is pinned here by name because a
    // future rule anchored on something other than the container would break it silently.
    const plan = join(homedir(), ".claude/__exec-plans__/project/plans/EXC-1-thing.md");

    expect(reason(verdict(plan, fromWorktree, ""))).toBeNull();
  });
});

describe("verdict — the fail-open asymmetry", () => {
  test("keeps the block when the target's branch could not be named", () => {
    // The relaxation has to be proven, never assumed: a target git cannot answer for is missing,
    // wedged, or not a checkout, and none of those is a run worktree.
    expect(reason(verdict(`${WORKTREE}/src/app.ts`, fromCheckout, ""))).not.toBeNull();
  });

  test("leaves the crossing available when the session's own branch is unknown", () => {
    // The other half. A session that cannot name its own branch is not a run worktree as far as
    // this rule is concerned, so the crossing stays open — a guard does not block harder because
    // it knows less about itself.
    const detached: Session = { container: CONTAINER, checkout: CHECKOUT, branch: "" };

    expect(reason(verdict(`${WORKTREE}/src/app.ts`, detached, WORKTREE_BRANCH))).toBeNull();
  });
});

describe("verdict — the inversion it dissolves", () => {
  test("reproduces the OpenCode rule when the session location is the worktree root", () => {
    // The OpenCode plugin cannot anchor on `$PWD` — that harness never relocates the session — so
    // it remembers the worktree root `create` printed and blocks everything else inside the
    // container. Feeding that root in as the session location produces exactly its rule out of
    // this one: the session is a run worktree, so the crossing is unavailable and every other
    // in-container path blocks, while out-of-container paths stay allowed.
    expect(reason(verdict(`${CHECKOUT}/src/app.ts`, fromWorktree, CHECKOUT_BRANCH))).not.toBeNull();
    expect(reason(verdict(`${SIBLING}/src/app.ts`, fromWorktree, SIBLING_BRANCH))).not.toBeNull();
    expect(reason(verdict(`${CONTAINER}/notes.md`, fromWorktree, ""))).not.toBeNull();
    expect(reason(verdict("/tmp/scratch.md", fromWorktree, ""))).toBeNull();
  });
});

describe("targetCheckout", () => {
  test("names the container-level directory a crossing path lands in", () => {
    expect(targetCheckout(`${SIBLING}/deep/nested/app.ts`, CONTAINER, WORKTREE)).toBe(SIBLING);
  });

  test("is null for the three shapes that settle without one", () => {
    expect(targetCheckout("src/app.ts", CONTAINER, WORKTREE)).toBeNull();
    expect(targetCheckout(`${WORKTREE}/src/app.ts`, CONTAINER, WORKTREE)).toBeNull();
    expect(targetCheckout("/tmp/scratch.md", CONTAINER, WORKTREE)).toBeNull();
  });
});

describe("the import closure", () => {
  /**
   * Every module `entry` reaches through relative imports, and every bare specifier among them.
   *
   * A regex over the source rather than a parse: these files are written by this project and
   * every import in them is a static top-level `from "…"`, so the shapes a parser would buy — a
   * dynamic import, a `require`, a specifier built by concatenation — do not occur.
   *
   * That premise is **asserted rather than assumed**, because it is exactly the assumption whose
   * quiet failure would turn this whole case green while the picker sat on the hot path: a regex
   * that cannot match `await import("…")` does not see the specifier, so the closure stays small
   * and the set below still equals `["zod"]`. A file that grows one throws here instead.
   */
  function closure(entry: string): { files: string[]; bare: Set<string> } {
    const files: string[] = [];
    const bare = new Set<string>();
    const queue = [entry];

    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (files.includes(file)) continue;
      files.push(file);

      const source = readFileSync(file, "utf8");
      if (/\b(?:import|require)\s*\(/.test(source)) {
        throw new Error(`${file}: dynamic import or require — this walk cannot follow it`);
      }

      for (const [, specifier] of source.matchAll(/^import[^"']*["']([^"']+)["'];?$/gm)) {
        if (specifier === undefined) continue;
        if (specifier.startsWith(".")) queue.push(`${join(dirname(file), specifier)}.ts`);
        else bare.add(specifier);
      }
    }
    return { files, bare };
  }

  test("reaches no dependency beyond the one already on the git path", () => {
    // What this module imports *is* part of its contract: it is built to be called from an edit
    // guard firing on every file write, and a guard must never block on its own bug. `wt.ts` and
    // `prpick.ts` import the picker statically and there is no dynamic import anywhere in `src`,
    // so one wrong import here pulls `ink` and `react` onto that path and takes the latency
    // budget with them.
    //
    // Asserted as an exact set rather than as a blocklist, so a *new* dependency fails here and
    // has to be argued for rather than merely not being on a list somebody remembered to update.
    // `zod` is the one already present, reached through `./repo` → `./git`, where it parses
    // `worktree list --porcelain` records.
    const { files, bare } = closure(join(import.meta.dir, "../src/guard.ts"));

    expect([...bare].filter((specifier) => !specifier.startsWith("node:")).sort()).toEqual(["zod"]);
    expect(files.length).toBeGreaterThan(1);
  });
});

/**
 * What one decision must cost, from process start. **The enforced budget.**
 *
 * A regression guard rather than a benchmark, on the construction `latency.test.ts` sets out for
 * the picker's: the number is placed where no machine can cross it and no regression that matters
 * can stay under it, not just above the observed cost. Idle, every path shape here measures 34–42
 * ms; at load average 18, with three other full test suites sharing the machine, the median rose
 * to 272 ms and the worst single run to 402 ms. A thousand is ~25× the first and ~2.5× the
 * second.
 *
 * What that catches is the class of regression that *waits* — a lock, a network call, a storm of
 * serialised subprocesses — which is the only class that matters for something firing before
 * every file write. What it deliberately does not catch is the picker, because a timing case
 * cannot: under the same load, a probe importing the picker still medianed 506 ms. The import
 * closure above is that half of the criterion, and it is exact rather than statistical.
 */
const BUDGET_MS = 1000;

/** Runs per measurement. Odd, so the median is a sample rather than a mean of two. */
const RUNS = 5;

describe(`the latency budget — a verdict within ${BUDGET_MS} ms of process start`, () => {
  test("costs about what starting the runtime costs, on a path that does the most work", async () => {
    // Measured on a *blocked* crossing, which pays for both branch lookups exactly as the
    // sanctioned one does — and answers the one word no shortcut can produce. `allowed` is what
    // every fail-open path prints too: a probe that crashed, a container fixture that failed to
    // build, a cwd that turned out not to be a repository. Asserting on it would let this case
    // sleep through the regression it exists to catch, since all three are also very fast.
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/feature");
    addRunWorktree(container, "EXC-2/other");
    // The runtime already running this suite, for `runCli`'s reason in `fixtures/repo.ts`: no
    // toolchain lookup, and the child is the same binary being measured.
    const probe = join(import.meta.dir, "fixtures", "guard-probe.ts");
    const target = join(checkout, "src/app.ts");

    const samples: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const started = performance.now();
      const child = Bun.spawn([process.execPath, probe, target, worktree], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await child.exited;
      samples.push(performance.now() - started);

      expect(await new Response(child.stdout).text()).toBe("blocked\n");
    }
    const median = samples.sort((a, b) => a - b)[Math.floor(RUNS / 2)] as number;

    expect(median).toBeLessThan(BUDGET_MS);
  });
});

describe("guardEdit", () => {
  test("blocks a run worktree from writing at the default-branch checkout", async () => {
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/feature");

    expect(reason(await guardEdit(join(checkout, "src/app.ts"), worktree))).not.toBeNull();
  });

  test("allows the default-branch checkout to write into a run worktree", async () => {
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/feature");

    expect(reason(await guardEdit(join(worktree, "src/app.ts"), checkout))).toBeNull();
  });

  test("still allows it when the run worktree is stopped mid-rebase", async () => {
    // A conflict the model has to resolve by hand must not lock it out of the worktree — and
    // mid-rebase is exactly when a detached HEAD stops the target from looking like a run
    // worktree at all.
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/feature");
    conflictedRebase(checkout, worktree);

    // Without this the case passes on a rebase that finished or never started, leaving HEAD
    // attached — in which case `currentBranch` answers and the recovery under test never runs.
    expect(await currentBranch(worktree)).toBeNull();
    expect(reason(await guardEdit(join(worktree, "file.txt"), checkout))).toBeNull();
  });

  test("resolves a relative path against the working directory, not the checkout root", async () => {
    // A session `cd`-ed into a subdirectory is the ordinary case, and every `..` in a relative
    // path resolves one level too high if the checkout root is used as the anchor: an edit into
    // the session's own tree gets blocked, and one aimed at the default-branch checkout gets
    // through. Both directions are pinned, because the anchor being wrong breaks them together.
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/feature");
    const inside = join(worktree, "src");
    mkdirSync(inside, { recursive: true });

    expect(reason(await guardEdit("../src/app.ts", inside))).toBeNull();
    expect(reason(await guardEdit(`../../${basename(checkout)}/app.ts`, inside))).not.toBeNull();
  });

  test("follows a symlink standing at the target, not only ones on the way to it", async () => {
    // The write follows it, so the guard has to. A symlink inside the worktree pointing at the
    // default-branch checkout is the shape that would otherwise launder the accident straight
    // through the rule.
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/feature");
    const aliased = join(worktree, "aliased.txt");
    symlinkSync(join(checkout, "README"), aliased);

    expect(reason(await guardEdit(aliased, worktree))).not.toBeNull();
  });

  test("follows a symlink standing at the target even when it dangles", async () => {
    // `realpath` rejects on a link whose target does not exist, so this is a distinct code path
    // from the case above rather than a restatement of it — and it is the one a `Write` takes,
    // since writing through a dangling link is what creates the file it points at.
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/feature");
    const aliased = join(worktree, "dangling.txt");
    symlinkSync(join(checkout, "not-there-yet.txt"), aliased);

    expect(reason(await guardEdit(aliased, worktree))).not.toBeNull();
  });

  test("keeps the block when the target is not a checkout at all", async () => {
    const { container, checkout } = makeContainer();

    expect(reason(await guardEdit(join(container, "notes/scratch.md"), checkout))).not.toBeNull();
  });

  test("allows everything when the session is not in a repository", async () => {
    const { checkout } = makeContainer();

    expect(reason(await guardEdit(join(checkout, "src/app.ts"), tempDir()))).toBeNull();
  });

  test("allows an empty file path rather than throwing", async () => {
    const { checkout } = makeContainer();

    expect(reason(await guardEdit("", checkout))).toBeNull();
  });
});

/**
 * Stops `worktree` mid-rebase onto `main`, on a conflict.
 *
 * The conflict is the point: a rebase that applies cleanly re-attaches HEAD and leaves nothing to
 * recover. Both sides commit a different line into the same new file from a shared parent, which
 * is the smallest thing git refuses to merge.
 *
 * `--no-update-refs` because the setting makes some backends refuse outright, and a refused rebase
 * leaves HEAD attached — which would pass the case above vacuously. Run through `execFileSync`
 * rather than `fixtureGit` only to pipe stderr: git narrates a conflict at length, and a
 * deliberate one should not read as a broken suite.
 */
function conflictedRebase(checkout: string, worktree: string): void {
  writeFileSync(join(checkout, "file.txt"), "checkout\n");
  fixtureGit(["add", "file.txt"], checkout);
  fixtureGit([...IDENTITY, "commit", "-q", "-m", "checkout side"], checkout);
  writeFileSync(join(worktree, "file.txt"), "worktree\n");
  fixtureGit(["add", "file.txt"], worktree);
  fixtureGit([...IDENTITY, "commit", "-q", "-m", "worktree side"], worktree);

  try {
    execFileSync("git", [...IDENTITY, "rebase", "--no-update-refs", "main"], {
      cwd: worktree,
      env: FIXTURE_ENV,
      stdio: "pipe",
    });
  } catch {
    /* expected: the rebase stops on the conflict */
  }
}
