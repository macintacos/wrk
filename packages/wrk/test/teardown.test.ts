/**
 * Contract of the teardown engine: what `wrk wt rm` removes, in what order, and what it
 * refuses.
 *
 * Every case builds a real bare-repo container in a temp directory and drives the real `git`
 * binary against it, through [`./fixtures/repo.ts`](./fixtures/repo.ts). Nothing is stubbed,
 * for the reason that module's header gives — and here it carries a second obligation: this is
 * a command that deletes directories and refs, so a suite asserting against a mock would
 * certify the mock rather than the deletion. No case touches a worktree of *this* repository.
 *
 * **The fixed order is asserted by breaking the middle step.** Nothing observable distinguishes
 * "removed, synced, deleted" from "removed, deleted, synced" on a run where every step
 * succeeds, so the ordering case points `origin` at a path that is not a repository: the sync
 * then fails between the two, leaving the worktree gone and the branch still there. That is the
 * only witness to the order available from outside the process, and it is the one the issue's
 * constraint is about.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { CommandFailed, Refusal } from "../src/errors";
import { teardown } from "../src/teardown";
import {
  addRunWorktree,
  childEnv,
  cleanupFixtures,
  commit,
  dirty,
  fixtureGit,
  makeContainer,
  runCli,
} from "./fixtures/repo";

afterAll(cleanupFixtures);

/** The repository's local branches, short, as a list. */
function branches(cwd: string): string[] {
  return fixtureGit(["branch", "--format=%(refname:short)"], cwd)
    .split("\n")
    .filter((line) => line !== "");
}

