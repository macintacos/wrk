/**
 * The `pr` engine: this repository's open pull requests, offered as a picker with `gh`'s own
 * rendering beside them, whose answer is a worktree to `cd` into — created and checked out if
 * there is not one already.
 *
 * Named for the command it implements, one letter short of it: [`./pr`](./pr) is the cache this
 * reads through, and it was there first. A reader looking for `wrk pr`'s engine finds that file
 * first and this one second, which is the wrong way round and the price of not renaming a
 * module three landed branches already import.
 *
 * The second command to consume [`@macintacos/wrk-picker`](../../picker/src/index.ts), and
 * like [`./wt`](./wt) it is a composition rather than an implementation: [`./pr`](./pr)
 * supplies the pull requests, [`./preview`](./preview) supplies the pane, [`./git`](./git)
 * says which worktrees exist and creates the new one, and [`./gh`](./gh) checks the pull
 * request out into it. What is decided here is the order the rows come in, what each says, and
 * the three shapes the destination can take.
 *
 * **The pull requests are read through the cache, never through the adapter.** That is the
 * whole of the never-block-on-`gh` invariant for this command: `pullRequests` with
 * `background` serves whatever is stored and refreshes in a process nobody is waiting on. The
 * one run that still waits is the very first in a repository, where there is nothing stored to
 * draw — `pr.ts` documents why an empty map cannot stand in for that, and moving even that
 * wait behind the draw is EXC-1017's.
 *
 * **Merged pull requests are not offered.** `pr.ts` stores both states because `wt`'s merged
 * marker needs them — `stack.ts` builds its edges from open rows alone, so merged layers drop
 * out of the walk by construction — and a picker whose answer is "go there and review it" has
 * no use for one either. That leaves {@link openPullRequests} as the only place the two
 * consumers of one cache disagree, and it disagrees explicitly.
 *
 * **Order is imposed here rather than inherited.** `gh` is asked for `sort:updated-desc` and
 * that order does, as it happens, survive the trip today — `dedupe` folds into a `Map`, whose
 * insertion order a re-`set` does not disturb, and JSON preserves an array. Depending on it
 * would mean depending on all three of those at once, plus on `collect` concatenating the two
 * state queries rather than interleaving them, none of which is this module's to hold still. So
 * the criterion is met by sorting, and the tie-break on number is what makes the ordering total
 * — without it two rows sharing a timestamp are separated by nothing but which one the fold saw
 * first, and the same repository draws in a different order run to run.
 *
 * **The destination is one of three, and only the third runs `gh`.** A live worktree on the
 * pull request's head branch is where the user already is going. A **prunable** record for
 * that branch is not — its directory is gone, and while the record stands git refuses to check
 * the branch out anywhere else — so it is pruned, with a confirmation first, because
 * `git worktree prune` is repo-wide and the user is answering for records this command never
 * showed them. Otherwise a worktree is created **detached** and the pull request checked out
 * into it.
 *
 * **Detached, and then `gh`, in that order, for two separate reasons.** Detached because
 * `git worktree add` with no branch DWIMs one from the directory name, which `gh pr checkout`
 * then leaves behind — a ref nobody asked for, outliving the worktree that named it. And `gh`
 * rather than `git switch` because only `gh` resolves a fork's remote and sets the branch's
 * upstream from a pull-request number, which is the constraint the issue states outright.
 *
 * **A failed checkout leaves nothing behind, and moves nobody.** The worktree is force-removed
 * — it holds a detached HEAD nobody asked for — and the failure is rethrown with its status
 * intact. "The original working directory is restored" holds at both levels without anything
 * here restoring it: this process never changes its own cwd, `checkoutPullRequest` taking the
 * directory as a parameter, and the shell never moves because nothing was written to stdout.
 *
 * **Cancelling is not this module's to signal**, exactly as in `wt.ts`: {@link choosePullRequest}
 * answers `null` — for a dismissed list and for a declined prune alike — and the command
 * converts that to a {@link Cancelled}. See [`./errors`](./errors) for why the throw belongs to
 * the action rather than to anything under it.
 *
 * @packageDocumentation
 */

