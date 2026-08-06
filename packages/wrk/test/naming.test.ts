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

import { Refusal } from "../src/errors";
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
  // The fold is asserted by regex throughout, with the digest matched as opaque hex. The
  // fold is this suite's subject and stays pinned character for character; the digest's
  // value is arithmetic nobody should have to re-derive to read a test.
  test("passes a plain issue key through, suffixed", () => {
    expect(cacheSlug("EXC-992")).toMatch(/^EXC-992-[0-9a-f]{8}$/);
  });

  test("flattens a path into a single filesystem-safe segment", () => {
    // Supersedes the fish `/` -> `_` form: every slash still folds, and the characters it
    // left alone are made safe too.
    expect(cacheSlug("/Users/j/GitLocal/wrk")).toMatch(/^_Users_j_GitLocal_wrk-[0-9a-f]{8}$/);
  });

  test("keeps dots, underscores and dashes", () => {
    expect(cacheSlug("wrk-1.2_beta")).toMatch(/^wrk-1\.2_beta-[0-9a-f]{8}$/);
  });

  test("replaces a multibyte character once, not once per code unit", () => {
    // U+1F600 is four UTF-8 bytes and two UTF-16 code units, so a byte-wise sanitizer
    // yields four underscores and a `u`-less regex yields two. Callers that disagree on a
    // cache key do not error — they silently stop sharing the cache.
    expect(cacheSlug("a😀b")).toMatch(/^a_b-[0-9a-f]{8}$/);
  });

  test("does not emit a key that would climb out of the cache directory", () => {
    // `.` and `..` survive the allowed alphabet intact, so a key joined onto a cache root
    // would resolve to the parent directory. Slashes fold, so one level is the whole
    // exposure — but this function's callers are entitled to treat its output as inert.
    // The suffix is what rules both out, and the same suffix keeps them apart. Anchored,
    // like every other case here: `not.toBe("..")` would be satisfied by `../x-deadbeef`,
    // which is the traversal itself.
    expect(cacheSlug("..")).toMatch(/^\.\.-[0-9a-f]{8}$/);
    expect(cacheSlug(".")).toMatch(/^\.-[0-9a-f]{8}$/);
  });

  test("keeps dots that are not the entire key", () => {
    expect(cacheSlug("v1.2.3")).toMatch(/^v1\.2\.3-[0-9a-f]{8}$/);
  });

  test("does not give two containers differing only by separator the same slug", () => {
    // The fold sends `/` and a literal `_` to the same character, so on the folded form
    // alone these two repositories share one cache entry and each is served the other's
    // data — with no error anywhere, because both agree on the key.
    expect(cacheSlug("/Users/me/GitLocal/thing")).not.toBe(cacheSlug("/Users/me/GitLocal_thing"));
  });

  test("is stable across calls, so two processes agree on an entry", () => {
    // The whole point of the cache. A disambiguator drawn from the environment rather
    // than the key — a counter, a pid, a timestamp — would satisfy every case above and
    // give each process its own private cache.
    expect(cacheSlug("/Users/me/GitLocal/thing")).toBe(cacheSlug("/Users/me/GitLocal/thing"));
  });

  test("caps the segment at NAME_MAX, digest intact", () => {
    // Without the cap, a container path this deep produces a segment past 255 and every
    // read and write for that repository fails ENAMETOOLONG, with nothing degrading.
    const deep = `/Users/me/${"nested/".repeat(50)}repo`;

    expect(cacheSlug(deep)).toHaveLength(255);
    expect(cacheSlug(deep)).toMatch(/-[0-9a-f]{8}$/);
  });

  test("separates two containers whose folded prefixes truncate to the same thing", () => {
    // The head of the folded prefix is what gets cut, so these two survive truncation
    // identical and collide on everything but the digest — which is exactly the collision
    // the digest exists to close, reintroduced the moment it is computed from the cut
    // prefix rather than from the untouched key. Switching the cut to the head means
    // flipping these two paths to differ in their tails.
    const withoutDigest = (key: string) => cacheSlug(key).replace(/-[0-9a-f]{8}$/, "");
    const a = `/one/${"x".repeat(300)}`;
    const b = `/two/${"x".repeat(300)}`;

    expect(withoutDigest(a)).toBe(withoutDigest(b));
    expect(cacheSlug(a)).not.toBe(cacheSlug(b));
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

  test("caps the descriptive portion at 40 characters", () => {
    expect(mintBranch("EXC-1", "z".repeat(60))).toBe(`EXC-1/${"z".repeat(40)}`);
  });

  test("re-strips the separator that the cap cut exposed", () => {
    // The slug is 39 `a`s, a separator, then `b`s — so the cut at 40 lands exactly on the
    // separator. Without the re-strip this mints the branch `EXC-1/aaa…a-`, and a title
    // whose 41st character happens to be a space is not a rare shape.
    expect(mintBranch("EXC-1", `${"a".repeat(39)} ${"b".repeat(10)}`)).toBe(
      `EXC-1/${"a".repeat(39)}`,
    );
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
    // The downstream comparison is case-sensitive and does not normalise, so a lowercase
    // key would mint a branch nothing recognises.
    //
    // The class is asserted, not merely that it throws: a bare `Error` reaches
    // `reportFailure` unrecognised and is rethrown, so a typed key — user input — would
    // print a stack trace instead of the one `wrk:` line the contract promises.
    expect(() => mintBranch("exc-1", "Add thing")).toThrow(Refusal);
  });

  test("rejects an issue key carrying its own separator", () => {
    expect(() => mintBranch("EXC-1/x", "Add thing")).toThrow(Refusal);
  });

  test("rejects a key typed without its hyphen", () => {
    // The typo the bug report was filed on. It is the shape a human actually produces, and
    // the one that made the wrong error class visible.
    expect(() => mintBranch("EXC996", "Some title")).toThrow(Refusal);
  });
});
