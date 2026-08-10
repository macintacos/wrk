/**
 * The `wt` engine: every worktree in this repository, annotated with where it sits in the PR
 * stack, offered as a picker whose answer is a path to `cd` into.
 *
 * This is the first command to consume [`@macintacos/wrk-picker`](../../picker/src/index.ts),
 * and it is a composition rather than an implementation: [`./git`](./git) enumerates the
 * worktrees, [`./pr`](./pr) supplies the pull requests, [`./stack`](./stack) turns those into
 * positions, [`./config`](./config) supplies the glyph and colour per position, and the picker
 * draws. What is decided here is which worktrees are worth offering and what each row says.
 *
 * **Three worktrees are never offered, for three different reasons.** The bare repository is
 * dropped before this module sees it — `parseWorktree` returns `null` for that record, because
 * a repository with no work tree is not a place to stand. The worktree the caller is *already*
 * in is dropped because moving there is not a move. And a **prunable** record is dropped
 * because its directory is gone: offering it hands the shell a `cd` that cannot succeed, which
 * is the same non-destination the bare repository is. `repo.ts`'s `checkoutFor` makes the
 * identical exclusion for the identical reason.
 *
 * **Annotation is best-effort and never speaks.** An absent, logged-out, offline or
 * rate-limited `gh` is an *answer* rather than a fault — `gh.ts` folds all four into one
 * "could not answer" — so `pullRequests` hands back an empty map and every row renders with
 * its branch name alone. The one thing it can still throw is an unreadable cache directory,
 * which {@link annotations} catches and reports through {@link debug}: a picker that cannot
 * find a pull request still has worktrees to show, and stderr belongs to the frame.
 *
 * **An un-annotated row carries one column, not five empty ones.** The picker sizes each
 * column across the whole row set and tolerates rows holding fewer of them, so a branch with
 * no pull request emits `[branch]` and renders identically to a picker that never looked —
 * where four empty trailing columns would render eight spaces of nothing. Leading columns
 * still align, because only trailing ones are absent.
 *
 * **The columns are branch, marker, number, position, title, and only the marker is
 * coloured.** The branch leads because it is the row's identity, is unique across worktrees,
 * and is what the annotation joins on; its folded directory name (`EXC-1+thing` for
 * `EXC-1/thing`) says the same thing less clearly, so it is not shown beside it. The marker
 * sits at the boundary between the branch and its pull request, where a glance answers "where
 * in the stack" before "which pull request". The title is last because it is the longest, and
 * the picker truncates from the right — so what a narrow terminal costs is the least
 * identifying field. Colour is spent once, on the marker, which is the literal reading of
 * `config.glyphs` and `config.colours` being one value *per stack position*.
 *
 * **Cancelling is not this module's to signal.** {@link chooseWorktree} answers `null`, and
 * the command converts that to a {@link Cancelled} — see [`./errors`](./errors) for why the
 * throw belongs to the action rather than to anything under it.
 *
 * @packageDocumentation
 */

import { NotATerminal, type PickerColumn, type PickerRow, pick } from "@macintacos/wrk-picker";

import { type ByStackPosition, loadConfig, type WrkConfig } from "./config";
import { type Cancelled, Refusal } from "./errors";
import type { PullRequest } from "./gh";
import { listWorktrees, showToplevel, type Worktree } from "./git";
import { debug, note, PREFIX } from "./output";
import { pullRequests } from "./pr";
import { containerFor } from "./repo";
import { type StackNode, stackGraph } from "./stack";

/** The prefix `listWorktrees` reports branch refs with, and everything else joins without. */
const BRANCH_PREFIX = "refs/heads/";

/** How much of a detached worktree's commit is shown — git's own abbreviation length. */
const SHORT_SHA = 7;

/**
 * The cache entry whose staleness threshold the annotation is read at.
 *
 * The literal `pr.ts` files its rows under and `config.ts` exposes as a tunable, spelled here
 * rather than imported because it is the *user's* key: someone configuring
 * `cache.ttls."pr-graph"` is configuring this read.
 */
const ENTRY = "pr-graph";

/**
 * What choosing a row means: where to go, and what is checked out there.
 *
 * **`worktree_path` is snake_case deliberately**, as `Created.worktree_path` is: this type is
 * serialised straight into the run's JSON envelope, so the property name is the field name.
 * The properties are declared in the order the envelope emits them.
 *
 * Deliberately **not** the picker's payload, which is the path alone — see
 * {@link worktreeRows}.
 */
export interface Chosen {
  /** Absolute path of the worktree to move to. */
  worktree_path: string;

  /** The branch checked out there, short, or `null` on a detached HEAD. */
  branch: string | null;
}

/**
 * Which stack positions carry a marker — `config.ts`'s three, by name.
 *
 * Deliberately not `Position`, which `stack.ts` already uses internally for something else
 * entirely — a root ref and a depth. One file reading both should not have to notice.
 */
type Marked = keyof ByStackPosition;