import { join } from "node:path";

import { NotATerminal, type PickerRow, pick } from "@macintacos/wrk-picker";

import { loadConfig } from "./config";
import { type Cancelled, type CommandFailed, Refusal } from "./errors";
import { checkoutPullRequest, type PullRequest } from "./gh";
import { addWorktree, listWorktrees, pruneWorktrees, removeWorktree, type Worktree } from "./git";
import { worktreeDirName } from "./naming";
import { note, PREFIX } from "./output";
import { pullRequests } from "./pr";
import { previewPullRequest } from "./preview";
import { provision } from "./provision";
import { checkoutFor, containerFor, isBareLayout, UNCONVERTED } from "./repo";

/** The prefix `listWorktrees` reports branch refs with, and `gh` reports head refs without. */
const BRANCH_PREFIX = "refs/heads/";

/**
 * The cache entry the rows and their previews are both read at.
 *
 * The literal `pr.ts` files its rows under and `config.ts` exposes as a tunable, spelled here
 * rather than imported because it is the *user's* key: someone configuring
 * `cache.ttls."pr-graph"` is configuring this read. `wt.ts` spells it out for the same reason.
 */
const ENTRY = "pr-graph";

/** The confirmation picker's two answers, which are also its payloads. */
const PRUNE = "prune";
const CANCEL = "cancel";

/**
 * What the confirmation asks, and where the repo-wide disclosure lives.
 *
 * In the prompt rather than in a row, because the rows are the *answers* and this is the
 * question. Kept short enough to survive the prompt line's own truncation on a narrow
 * terminal, which is why the stale worktree's path is said separately through {@link note}
 * instead of being interpolated in here: the disclosure is the half that must not be the one
 * cut off.
 */
const PRUNE_PROMPT = "prune every stale worktree record in this repository? ";

/**
 * What choosing a pull request means: where to go, and which pull request is there.
 *
 * **`worktree_path` is snake_case deliberately**, as `Created.worktree_path` and
 * `Chosen.worktree_path` in [`./wt`](./wt) are: this type is serialised straight into the
 * run's JSON envelope, so the property name is the field name. The properties are declared in
 * the order the envelope emits them.
 *
 * Spelled out rather than named `Chosen` like `wt.ts`'s, which is the same word for a different
 * shape. Nothing collides today, `index.ts` exporting nothing — but EXC-1014 settles that
 * surface, and two `Chosen`s arriving at it is a rename under time pressure rather than now.
 *
 * Deliberately **not** the picker's payload, which is the number alone — see
 * {@link pullRequestRows}.
 */
export interface ChosenPullRequest {
  /** Absolute path of the worktree to move to. */
  worktree_path: string;

  /** The pull request checked out there. */
  number: number;
}

/**
 * The open pull requests, most-recently-updated first.
 *
 * Merged rows are dropped and the order is imposed rather than inherited — this module's
 * header has both reasons.
 *
 * `updatedAt` is compared with `<` rather than through `localeCompare`, which is exact rather
 * than convenient: {@link PullRequest.updatedAt} is pinned to second-precision UTC by `gh.ts`'s
 * schema, so code-unit order *is* chronological order and no date is parsed and no collation
 * table consulted to find that out. The same comparison `pr.ts`'s `beats` makes, and for the
 * same reason.
 *
 * @param prs - Pull requests by head ref, as `pullRequests` returns them.
 * @returns The open ones, newest first, ties broken by the higher number. Empty when there are
 *   none, which its caller turns into a refusal rather than an empty picker.
 */
export function openPullRequests(prs: ReadonlyMap<string, PullRequest>): PullRequest[] {
  return [...prs.values()]
    .filter((pull) => pull.state === "OPEN")
    .sort((left, right) =>
      left.updatedAt === right.updatedAt
        ? right.number - left.number
        : right.updatedAt > left.updatedAt
          ? 1
          : -1,
    );
}