describe("teardown", () => {
  test("removes the worktree and deletes the branch it held", async () => {
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/add-thing");

    const torn = await teardown(checkout, worktree);

    expect(torn).toEqual({
      worktree_path: worktree,
      branch: "EXC-1/add-thing",
      checkout,
    });
    expect(existsSync(worktree)).toBe(false);
    expect(branches(checkout)).not.toContain("EXC-1/add-thing");
  });

  test("resolves the target by the branch the worktree holds", async () => {
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/add-thing");

    expect((await teardown(checkout, "EXC-1/add-thing")).worktree_path).toBe(worktree);
    expect(existsSync(worktree)).toBe(false);
  });

  test("resolves the target by a path relative to the caller's directory", async () => {
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/add-thing");

    expect((await teardown(checkout, "../EXC-1+add-thing")).worktree_path).toBe(worktree);
    expect(existsSync(worktree)).toBe(false);
  });

  test("deletes a branch whose commits the default branch does not have", async () => {
    // The state a squash- or rebase-merge leaves behind, and the only one that tells `-D` from
    // `-d`. Every other case here works on a branch that never moved off the default's tip, so
    // without this the force-delete the module argues for at length is unpinned.
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/add-thing");
    commit(worktree, "landed upstream under another sha");

    await teardown(checkout, worktree);

    expect(branches(checkout)).not.toContain("EXC-1/add-thing");
  });

  test("syncs the default-branch checkout, not the one the caller happens to be in", async () => {
    // `resolveDefaultBranch` falls back to the cwd's own branch when `origin/HEAD` is absent
    // and the default is none of main/master/trunk — which a `clone --bare` container plus a
    // non-conventional default branch is exactly. Asked from a run worktree it then answers
    // that worktree's branch, and every step after it acts on the wrong checkout.
    const { container, checkout } = makeContainer("develop");
    const target = addRunWorktree(container, "EXC-1/add-thing");
    const elsewhere = addRunWorktree(container, "EXC-2/other-work");

    const torn = await teardown(elsewhere, target);

    expect(torn.checkout).toBe(checkout);
    expect(existsSync(elsewhere)).toBe(true);
    expect(branches(checkout)).toEqual(["EXC-2/other-work", "develop"]);
  });

  test("deletes that branch and no other", async () => {
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/add-thing");
    // A branch sharing the issue prefix is exactly what a sweep would take with it.
    fixtureGit(["branch", "EXC-1/sibling"], checkout);

    await teardown(checkout, worktree);

    expect(branches(checkout).sort()).toEqual(["EXC-1/sibling", "main"]);
  });

  test("removes the worktree, then syncs, then deletes the branch", async () => {
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/add-thing");
    fixtureGit(["remote", "set-url", "origin", join(container, "gone.git")], checkout);

    // The message pins *which* step failed, which is what makes the two assertions below an
    // ordering claim rather than a coincidence: the removal is behind it and the delete ahead.
    await expect(teardown(checkout, worktree)).rejects.toThrow(/git fetch origin failed/);

    expect(existsSync(worktree)).toBe(false);
    expect(branches(checkout)).toContain("EXC-1/add-thing");
  });

  test("refuses to remove the worktree the caller is standing in", async () => {
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/add-thing");

    await expect(teardown(worktree, worktree)).rejects.toThrow(Refusal);

    expect(existsSync(worktree)).toBe(true);
    expect(branches(checkout)).toContain("EXC-1/add-thing");
  });

  test("refuses from a subdirectory of the worktree too", async () => {
    const { container } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/add-thing");
    const inside = join(worktree, "deep");
    mkdirSync(inside);

    await expect(teardown(inside, worktree)).rejects.toThrow(Refusal);

    expect(existsSync(worktree)).toBe(true);
  });

  test("does not read a sibling sharing the target's name prefix as being inside it", async () => {
    const { container } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/add-thing");
    const sibling = addRunWorktree(container, "EXC-1/add-thing-2");

    await teardown(sibling, worktree);

    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  test("refuses to remove the default-branch checkout", async () => {
    const { container, checkout } = makeContainer();

    await expect(teardown(container, checkout)).rejects.toThrow(Refusal);

    expect(existsSync(checkout)).toBe(true);
    expect(branches(checkout)).toContain("main");
  });

  test("refuses a target that names no worktree", async () => {
    const { container, checkout } = makeContainer();
    addRunWorktree(container, "EXC-1/add-thing");

    await expect(teardown(checkout, "EXC-9/never-existed")).rejects.toThrow(Refusal);
  });

  test("refuses when no worktree holds the default branch", async () => {
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/add-thing");
    fixtureGit(["worktree", "remove", checkout], container);

    await expect(teardown(container, worktree)).rejects.toThrow(Refusal);

    expect(existsSync(worktree)).toBe(true);
  });

  test("stops on a worktree with uncommitted changes", async () => {
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/add-thing");
    dirty(worktree);

    await expect(teardown(checkout, worktree)).rejects.toThrow(CommandFailed);

    expect(existsSync(worktree)).toBe(true);
    expect(branches(checkout)).toContain("EXC-1/add-thing");
  });

  test("removes a worktree with uncommitted changes when forced", async () => {
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/add-thing");
    dirty(worktree);

    await teardown(checkout, worktree, { force: true });

    expect(existsSync(worktree)).toBe(false);
    expect(branches(checkout)).not.toContain("EXC-1/add-thing");
  });

  test("removes a detached worktree without deleting a branch", async () => {
    const { container, checkout } = makeContainer();
    const detached = join(container, "detached");
    fixtureGit(["worktree", "add", "-q", "--detach", detached, "main"], container);

    const torn = await teardown(checkout, detached);

    expect(torn.branch).toBeNull();
    expect(existsSync(detached)).toBe(false);
    expect(branches(checkout)).toEqual(["main"]);
  });
});

describe("wrk wt rm", () => {
  test("puts the envelope on stdout under --json, and nothing else there", async () => {
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/add-thing");

    const result = await runCli(["wt", "rm", "EXC-1/add-thing", "--json"], checkout, childEnv());

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      worktree_path: worktree,
      branch: "EXC-1/add-thing",
      checkout,
    });
  });

  test("says what it did on stderr, leaving stdout empty, without --json", async () => {
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/add-thing");

    const result = await runCli(["wt", "rm", "EXC-1/add-thing"], checkout, childEnv());

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`wrk: removed ${worktree}`);
    expect(result.stderr).toContain("deleted EXC-1/add-thing");
  });

  test("exits 1 on a refusal, with nothing on stdout", async () => {
    const { container } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/add-thing");

    const result = await runCli(["wt", "rm", "EXC-1/add-thing"], worktree, childEnv());

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("wrk: cannot remove");
    expect(existsSync(worktree)).toBe(true);
  });

  test("leaves `wrk wt` itself still answering with a worktree", async () => {
    // The subcommand must not swallow the group's own action: `wt` with nothing after it is
    // still the picker, which with a single candidate answers without drawing anything.
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/add-thing");

    const result = await runCli(["wt"], checkout, childEnv());

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      worktree_path: worktree,
      branch: "EXC-1/add-thing",
    });
  });
});