/** A branch ref without its `refs/heads/`, which is how `gh` and the stack graph key on it. */
function short(ref: string): string {
  return ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : ref;
}

/**
 * What a row is called: its branch, or its commit when there is no branch.
 *
 * A detached worktree is a real destination and is rendered rather than skipped. The commit is
 * the only stable thing it has — its directory name is whatever it was created as, and would
 * read as a branch name that no longer exists.
 *
 * The `?? "HEAD"` is a total lookup rather than a case expected to fire: `Worktree.head` is
 * `null` only on an unborn branch, which by definition has a branch and so never reaches here.
 */
function label(worktree: Worktree): string {
  if (worktree.branch !== null) return short(worktree.branch);

  return `(detached ${worktree.head?.slice(0, SHORT_SHA) ?? "HEAD"})`;
}

/** {@link Chosen} for one worktree — the payload a row carries, and the single-candidate answer. */
function chosen(worktree: Worktree): Chosen {
  return {
    worktree_path: worktree.path,
    branch: worktree.branch === null ? null : short(worktree.branch),
  };
}

/**
 * Which of the three markers a row takes, or `null` for none.
 *
 * A merged branch is marked from its **row's own state** rather than from a position, since
 * `stack.ts` builds its edges from open pull requests only and a merged branch is therefore in
 * no stack at all. A middle layer takes no marker while still reporting its position — being
 * neither end is exactly what there is to say about it.
 *
 * @param node - The branch's place in its stack, or `undefined` when it has none *worth
 *   drawing* — which {@link annotate} decides, so that "a one-layer stack is not a stack" is
 *   settled once rather than here and again at the position column.
 */
function marker(pull: PullRequest, node: StackNode | undefined): Marked | null {
  if (pull.state === "MERGED") return "merged";
  if (node === undefined) return null;
  if (node.top) return "top";

  return node.depth === 1 ? "bottom" : null;
}

/**
 * The four annotation columns for one branch, or none at all when it carries no pull request.
 *
 * An empty array rather than four empty columns — see this module's header for why that is the
 * difference between degrading and merely looking degraded.
 *
 * **`stacked` is where the issue's constraint lives**: a one-layer stack gets neither a
 * position nor a marker, because there is no "where am I" to answer and marking it both the
 * top and the bottom would say nothing. `height > 1` is the whole test, since `stackGraph` has
 * already dropped merged and cyclic branches — and it is computed once here rather than in
 * both {@link marker} and the position column, which could otherwise drift into disagreeing.
 */
function annotate(
  branch: string,
  prs: ReadonlyMap<string, PullRequest>,
  stack: ReadonlyMap<string, StackNode>,
  config: WrkConfig,
): PickerColumn[] {
  const pull = prs.get(branch);
  if (pull === undefined) return [];

  const node = stack.get(branch);
  const stacked = node !== undefined && node.height > 1 ? node : undefined;
  const position = marker(pull, stacked);

  return [
    position === null
      ? { text: "" }
      : { text: config.glyphs[position], color: config.colours[position] },
    { text: `#${pull.number}` },
    { text: stacked === undefined ? "" : `${stacked.depth}/${stacked.height}` },
    { text: pull.title },
  ];
}

/**
 * The worktrees worth offering: not the one the caller is in, and not one that is gone.
 *
 * @param worktrees - Every worktree, as `listWorktrees` reports them. The bare repository is
 *   already absent from that list.
 * @param here - Root of the worktree the caller is standing in, or `null` when they are in
 *   none — the container, or `<container>/.bare`, where nothing is filtered because there is
 *   nothing they are already at.
 * @returns The offerable worktrees, in the order git reported them.
 */
export function candidates(worktrees: readonly Worktree[], here: string | null): Worktree[] {
  return worktrees.filter((worktree) => worktree.prunable === null && worktree.path !== here);
}

/**
 * One picker row per worktree, annotated wherever the stack graph has something to say.
 *
 * The graph is built here rather than passed in, so the rows and the positions drawn on them
 * cannot be derived from two different sets of pull requests.
 *
 * **The payload is the worktree's path.** `PickerRow.payload` has to be unique across the
 * rows, because the cursor resolves to the first `===` hit and a duplicate makes every later
 * row carrying it unreachable — and git guarantees that by never listing two worktrees at one
 * path, where a `{ worktree_path, branch }` object would rely on nobody rebuilding it. That
 * second half is not idle: the same contract requires a payload to still compare `===` after a
 * row-set replacement, which is how EXC-1017 will push annotations in behind the draw. A
 * string satisfies it today and will still satisfy it then. {@link chooseWorktree} maps the
 * path back to the answer it emits.
 *
 * @param offered - The worktrees to draw, as {@link candidates} answered.
 * @param prs - Pull requests by head ref, as `pullRequests` returns them. An empty map is the
 *   un-annotated case and is not an error.
 * @param config - Supplies the glyph and colour for each stack position.
 * @returns One row per worktree, carrying its absolute path as the payload.
 */
