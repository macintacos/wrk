/**
 * The fuzzy matcher, pinned against fzf itself.
 *
 * The bulk of the value here is one test: replaying a corpus of cases frozen from the real
 * fzf v0.74.2 and asserting the port reproduces every score and every position. Nothing
 * about a Smith-Waterman port is verifiable by inspection — the scoring interacts with the
 * bonus matrix, the consecutive-chunk rule and a backtrace that has to break ties the same
 * way, and a port that is 99% right looks exactly like one that is 100% right until a
 * highlight lands on the wrong character.
 *
 * The corpus also stands in for the layers the port deliberately omits. It was generated
 * through fzf's public `FuzzyMatchV2` entry point, so fzf took its ASCII prefilter and its
 * one- and two-character fast paths on the cases where they apply, while the port takes its
 * single general path throughout. Every green row is a claim that those layers are the pure
 * optimisations fzf documents them to be.
 *
 * The hand-written cases below the replay are the ones a reader needs in order to
 * understand *why* the module exists; they are not trying to add coverage the corpus
 * already has.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { FZF_VERSION, fuzzyMatch } from "../src/fuzzy";

/** One frozen case. Mirrors the `record` struct in `tools/fzf-golden/main.go`. */
interface GoldenRecord {
  text: string;
  query: string;
  /** What fzf's smart-case rule decided, which the port has to re-derive. */
  caseSensitive: boolean;
  match: boolean;
  score: number;
  positions: number[];
}

const corpusLines = (await Bun.file(join(import.meta.dir, "fixtures", "fzf-golden.jsonl")).text())
  .trim()
  .split("\n");

/** The corpus's first line is a header naming the fzf release it was cut from. */
const header = JSON.parse(corpusLines[0] ?? "{}") as { fzf?: string };
const corpus = corpusLines.slice(1).map((line) => JSON.parse(line) as GoldenRecord);

/** Renders a case for a failure message; the pair alone is enough to reproduce it. */
function describeCase(record: GoldenRecord): string {
  return `${JSON.stringify(record.text)} × ${JSON.stringify(record.query)}`;
}

describe("the golden corpus", () => {
  test("was cut from the fzf release fuzzy.ts documents", () => {
    // The resync trigger is prose in fuzzy.ts's module doc; this is what stops the prose
    // from drifting away from the data silently.
    expect(header.fzf).toBe(FZF_VERSION);
  });

  test("is broad enough to be worth trusting", () => {
    expect(corpus.length).toBeGreaterThan(800);
    expect(corpus.filter((record) => record.match).length).toBeGreaterThan(500);
    expect(corpus.filter((record) => record.caseSensitive).length).toBeGreaterThan(100);
  });

  test("agrees with JavaScript on every smart-case decision", () => {
    // fzf derives case sensitivity with Go's `strings.ToLower`, which is a simple 1:1
    // mapping; `String#toLowerCase` is a full mapping that can expand a code point. The two
    // can therefore disagree on the *value* — this pins that they never disagree on the
    // *decision* for anything in the corpus, which is what fuzzyMatch actually branches on.
    const disagreements = corpus
      .filter((record) => (record.query.toLowerCase() !== record.query) !== record.caseSensitive)
      .map(describeCase);

    expect(disagreements).toEqual([]);
  });
});

describe("fuzzyMatch against the frozen fzf corpus", () => {
  test("reproduces every score and every position", () => {
    const failures: string[] = [];

    for (const record of corpus) {
      const got = fuzzyMatch(record.text, record.query);

      if (!record.match) {
        if (got !== null)
          failures.push(`${describeCase(record)}: expected no match, got ${got.score}`);
        continue;
      }
      if (got === null) {
        failures.push(`${describeCase(record)}: expected score ${record.score}, got no match`);
        continue;
      }
      if (got.score !== record.score) {
        failures.push(`${describeCase(record)}: score ${got.score} ≠ ${record.score}`);
      }
      if (JSON.stringify(got.positions) !== JSON.stringify(record.positions)) {
        failures.push(
          `${describeCase(record)}: positions ${JSON.stringify(got.positions)} ≠ ${JSON.stringify(record.positions)}`,
        );
      }
    }

    // Sliced first so a broken port reports ten readable lines rather than thousands.
    expect(failures.slice(0, 10)).toEqual([]);
    expect(failures).toHaveLength(0);
  });

  test("returns positions that are ascending and inside the text", () => {
    const failures: string[] = [];

    for (const record of corpus) {
      const got = fuzzyMatch(record.text, record.query);
      if (got === null) continue;

      const length = Array.from(record.text).length;
      const ordered = got.positions.every(
        (position, index) => index === 0 || position > (got.positions[index - 1] ?? -1),
      );
      const inRange = got.positions.every((position) => position >= 0 && position < length);

      if (!ordered || !inRange)
        failures.push(`${describeCase(record)}: ${JSON.stringify(got.positions)}`);
    }

    expect(failures).toEqual([]);
  });
});

