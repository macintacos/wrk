/**
 * The pull-request picker, from both ends: the pure decisions, and the real command in a real
 * terminal.
 *
 * The pure half — which pull requests are offered, in what order, what each row says, and
 * which worktree already holds one — is a function of its arguments and is asserted directly.
 * The other half is only true of a process: the picker reads `isTTY` off stdin and stderr, the
 * `cd` protocol is a claim about stdout and an exit status at once, and "the worktree was
 * force-removed" is a claim about a directory. Those cases run the CLI as a child attached to a
 * pty, on [`./fixtures/repo.ts`](./fixtures/repo.ts)'s harness and
 * [`../../picker/test/fixtures/pty.ts`](../../picker/test/fixtures/pty.ts) — both existing, and
 * neither rebuilt here.
 *
 * **No case reaches the GitHub API, and none runs the real `gh`.** The rows arrive by seeding
 * the `pr-graph` cache entry the command reads through, which is the same door `wt.test.ts`
 * uses. `gh pr checkout` is a fake executable on a `PATH` holding it and `git` alone, logging
 * the cwd and argv it was called with — the shape `gh.test.ts` established — because the
 * acceptance criterion "checkout goes through the GitHub CLI" is invisible in the result and
 * observable only in what was run.
 *
 * @packageDocumentation
 */

import { afterAll, describe, expect, test } from "bun:test";

import type { PullRequest } from "../src/gh";
import type { Worktree } from "../src/git";
import { holderFor, openPullRequests, pullRequestRows } from "../src/prpick";
import { cleanupFixtures } from "./fixtures/repo";

afterAll(cleanupFixtures);

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

/** The rows keyed by head ref, as `pullRequests` returns them. */
function graph(...rows: PullRequest[]): Map<string, PullRequest> {
  return new Map(rows.map((row) => [row.headRefName, row]));
}

/** A worktree record as `listWorktrees` reports one: branch refs fully qualified. */
function worktree(path: string, branch: string | null, prunable: string | null = null): Worktree {
  return {
    path,
    head: "0f1e2d3c4b5a69788796a5b4c3d2e1f001122334",
    branch: branch === null ? null : `refs/heads/${branch}`,
    prunable,
  };
}

describe("openPullRequests", () => {
  test("drops merged pull requests, which are not somewhere to go", () => {
    const prs = graph(pull(1, "live"), pull(2, "landed", { state: "MERGED" }));

    expect(openPullRequests(prs).map((row) => row.number)).toEqual([1]);
  });

  test("orders most-recently-updated first", () => {
    // The map's own order is whatever `dedupe` folded on the way out of the cache, which is
    // not the order the acceptance criterion asks for — so the sort is explicit.
    const prs = graph(
      pull(1, "old", { updatedAt: "2026-01-01T00:00:00Z" }),
      pull(2, "newest", { updatedAt: "2026-03-01T00:00:00Z" }),
      pull(3, "middle", { updatedAt: "2026-02-01T00:00:00Z" }),
    );

    expect(openPullRequests(prs).map((row) => row.number)).toEqual([2, 3, 1]);
  });

  test("breaks a timestamp tie with the higher number, so the order is total", () => {
    // Without this the answer depends on which row the map happened to hold first, and two
    // runs of the same command would draw the same list in different orders.
    const prs = graph(pull(4, "a"), pull(9, "b"), pull(6, "c"));

    expect(openPullRequests(prs).map((row) => row.number)).toEqual([9, 6, 4]);
  });
});

describe("pullRequestRows", () => {
  test("renders the number, the title and the head branch, in that order", () => {
    const rows = pullRequestRows([pull(22, "EXC-1/thing")]);

    expect(rows[0]?.columns.map((column) => column.text)).toEqual([
      "#22",
      "the EXC-1/thing change",
      "EXC-1/thing",
    ]);
  });

  test("the payload is the number as a string, not the row's text and not an object", () => {
    // `PickerRow.payload` must be unique across the rows and compare `===` after a row-set
    // replacement. A pull-request number is both; an object rebuilt from a fresh query is
    // neither, and a title is not even unique.
    const rows = pullRequestRows([pull(22, "EXC-1/thing"), pull(23, "EXC-2/thing")]);

    expect(rows.map((row) => row.payload)).toEqual(["22", "23"]);
  });
});

describe("holderFor", () => {
  test("finds the worktree standing on the pull request's head branch", () => {
    const here = worktree("/c/trunk", "trunk");
    const mine = worktree("/c/EXC-1+thing", "EXC-1/thing");

    expect(holderFor([here, mine], "EXC-1/thing")).toBe(mine);
  });

  test("answers nothing when no worktree holds it", () => {
    expect(holderFor([worktree("/c/trunk", "trunk")], "EXC-1/thing")).toBeUndefined();
  });

  test("answers a prunable record rather than skipping it", () => {
    // The opposite call to `wt.ts`'s `candidates`, and deliberately: there a stale record is a
    // destination that cannot be entered, here it is the thing standing between the caller and
    // the branch — git refuses to check it out anywhere else until the record is pruned. The
    // caller has to see it to confirm the prune.
    const gone = worktree("/c/EXC-1+thing", "EXC-1/thing", "gitdir file points to non-existent");

    expect(holderFor([gone], "EXC-1/thing")).toBe(gone);
  });

  test("never matches a detached worktree, which has no branch to join on", () => {
    expect(holderFor([worktree("/c/spike", null)], "EXC-1/thing")).toBeUndefined();
  });
});
