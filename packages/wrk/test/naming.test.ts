/**
 * The naming rules, pinned.
 *
 * These rules were previously reimplemented across three languages and had already
 * drifted — three mutually incompatible issue-key regexes, four cache-key sanitizers, and
 * a branch-minting rule that existed only as prose. Nothing here is algorithmically hard;
 * the value is that every rule now has exactly one definition and this file is what keeps
 * it that way.
 *
 * The cases that look redundant are the ones that catch the historical drift, so each
 * carries the divergence it pins.
 */

import { describe, expect, test } from "bun:test";

import {
  branchBelongsToIssue,
  cacheSlug,
  fold,
  isIssueBranch,
  isRunWorktree,
  mintBranch,
  worktreeDirName,
} from "../src/naming";

describe("fold", () => {
  test("replaces every slash, not just the first", () => {
    // The case a `replace(…, count=1)` port gets wrong while every single-slash test in
    // the suite stays green.
    expect(fold("EXC-1/foo/bar")).toBe("EXC-1+foo+bar");
  });

  test("leaves a string with no slash untouched", () => {
    expect(fold("trunk")).toBe("trunk");
  });
});

describe("worktreeDirName", () => {
  test("folds the branch into a single flat directory name", () => {
    expect(worktreeDirName("EXC-1/add-thing")).toBe("EXC-1+add-thing");
  });

  test("does not mutate the branch it was given", () => {
    // The branch reaches `git worktree add -b` verbatim; only the directory folds. A
    // folded branch would create a literal `EXC-1+add-thing` ref.
    const branch = "EXC-1/add-thing";

    worktreeDirName(branch);

    expect(branch).toBe("EXC-1/add-thing");
  });
});

describe("isIssueBranch", () => {
  test("accepts a conventional run branch", () => {
    expect(isIssueBranch("EXC-992/naming-module")).toBe(true);
  });

  test("accepts a single-letter project key", () => {
    // The deliberate regex choice: `[A-Z][A-Z0-9]*-\d+` over `[A-Z][A-Z0-9]+-[0-9]+`.
    // The restrictive variant rejects this, which would make a real one-letter-key team's
    // worktrees invisible to the guard that gates edits inside them.
    expect(isIssueBranch("X-1/foo")).toBe(true);
  });

  test("accepts a digit inside the project key", () => {
    // Rejected by the `^[A-Z]+-\d+` variant that appears in prose.
    expect(isIssueBranch("S3-12/foo")).toBe(true);
  });

  test("rejects a branch that only contains an issue key further along", () => {
    // Python's `re.match` anchors at the start; JavaScript's `RegExp.test` does not. A
    // port that drops the `^` accepts this.
    expect(isIssueBranch("feature/EXC-1/foo")).toBe(false);
  });

  test("rejects a bare issue key with no separator", () => {
    expect(isIssueBranch("EXC-1")).toBe(false);
  });

  test("rejects a lowercase key", () => {
    expect(isIssueBranch("exc-1/foo")).toBe(false);
  });

  test("rejects a key with no number", () => {
    expect(isIssueBranch("EXC-/foo")).toBe(false);
  });

  test("rejects the default branch", () => {
    expect(isIssueBranch("trunk")).toBe(false);
  });
});

describe("isRunWorktree", () => {
  test("accepts the directory name that a run branch folds to", () => {
    expect(isRunWorktree("EXC-1+add-thing", "EXC-1/add-thing")).toBe(true);
  });

  test("rejects a directory name that does not match the branch", () => {
    // Both halves matter. This is what separates an isolation worktree from a
    // default-branch checkout that someone parked on a feature branch.
    expect(isRunWorktree("some-other-dir", "EXC-1/add-thing")).toBe(false);
  });

  test("rejects a matching directory whose branch carries no issue key", () => {
    expect(isRunWorktree("feature+thing", "feature/thing")).toBe(false);
  });

  test("rejects an unfolded directory name", () => {
    expect(isRunWorktree("EXC-1/add-thing", "EXC-1/add-thing")).toBe(false);
  });
});