export function worktreeRows(
  offered: readonly Worktree[],
  prs: ReadonlyMap<string, PullRequest>,
  config: WrkConfig,
): PickerRow<string>[] {
  const stack = stackGraph(prs);

  return offered.map((worktree) => ({
    payload: worktree.path,
    columns: [
      { text: label(worktree) },
      ...(worktree.branch === null ? [] : annotate(short(worktree.branch), prs, stack, config)),
    ],
  }));
}

/**
 * The repository's pull requests, or an empty map if they could not be read at all.
 *
 * `background` because this draws on a keystroke: a stale graph now beats a fresh one in three
 * seconds, and `pr.ts` names a picker as the caller that option exists for.
 *
 * The `catch` covers the one failure `pullRequests` documents as its own — an unreadable cache
 * directory — and deliberately not `gh` being unable to answer, which never reaches here.
 * {@link debug} rather than {@link note}: an annotation that silently did not happen is
 * invisible downstream, so the line has to be available in the field, but it is not something
 * to put on stderr in front of a picker the user is about to read.
 */
async function annotations(
  container: string,
  config: WrkConfig,
): Promise<Map<string, PullRequest>> {
  try {
    // The `??` is `noUncheckedIndexedAccess` demanding a total lookup, not a real absence:
    // `loadConfig` seeds every key `DEFAULTS` carries and this is one of them. `0` is the
    // honest value for the branch that cannot fire — refresh on every read, which is correct
    // and merely slower — the same call `preview.ts` makes for the same key.
    return await pullRequests(container, config.cache.ttls[ENTRY] ?? 0, { background: true });
  } catch (error) {
    debug(
      `the pull-request graph could not be read, so rows render un-annotated: ${String(error)}`,
    );

    return new Map();
  }
}

/**
 * Offers the repository's other worktrees and answers the one chosen.
 *
 * **One candidate skips the picker entirely.** Drawing a list of one and asking someone to
 * confirm it is ceremony; the destination is already decided. The reason is said on stderr
 * through {@link note}, because a picker that never appeared is otherwise indistinguishable
 * from one that failed to draw.
 *
 * **No candidate is a {@link Refusal}, not an empty picker.** There is no answer to give — a
 * picker with no rows would resolve `null`, which every caller maps to a cancellation, and the
 * user would be told nothing at all.
 *
 * @param cwd - Anywhere in the repository: a checkout, a run worktree, or the container.
 * @returns The chosen worktree, or `null` if the picker was dismissed. `null` covers Escape,
 *   `Ctrl-C` and Enter on an empty result set alike, which is what `pick` promises.
 * @throws {@link Refusal} if `cwd` is in no repository, if there is nowhere else to go, or if
 *   there is no terminal to draw in — the picker refuses at the door rather than rendering
 *   something that accepts no keystroke, and this is where that refusal takes `wrk`'s
 *   vocabulary.
 * @throws {@link Cancelled} never — see this module's header.
 *
 * @example
 * ```ts
 * const chosen = await chooseWorktree(process.cwd());
 * if (chosen === null) throw new Cancelled("the worktree picker was dismissed");
 * emitLine(chosen.worktree_path);
 * ```
 */
export async function chooseWorktree(cwd: string): Promise<Chosen | null> {
  const container = await containerFor(cwd);
  if (container === null) {
    throw new Refusal("not a git repository; run this from inside the repository to look around");
  }

  // Concurrent with each other, but not with the `containerFor` above them, which has to have
  // answered first: `listWorktrees` throws outside a repository rather than reporting it, so
  // folding all three together would turn the refusal above into git's own exit 128. The same
  // ordering, for the same reason, as `repo.ts`'s `checkoutFor`.
  const [here, all] = await Promise.all([showToplevel(cwd), listWorktrees(cwd)]);
  const offered = candidates(all, here);

  const only = offered[0];
  if (only === undefined) {
    throw new Refusal("this repository has no other worktree to go to");
  }
  if (offered.length === 1) {
    note(`${PREFIX}${label(only)} is the only worktree on offer, so there was nothing to pick`);

    return chosen(only);
  }

  const config = await loadConfig({ container });
  const answers = new Map(offered.map((worktree) => [worktree.path, chosen(worktree)]));

  try {
    const path = await pick({
      rows: worktreeRows(offered, await annotations(container, config), config),
    });

    // The `??` is unreachable — every payload came out of a row built from `offered` on the
    // line above — and is spelled as a dismissal rather than asserted away because that is the
    // one outcome a `cd` protocol can take safely: exit 130, stdout empty, nobody moved.
    return path === null ? null : (answers.get(path) ?? null);
  } catch (error) {
    // The picker's own sentence says which stream is not a terminal, which is the whole of
    // what a user needs; wrapping it is only about the exit status and the `wrk: ` prefix.
    if (error instanceof NotATerminal) throw new Refusal(error.message);

    throw error;
  }
}
