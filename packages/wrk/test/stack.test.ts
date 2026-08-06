/**
 * The stack graph, pinned: what a layer's position is, what a fork means, and what happens to a
 * chain that eats its own tail.
 *
 * Nothing is mocked and nothing is stubbed, because there is nothing to stub — `stackGraph` is a
 * pure function over the map [`../src/pr`](../src/pr) already returns, so every case here is a
 * literal input and a literal expectation. That is the whole reason the graph is a function
 * rather than a method on the cache: this suite needs no `gh`, no temp directory and no clock.
 *
 * The cases divide into three groups. The **annotation cases** are the ones the worktree picker
 * draws from — a lone layer, a straight chain, a chain whose bottom has merged — and they pin the
 * arithmetic behind the `top` / `bottom` / `merged` glyphs `config.ts` carries. The **fork cases**
 * pin a decision rather than an inheritance: which nodes are tops when a stack branches, and what
 * height the short arm reports. The **cycle cases** are the ones the fixed hop cap this replaces
 * gets wrong in both directions — a two-node cycle, which the cap renders at full depth instead of
 * refusing, and a chain deeper than the cap, which it silently truncates.
 *
 * The last case feeds one fixture set in two insertion orders. The walk memoises, so a memo keyed
 * or seeded by the order nodes are first visited in would pass every case above while producing a
 * different graph for the same repository depending on what `gh` happened to return first.
 */

import { describe, expect, test } from "bun:test";

import type { PullRequest, PullRequestState } from "../src/gh";
import { type StackNode, stackGraph } from "../src/stack";

/** Distinct pull-request numbers across the suite. The graph never reads one; a duplicate would
 * still make a fixture a lie, and lying fixtures are how a suite stops describing reality. */
let counter = 0;

/**
 * One pull-request row, with only the two fields the graph reads spelled out.
 *
 * `number`, `title` and `updatedAt` are filled with anything valid: they are what
 * {@link PullRequest} requires and what `pr.ts` deduplicates on, and neither is an input to a
 * single question this module answers.
 */
function pr(
  headRefName: string,
  baseRefName: string,
  state: PullRequestState = "OPEN",
): PullRequest {
  counter += 1;

  return {
    number: counter,
    title: `pull request for ${headRefName}`,
    headRefName,
    baseRefName,
    state,
    updatedAt: "2026-08-05T12:00:00Z",
  };
}

/**
 * Builds the graph from rows, keying them exactly as `pr.ts` does.
 *
 * Going through the same head-ref key the producer uses is what keeps this suite honest about the
 * input shape — a helper that indexed rows some other way would test a map this module never
 * actually receives.
 */
function graphOf(...rows: PullRequest[]): Map<string, StackNode> {
  return stackGraph(new Map(rows.map((row) => [row.headRefName, row])));
}