/**
 * One picker row per pull request: its number, its title, then its head branch.
 *
 * **The payload is the number as a string.** `PickerRow.payload` has to be unique across the
 * rows — the cursor resolves to the first `===` hit, and a duplicate makes every later row
 * carrying it unreachable — and has to still compare `===` after a row-set replacement. A pull
 * request's number is both, where an object rebuilt from a fresh query is neither and a title
 * is not even unique. A string rather than the number itself so the payload type matches
 * `wt.ts`'s and the picker is instantiated one way across the package.
 *
 * **The number leads** because it is the row's identity and is what both the preview and the
 * checkout are keyed by, so it is the field a reader is joining on. The head branch is last
 * because the picker truncates from the right, and of the three it is the one a narrow
 * terminal can most afford to lose — the same trade `wt.ts` makes by putting the title last
 * there, applied to a row whose identifying field is different.
 *
 * Nothing is coloured. `config.glyphs` and `config.colours` are one value per *stack position*
 * and this list has no stack in it; inventing a second palette here would be a decision no
 * configuration file could reach.
 *
 * @param open - The pull requests to draw, in the order they will be shown.
 * @returns One row each, carrying its number as the payload.
 */
export function pullRequestRows(open: readonly PullRequest[]): PickerRow<string>[] {
  return open.map((pull) => ({
    payload: String(pull.number),
    columns: [{ text: `#${pull.number}` }, { text: pull.title }, { text: pull.headRefName }],
  }));
}

/**
 * The worktree standing on `headRef`, live or stale, or nothing when no worktree holds it.
 *
 * **A prunable record is answered rather than skipped**, which is the opposite call to
 * `wt.ts`'s `candidates` and deliberately so. There a stale record is a destination that
 * cannot be entered, so it is dropped; here it is the thing *between* the caller and the
 * branch — git refuses to check a branch out anywhere else while a record holds it — so the
 * caller has to see it in order to confirm the prune. {@link Worktree.prunable} is what tells
 * the two apart.
 *
 * @param worktrees - Every worktree, as `listWorktrees` reports them, branch refs fully
 *   qualified. The bare repository is already absent from that list.
 * @param headRef - The pull request's head branch, short, as `gh` reports it.
 * @returns The record holding that branch. A detached worktree never matches, having no branch
 *   to join on.
 */
// ponytail: the join is head-ref-only, which is not an identity across repositories. `gh`
// reports `headRefName` as the branch name in the *head* repository, so a pull request opened
// from a fork's `main` matches this repository's own `main` worktree and is answered as though
// the pull request were already checked out there — a wrong destination, and no `gh pr checkout`
// runs. The whole `pr-graph` cache is keyed this way (`pr.ts`), where the cost is a misplaced
// marker; this is the first consumer that turns it into somewhere the user is sent. The fix is
// `isCrossRepository` in `gh.ts`'s `PULL_REQUEST` — one more key in `FIELDS`, derived from the
// schema — and declining the join for a cross-repo row. It is deferred because it invalidates
// every stored entry once, which `pr.ts` already degrades to "no data" for.
export function holderFor(worktrees: readonly Worktree[], headRef: string): Worktree | undefined {
  const ref = `${BRANCH_PREFIX}${headRef}`;

  return worktrees.find((worktree) => worktree.branch === ref);
}

/**
 * Asks whether to prune, having first said which worktree provoked the question.
 *
 * A two-row picker rather than a hand-rolled `y/N` read, because `pick` already owns raw mode,
 * the non-terminal refusal, and erasing its own frame once the pick resolves — a bespoke reader
 * would reimplement all three and get one of them wrong. `cancel` is the first row so the
 * cursor starts on the answer that changes nothing.
 *
 * @param stale - The recorded worktree whose directory is gone.
 * @returns `true` only if the user chose to prune. Escape, `Ctrl-C` and `cancel` alike answer
 *   `false`, which the caller treats as a dismissal.
 */