describe("why this module exists rather than a greedy subsequence scan", () => {
  test("skips an earlier subsequence for the better-scoring later one", () => {
    // The case the issue is built on. Every picker row carries an issue-key prefix, and
    // `fzf` occurs twice in this branch name: once spread across `fuzzy…matcher…fzf` and
    // once as the literal run at 23. A greedy left-to-right scan takes the first `f` it
    // sees and highlights [9, 11, 23]; fzf's DP finds the consecutive run and highlights
    // the substring a human would have pointed at.
    expect(fuzzyMatch("EXC-1010/fuzzy-matcher-fzf-v2", "fzf")).toEqual({
      score: 80,
      positions: [23, 24, 25],
    });
  });

  test("does not latch onto the issue-key prefix every row carries", () => {
    // The failure mode the issue names outright. `c` appears at index 2, in `EXC`, so a
    // greedy scan answers [2, 19] and highlights the key rather than the word. fzf finds
    // the `ch` inside `matcher`.
    expect(fuzzyMatch("EXC-1010/fuzzy-matcher-fzf-v2", "ch")?.positions).toEqual([18, 19]);
    // Same shape on a PR title: `i` at 10 is inside `Picker`, but `identity` is the answer.
    expect(
      fuzzyMatch("EXC-1011 Picker: list, filter, highlight, identity", "id")?.positions,
    ).toEqual([42, 43]);
  });
});

describe("smart case", () => {
  test("an all-lowercase query matches case-insensitively", () => {
    expect(fuzzyMatch("camelCaseWord", "cw")?.positions).toEqual([0, 9]);
  });

  test("one uppercase character makes the whole query case-sensitive", () => {
    // Same two letters, but now only the capitals are eligible, so the match moves.
    expect(fuzzyMatch("camelCaseWord", "CW")?.positions).toEqual([5, 9]);
    // And a query that mixes cases has to match both exactly.
    expect(fuzzyMatch("camelCaseWord", "Cw")).toBeNull();
    expect(fuzzyMatch("lower-only-text", "Text")).toBeNull();
  });
});

describe("edge cases", () => {
  test("an empty query matches everything, with nothing highlighted", () => {
    expect(fuzzyMatch("anything", "")).toEqual({ score: 0, positions: [] });
    expect(fuzzyMatch("", "")).toEqual({ score: 0, positions: [] });
  });

  test("a query that is not a subsequence does not match", () => {
    expect(fuzzyMatch("abc", "acb")).toBeNull();
    expect(fuzzyMatch("abc", "abcd")).toBeNull();
    expect(fuzzyMatch("", "a")).toBeNull();
  });

  test("positions index code points, not UTF-16 units", () => {
    // The rocket is a surrogate pair, so its UTF-16 offset is 6 but so is its code-point
    // index here — the character *after* it is where the two coordinate systems diverge.
    expect(fuzzyMatch("emoji-🚀-launch", "🚀")?.positions).toEqual([6]);
    expect(fuzzyMatch("emoji-🚀-launch", "🚀l")?.positions).toEqual([6, 8]);
  });

  test("a titlecase letter is not folded, because Go's IsUpper excludes it", () => {
    // U+01C5 is category Lt. fzf lowers a character only when it classifies as upper, and
    // Go's unicode.IsUpper is Lu-only — so `ǅ` never folds to `ǆ`, while `Ǆ` (Lu) does.
    expect(fuzzyMatch("ǅ", "ǆ")).toBeNull();
    expect(fuzzyMatch("Ǆ", "ǆ")?.positions).toEqual([0]);
  });
});