describe("stackGraph", () => {
  test("answers an empty graph for no pull requests", () => {
    expect(graphOf().size).toBe(0);
  });

  test("puts a lone pull request at the bottom and the top of a one-layer stack", () => {
    // The one-layer case: depth and height agree at 1, which is how the picker knows to draw no
    // marker at all — there is no "where am I" to answer.
    expect(graphOf(pr("solo", "trunk"))).toEqual(
      new Map([["solo", { depth: 1, height: 1, top: true }]]),
    );
  });

  test("numbers a straight chain from the bottom and gives every layer the same height", () => {
    const graph = graphOf(pr("one", "trunk"), pr("two", "one"), pr("three", "two"));

    expect(graph).toEqual(
      new Map([
        ["one", { depth: 1, height: 3, top: false }],
        ["two", { depth: 2, height: 3, top: false }],
        ["three", { depth: 3, height: 3, top: true }],
      ]),
    );
  });

  test("drops merged layers from under a stack rather than counting them", () => {
    // The bottom two layers have landed. The height is 2 rather than 4, and the lowest open layer
    // is the bottom — which is what makes the picker's "bottom unmerged layer" marker fall out of
    // the depth rather than needing a rule of its own.
    const graph = graphOf(
      pr("one", "trunk", "MERGED"),
      pr("two", "one", "MERGED"),
      pr("three", "two"),
      pr("four", "three"),
    );

    expect(graph).toEqual(
      new Map([
        ["three", { depth: 1, height: 2, top: false }],
        ["four", { depth: 2, height: 2, top: true }],
      ]),
    );
  });

  test("severs a chain at a merged layer in the middle of it", () => {
    // Whoever merged the middle layer split one stack into two, and this says so rather than
    // pretending the survivors are still stacked: `three` bases on a ref no open pull request
    // carries, so it is a root of its own.
    const graph = graphOf(pr("one", "trunk"), pr("two", "one", "MERGED"), pr("three", "two"));

    expect(graph).toEqual(
      new Map([
        ["one", { depth: 1, height: 1, top: true }],
        ["three", { depth: 1, height: 1, top: true }],
      ]),
    );
  });

  test("gives a fork two tops and one height", () => {
    // `two` and `three` both base on `one`; `four` sits above `two`. Every node reports height 3 —
    // the tallest arm — while `three` sits at depth 2, so it reads "2 of 3". Both `three` and
    // `four` are tips and both carry the top marker; a consumer testing `depth === height` for
    // that would deny `three` its marker while getting `four` right.
    const graph = graphOf(
      pr("one", "trunk"),
      pr("two", "one"),
      pr("three", "one"),
      pr("four", "two"),
    );

    expect(graph).toEqual(
      new Map([
        ["one", { depth: 1, height: 3, top: false }],
        ["two", { depth: 2, height: 3, top: false }],
        ["three", { depth: 2, height: 3, top: true }],
        ["four", { depth: 3, height: 3, top: true }],
      ]),
    );
  });

  test("keeps two unrelated stacks from sharing a height", () => {
    // Both are rooted on the default branch and neither is an ancestor of the other, so the taller
    // one must not lend its height to the shorter — the failure a height computed per repository
    // rather than per root would produce.
    const graph = graphOf(
      pr("tall-one", "trunk"),
      pr("tall-two", "tall-one"),
      pr("short", "trunk"),
    );

    expect(graph).toEqual(
      new Map([
        ["tall-one", { depth: 1, height: 2, top: false }],
        ["tall-two", { depth: 2, height: 2, top: true }],
        ["short", { depth: 1, height: 1, top: true }],
      ]),
    );
  });

  test("omits a two-node cycle instead of capping it", () => {
    // The case the hop cap gets exactly backwards: it renders both rows at the cap, which reads as
    // a very deep stack. Neither node has an honest depth, so neither gets one, and the picker
    // draws them the way it draws a branch with no pull request at all.
    expect(graphOf(pr("ping", "pong"), pr("pong", "ping")).size).toBe(0);
  });

  test("omits a pull request based on its own branch", () => {
    expect(graphOf(pr("ouroboros", "ouroboros")).size).toBe(0);
  });

  test("omits a layer stacked on top of a cycle, and keeps the stacks beside it", () => {
    // Walking up from `above` re-enters the cycle, so it has no honest depth either — but the
    // unrelated stack in the same repository is untouched, which is what stops one malformed pull
    // request from blanking every annotation in the picker.
    const graph = graphOf(
      pr("ping", "pong"),
      pr("pong", "ping"),
      pr("above", "ping"),
      pr("elsewhere", "trunk"),
    );

    expect(graph).toEqual(new Map([["elsewhere", { depth: 1, height: 1, top: true }]]));
  });

  test("resolves a stack far deeper than any hop cap without truncating it", () => {
    // Fed **top-down**, which is the order that makes this case bite. The walk memoises, so rows
    // arriving bottom-up resolve in one step each and no single walk is ever more than one hop
    // long — a capped walk would sail through that. `gh` is asked for `sort:updated-desc` and the
    // layer someone is working on is the one that was just updated, so top-down is also the order
    // this really arrives in.
    const rows = Array.from({ length: 25 }, (_, index) =>
      pr(`layer-${index + 1}`, index === 0 ? "trunk" : `layer-${index}`),
    ).reverse();

    const graph = graphOf(...rows);

    expect(graph.size).toBe(25);
    expect(graph.get("layer-1")).toEqual({ depth: 1, height: 25, top: false });
    expect(graph.get("layer-25")).toEqual({ depth: 25, height: 25, top: true });
  });

  test("answers the same graph whichever order the rows arrive in", () => {
    const rows = [pr("one", "trunk"), pr("two", "one"), pr("three", "one"), pr("four", "two")];

    expect(graphOf(...rows)).toEqual(graphOf(...[...rows].reverse()));
  });
});