async function confirmPrune(stale: string): Promise<boolean> {
  note(`${PREFIX}${stale} is still recorded as a worktree, but its directory is gone`);

  const answer = await pick({
    prompt: PRUNE_PROMPT,
    rows: [
      { payload: CANCEL, columns: [{ text: CANCEL }] },
      { payload: PRUNE, columns: [{ text: PRUNE }] },
    ],
  });

  return answer === PRUNE;
}

/**
 * Creates a worktree for `pull` and checks it out there, or leaves nothing behind.
 *
 * The order — detached, then `gh`, then provisioning — and the force-removal on failure are
 * both this module's header.
 *
 * Provisioning runs **last**, so it sees the pull request's own files rather than whatever the
 * detached HEAD started at: a pull request that adds a `mise.toml` should have its toolchain
 * installed, not the base branch's. It is best-effort and writes only to stderr, so it can
 * neither reject nor alter the path returned — `gh` has already succeeded by then, and a
 * missing `.env` is not a reason to report a worktree that exists as one that does not.
 *
 * The layout this needs is checked by its **caller**, before the prune that may precede it —
 * see {@link choosePullRequest}.
 *
 * @param pull - The pull request to land.
 * @param from - The checkout to create from and provision from.
 * @param container - Where the worktree is placed, as a flat sibling.
 * @returns The absolute path of the worktree the pull request is now checked out in.
 * @throws {@link CommandFailed} if `git worktree add` or `gh pr checkout` refused, carrying
 *   that command's own exit status, which becomes `wrk`'s.
 */
async function landIn(pull: PullRequest, from: string, container: string): Promise<string> {
  const path = join(container, worktreeDirName(pull.headRefName));
  await addWorktree(path, from, { detach: true });

  try {
    await checkoutPullRequest(pull.number, path);
  } catch (error) {
    // Reported rather than swallowed, and rethrowing the *checkout's* failure rather than this
    // one: a worktree that could not be removed is a real thing left on disk, and saying so is
    // the only way the user learns of it — but it is a consequence of the failure below, not
    // the failure itself, and replacing that one would hide the cause with its symptom.
    await removeWorktree(path, from, { force: true }).catch((cleanup: unknown) => {
      note(`${PREFIX}${path} could not be removed after the checkout failed: ${String(cleanup)}`);
    });

    throw error;
  }

  await provision(from, path);

  return path;
}

/**
 * Offers the repository's open pull requests and answers where to go for the one chosen.
 *
 * **Every pull request is drawn, including a lone one.** `wt` skips its picker with one
 * candidate, because the destination already exists and going there is not a mutation; this
 * one creates a worktree and runs `gh pr checkout`, so Enter on a list of one is the
 * confirmation that mutation deserves rather than ceremony to be optimised away.
 *
 * **No open pull request is a {@link Refusal}, not an empty picker** — `wt`'s call, for `wt`'s
 * reason: a picker with no rows resolves `null`, which every caller maps to a cancellation,
 * and the user would be told nothing at all.
 *
 * @param cwd - Anywhere in the repository: a checkout, a run worktree, or the container.
 * @returns Where to go and which pull request is there, or `null` if the user dismissed the
 *   list or declined the prune. `null` covers Escape, `Ctrl-C` and Enter on an empty result
 *   set alike, which is what `pick` promises.
 * @throws {@link Refusal} if `cwd` is in no repository, if there are no open pull requests, if
 *   a worktree has to be created in a repository that is not a bare-repo container, or if
 *   there is no terminal to draw in.
 * @throws {@link CommandFailed} if any of the git or `gh` commands the chosen destination needs
 *   refused — listing the worktrees, pruning them, adding one, or checking the pull request out.
 *   Each carries that command's own exit status, which becomes `wrk`'s, and the checkout's is
 *   the one a caller is most likely to see.
 * @throws Whatever `pullRequests` threw — an unreadable cache directory, which is left to
 *   surface with its stack rather than mapped. Unlike `wt`, where the graph is an annotation
 *   and an empty one merely draws less, here it *is* the rows: reporting it as "no open pull
 *   requests" would answer a broken cache with a sentence about GitHub.
 * @throws {@link Cancelled} never — see this module's header.
 *
 * @example
 * ```ts
 * const chosen = await choosePullRequest(process.cwd());
 * if (chosen === null) throw new Cancelled("the pull-request picker was dismissed");
 * emitLine(chosen.worktree_path);
 * ```
 */