describe("branchBelongsToIssue", () => {
  test("accepts the issue's own working branch", () => {
    expect(branchBelongsToIssue("EXC-1/add-thing", "EXC-1")).toBe(true);
  });

  test("does not let a short issue key claim a longer one's branch", () => {
    // The trailing separator is the whole point: on a bare `startsWith(issue)`, EXC-1
    // claims every EXC-1x branch in the container.
    expect(branchBelongsToIssue("EXC-10/add-thing", "EXC-1")).toBe(false);
  });

  test("rejects a bare issue key as its own working branch", () => {
    expect(branchBelongsToIssue("EXC-1", "EXC-1")).toBe(false);
  });

  test("rejects an unrelated issue's branch", () => {
    expect(branchBelongsToIssue("EXC-2/add-thing", "EXC-1")).toBe(false);
  });
});

describe("cacheSlug", () => {
  test("passes a plain issue key through unchanged", () => {
    expect(cacheSlug("EXC-992")).toBe("EXC-992");
  });

  test("flattens a path into a single filesystem-safe segment", () => {
    // Supersedes the fish `/` -> `_` form: every slash still folds, and the characters it
    // left alone are made safe too.
    expect(cacheSlug("/Users/j/GitLocal/wrk")).toBe("_Users_j_GitLocal_wrk");
  });

  test("keeps dots, underscores and dashes", () => {
    expect(cacheSlug("wrk-1.2_beta")).toBe("wrk-1.2_beta");
  });

  test("replaces a multibyte character once, not once per byte", () => {
    // The shell `tr -c` variant sanitized per byte, so this yielded three underscores.
    // Two implementations disagreeing on a cache key means they silently stop sharing
    // the cache.
    expect(cacheSlug("a😀b")).toBe("a_b");
  });
});

describe("mintBranch", () => {
  test("builds a branch from the issue key and a kebab-cased title", () => {
    expect(mintBranch("EXC-992", "Naming module and branch minting")).toBe(
      "EXC-992/naming-module-and-branch-minting",
    );
  });

  test("collapses punctuation runs into a single separator", () => {
    expect(mintBranch("EXC-1", "Fix:  the (broken) login — redirect!")).toBe(
      "EXC-1/fix-the-broken-login-redirect",
    );
  });

  test("mints a branch that its own predicates accept", () => {
    // The round trip is the rule that actually matters: a minted branch the guard does
    // not recognise produces a worktree nothing can edit, far from the cause.
    const branch = mintBranch("EXC-1", "Add worktree support");

    expect(isIssueBranch(branch)).toBe(true);
    expect(branchBelongsToIssue(branch, "EXC-1")).toBe(true);
  });

  test("caps the descriptive portion and leaves no trailing separator", () => {
    const branch = mintBranch("EXC-1", `${"a".repeat(20)} ${"b".repeat(40)}`);
    const slug = branch.slice("EXC-1/".length);

    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });

  test("falls back to a usable slug when the title survives slugification empty", () => {
    // `EXC-1/` is not a valid git ref and would fold to the directory `EXC-1+`.
    const branch = mintBranch("EXC-1", "😀 —— !!");

    expect(branch.endsWith("/")).toBe(false);
    expect(isIssueBranch(branch)).toBe(true);
  });

  test("suffixes the slug when the branch is already taken", () => {
    expect(mintBranch("EXC-1", "Add thing", ["EXC-1/add-thing"])).toBe("EXC-1/add-thing-2");
  });

  test("keeps counting past the first taken suffix", () => {
    expect(mintBranch("EXC-1", "Add thing", ["EXC-1/add-thing", "EXC-1/add-thing-2"])).toBe(
      "EXC-1/add-thing-3",
    );
  });

  test("ignores taken branches belonging to other issues", () => {
    expect(mintBranch("EXC-1", "Add thing", ["EXC-2/add-thing"])).toBe("EXC-1/add-thing");
  });

  test("rejects an issue key that would not survive its own predicates", () => {
    // Minting from a lowercase key silently produced a branch nothing recognised — the
    // comparison downstream is case-sensitive and never validated its input.
    expect(() => mintBranch("exc-1", "Add thing")).toThrow();
  });

  test("rejects an issue key carrying its own separator", () => {
    expect(() => mintBranch("EXC-1/x", "Add thing")).toThrow();
  });
});
