/**
 * The stacked-pull-request graph, reconstructed client-side.
 *
 * GitHub has no stack object. A stack exists only as the chain of `baseRefName` → `headRefName`
 * edges between pull requests, so anything that wants to answer "where am I in this stack" has to
 * rebuild it from the rows [`./pr`](./pr) already caches. This module is that rebuild and nothing
 * else: one pure function, no `gh`, no cache, no I/O. It imports a type and no runtime value.
 *
 * **Open pull requests only.** The map `pr.ts` returns holds merged rows too, so the picker can
 * mark a branch whose work has landed. Those rows are filtered out before a single edge is built,
 * which is what makes merged layers **drop out by construction** rather than by a rule: a chain
 * whose bottom two layers have merged has an open root at depth 1 and a height counting only what
 * is still open. The merged marker itself is `state === "MERGED"` on a row the caller already
 * holds, so it is not a position in this graph and {@link StackNode} has no field for it.
 *
 * **Depth is per node; height is keyed on the root.** Every node resolves to the root it descends
 * from and its distance above it, and a stack's height is the greatest depth any node sharing that
 * root reaches. Keying on the root is what makes a straight chain agree on its height throughout —
 * a height computed from each node's own subtree would have every layer of one stack reporting a
 * different total, so "2 of 3" and "3 of 3" would not be describing the same thing.
 *
 * **A fork is legal, and it means two things.** Two pull requests based on the same head ref are
 * what a stack looks like the moment someone branches twice off one layer, so it is not an error.
 * Both arms are tips and **both carry the top marker** — which is why {@link StackNode.top} is a
 * field rather than something a caller derives, since the obvious derivation `depth === height` is
 * right only on a straight chain and silently denies the shorter arm its marker. And the height a
 * fork reports is the **tallest** arm's, so the short arm reads "2 of 3": position and height
 * answer two different questions, and the tallest arm is the honest answer to "how tall is this
 * stack".
 *
 * **A cycle is detected, not capped.** A pull request can be retargeted at a branch further up its
 * own chain, and the result is a base chain that never reaches a root. Such a node has no honest
 * depth, so it is **omitted from the answer entirely** — a case every consumer already handles,
 * because it is indistinguishable from a branch carrying no pull request at all, and it renders
 * un-annotated rather than wrong. This replaces a fixed hop cap, which got both halves backwards:
 * it rendered a two-node cycle at full depth, reading as a very deep stack, and it truncated a
 * legitimately deep one. There is no cap here, so a stack resolves however tall it is.
 *
 * @packageDocumentation
 */

import type { PullRequest } from "./gh";

/** Where one branch sits in its stack. */
export interface StackNode {
  /**
   * Which layer this branch is, counting the bottom-most **open** layer as 1.
   *
   * A depth of 1 is therefore the bottom unmerged layer — the position the picker marks — without
   * anything having to ask which layers merged, per this module's header.
   */
  depth: number;

  /**
   * How many layers the stack this branch belongs to has, counting only open ones.
   *
   * Keyed on the stack's root rather than on this node, so every layer of one stack reports the
   * same number and `depth` of `height` reads as a position. A `height` of 1 is a one-layer
   * stack, which is not a stack: there is no position to report and no marker to draw.
   */
  height: number;

  /**
   * Whether nothing else in the graph is stacked on this branch.
   *
   * True for every tip, which on a fork means more than one node — see this module's header for
   * why that makes this a field rather than a caller's `depth === height`.
   */
  top: boolean;
}

/**
 * A node's place in the graph, as the walk resolves it.
 *
 * Internal, and deliberately not {@link StackNode}: height is not knowable until every node has
 * been resolved, and `root` is scaffolding for computing it rather than something a caller wants.
 */
interface Position {
  /** Head ref of the bottom-most open layer this node descends from. */
  root: string;

  /** Layers from that root to this node, inclusive. */
  depth: number;
}