export async function choosePullRequest(cwd: string): Promise<ChosenPullRequest | null> {
  const container = await containerFor(cwd);
  if (container === null) {
    throw new Refusal("not a git repository; run this from inside the repository to look around");
  }

  // Concurrent because neither depends on the other, and both sit ahead of the first frame on a
  // command whose whole design is not to make the user wait for one — `checkoutFor` is several
  // git spawns and `loadConfig` two file reads. Not folded in with `containerFor` above them,
  // which has to have answered first: it supplies `loadConfig`'s container, and `checkoutFor`
  // has nothing to resolve outside a repository. The same ordering, for the same reason, as
  // `wt.ts`'s and `repo.ts`'s.
  //
  // `from` is resolved before the picker rather than after it because the preview pane renders
  // from it on the very first frame: `gh` has to run somewhere that resolves this repository,
  // and the container qualifies but a caller standing in it has no work tree.
  const [config, resolved] = await Promise.all([loadConfig({ container }), checkoutFor(cwd)]);
  const from = resolved ?? cwd;

  // The `??` is `noUncheckedIndexedAccess` demanding a total lookup, not a real absence:
  // `loadConfig` seeds every key `DEFAULTS` carries and this is one of them. `0` is the honest
  // value for the branch that cannot fire — refresh on every read, which is correct and merely
  // slower — the same call `preview.ts` and `wt.ts` both make for the same key.
  const ttl = config.cache.ttls[ENTRY] ?? 0;

  const open = openPullRequests(await pullRequests(container, ttl, { background: true }));
  if (open.length === 0) {
    throw new Refusal("no open pull requests to go to");
  }

  const answers = new Map(open.map((pull) => [String(pull.number), pull]));

  const chosen = await picked(open, (payload, width) =>
    previewPullRequest(Number(payload), width, { container, cwd: from, ttl }),
  );
  // The `??` is unreachable — every payload came out of a row built from `open` — and is
  // spelled as a dismissal rather than asserted away because that is the one outcome a `cd`
  // protocol can take safely: exit 130, stdout empty, nobody moved.
  const pull = chosen === null ? undefined : answers.get(chosen);
  if (pull === undefined) return null;

  const holder = holderFor(await listWorktrees(cwd), pull.headRefName);
  if (holder !== undefined && holder.prunable === null) {
    return { worktree_path: holder.path, number: pull.number };
  }

  // Both remaining destinations end in a created worktree, so the layout that makes one
  // possible is settled **before** the prune the other asks consent for. Checked inside
  // `landIn` it would run after: the user would be asked to approve a repo-wide prune, the
  // prune would happen, and the run would then refuse — consent spent on a run that could
  // never have succeeded.
  if (!(await isBareLayout(from))) {
    throw new Refusal(UNCONVERTED);
  }

  if (holder !== undefined) {
    if (!(await confirmPrune(holder.path))) return null;
    await pruneWorktrees(cwd);
  }

  return { worktree_path: await landIn(pull, from, container), number: pull.number };
}

/**
 * Draws the list, in `wrk`'s vocabulary rather than the picker's.
 *
 * {@link confirmPrune} needs no translation of its own, and that is an ordering property rather
 * than anything this split buys: it is reached only once this pick has already drawn, so a
 * stream that was not a terminal has been refused before there is a second picker to ask.
 */
async function picked(
  open: readonly PullRequest[],
  preview: (payload: string, width: number) => Promise<string>,
): Promise<string | null> {
  try {
    return await pick({ rows: pullRequestRows(open), preview });
  } catch (error) {
    // The picker's own sentence says which stream is not a terminal, which is the whole of what
    // a user needs; wrapping it is only about the exit status and the `wrk: ` prefix.
    if (error instanceof NotATerminal) throw new Refusal(error.message);

    throw error;
  }
}