/**
 * Resolves `start` and every unresolved node between it and its root, into `resolved`.
 *
 * Walks up base edges collecting a path, then assigns depths back down it. Three ways the walk
 * ends, and they are the three cases: it steps off the open set, so the last node walked is a
 * root; it reaches a node already resolved, whose answer the path continues from; or it revisits
 * a ref it stepped through on **this** walk, which is the cycle.
 *
 * `null` in `resolved` is the cyclic verdict, and it propagates for free — a node below a cycle
 * walks into it, finds that `null` memoised, and takes the same verdict.
 *
 * Each node is walked through once across the whole build, since the memo is consulted before any
 * step, so the graph costs one pass over the open pull requests rather than one per stack.
 */
function resolve(
  open: ReadonlyMap<string, PullRequest>,
  start: string,
  resolved: Map<string, Position | null>,
): void {
  const path: string[] = [];
  const walked = new Set<string>();
  let anchor: Position | null | undefined;
  let head: string | undefined = start;

  while (head !== undefined) {
    if (resolved.has(head)) {
      anchor = resolved.get(head);
      break;
    }
    if (walked.has(head)) {
      anchor = null;
      break;
    }

    path.push(head);
    walked.add(head);

    // Annotated rather than inferred: `head` is assigned from this line and this line reads
    // `head`, so leaving it to inference makes the two circular and TypeScript gives up (TS7022).
    const base: string | undefined = open.get(head)?.baseRefName;
    head = base !== undefined && open.has(base) ? base : undefined;
  }

  if (anchor === null) {
    for (const ref of path) resolved.set(ref, null);

    return;
  }

  // `anchor` is undefined exactly when the walk stepped off the open set, which makes the last ref
  // pushed the root at depth 1 — the `??=` below is what picks it up, on the first iteration of a
  // path reversed to run bottom-up.
  path.reverse();
  let depth = anchor?.depth ?? 0;
  let root = anchor?.root;

  for (const ref of path) {
    depth += 1;
    root ??= ref;
    resolved.set(ref, { root, depth });
  }
}

/**
 * The stack each open pull request belongs to, and where in it that branch sits.
 *
 * @param prs - Pull requests keyed by head ref, as [`./pr`](./pr)'s `pullRequests` returns them.
 * Merged rows may be present and are ignored — see this module's header.
 * @returns One {@link StackNode} per open pull request whose base chain terminates, keyed by the
 * same head ref. A branch on a cycle is **absent** rather than carrying a placeholder, which is
 * the same thing a caller sees for a branch with no pull request at all.
 *
 * @example
 * ```ts
 * const stack = stackGraph(await pullRequests(container, ttl));
 * const here = stack.get(await currentBranch());
 * // A one-layer stack has no position worth drawing, per StackNode.height.
 * const position = here === undefined || here.height === 1 ? "" : `${here.depth}/${here.height}`;
 * ```
 */
export function stackGraph(prs: ReadonlyMap<string, PullRequest>): Map<string, StackNode> {
  const open = new Map<string, PullRequest>();
  for (const [head, row] of prs) {
    if (row.state === "OPEN") open.set(head, row);
  }

  const resolved = new Map<string, Position | null>();
  for (const head of open.keys()) resolve(open, head, resolved);

  const heights = new Map<string, number>();
  const covered = new Set<string>();
  for (const [head, position] of resolved) {
    if (position === null) continue;

    heights.set(position.root, Math.max(heights.get(position.root) ?? 0, position.depth));

    // A resolved node's base is resolved too — its chain terminates — so this can never mark a
    // cyclic node as covered, and `covered` needs no filtering afterwards.
    const base = open.get(head)?.baseRefName;
    if (base !== undefined && open.has(base)) covered.add(base);
  }

  const graph = new Map<string, StackNode>();
  for (const [head, position] of resolved) {
    if (position === null) continue;

    graph.set(head, {
      depth: position.depth,
      // The fallback is unreachable — every node here contributed its own depth to `heights` above
      // — and is spelled as the node's own depth rather than asserted away, since a node is at
      // least as tall as itself whatever else is in its stack.
      height: heights.get(position.root) ?? position.depth,
      top: !covered.has(head),
    });
  }

  return graph;
}
