/**
 * The typed boundary between `wrk` and the GitHub CLI.
 *
 * Everything `wrk` knows about how `gh` is spelled lives here: its argv, its JSON field
 * names, the environment it needs, and which of its failures are answers. Layered on
 * {@link run} from [`./proc`](./proc), whose header already names this module as one of its
 * two wrappers; [`./git`](./git) is the other, and this one deliberately mirrors it.
 *
 * **`cwd` is the first optional parameter of every wrapper**, as in `git.ts`, since it is the
 * one thing every caller varies.
 *
 * **A query reads any refusal as "no"; a command with no "no" to express throws.** This is
 * `git.ts`'s split, and here it is also the acceptance criterion that an absent,
 * unauthenticated, offline or rate-limited `gh` is a normal outcome rather than an error.
 * {@link listPullRequests} and {@link viewPullRequest} answer `null` for every one of those,
 * because a prompt and a picker have to draw anyway and a caller's next move is the same
 * whichever it was. {@link checkoutPullRequest} is a mutation the user asked for outright and
 * has no honest value to return, so it throws — a {@link CommandFailed} carrying `gh`'s own
 * exit status when `gh` ran and refused, and a {@link Refusal} when there is no `gh` to run.
 * Neither is a crash: `output.ts`'s `reportFailure` prints each as one line and exits.
 *
 * **Open and merged pull requests are queried separately, never sharing one result window.**
 * {@link listPullRequests} takes a single state rather than a set, so a combined query cannot
 * be spelled, and {@link LIMITS} gives each state a window of its own. Sharing one lets a busy
 * month of merges push a long-lived bottom layer out of the feed, after which the stack walk
 * built on this data reads a middle layer as the root — a confidently wrong answer, which is
 * worse than none.
 *
 * **The presence gate is the spawn**, as in [`./provision`](./provision): `run` rejects when
 * the child could not be started, and that rejection becomes the `null`, so no `which` is
 * reimplemented and no window opens between a probe answering and the spawn running.
 * `provision.ts` notes that an `ENOENT` is also what a nonexistent `cwd` produces and that
 * telling them apart is impossible; here the conflation costs nothing, because both readings
 * mean "`gh` could not answer" and a directory that does not exist is not a GitHub checkout
 * either.
 *
 * **Nothing here can block on input.** `run` closes the child's stdin, so a `gh` that would
 * prompt sees EOF instead — and {@link GH_ENV} empties `GH_PAGER`, because
 * {@link ViewOptions.width} makes `gh` believe stdout is a terminal and a `gh` that believes
 * that starts the user's pager, which is the canonical thing that waits for a keystroke. `gh`
 * reads the variable with `LookupEnv`, so an explicitly empty value means "no pager" rather
 * than falling through to `PAGER`.
 *
 * Unlike `git.ts` this module exports no escape hatch. There is no one-off `gh` command in the
 * package, and a spawn helper with no caller is surface invented ahead of need; whichever
 * module wants one exports it then.
 *
 * @packageDocumentation
 */

import { z } from "zod";

import { CommandFailed, Refusal } from "./errors";
import { type RunResult, run } from "./proc";

/**
 * Environment every invocation gets, whatever else a caller adds.
 *
 * One entry, and it is a safety property rather than a preference — see this module's header
 * for why an emptied `GH_PAGER` is what keeps a forced-TTY render from waiting on a keystroke.
 */
const GH_ENV: Record<string, string> = { GH_PAGER: "" };

/**
 * The pull-request states `wrk` asks about, spelled as `gh`'s own JSON reports them.
 *
 * Closed pull requests are deliberately absent: a closed branch is neither stacked nor a
 * teardown signal, so there is nothing for a caller to do with one.
 *
 * One vocabulary for both directions — the argument {@link listPullRequests} takes and the
 * value {@link PullRequest.state} carries — so a row and the query that produced it cannot be
 * described in disagreeing terms. `gh`'s `--state` flag wants the lowercase form, which is
 * this module's problem rather than a caller's.
 */
export type PullRequestState = "OPEN" | "MERGED";

/**
 * How many pull requests each state's query may return.
 *
 * **Two windows, not one shared between them**, which is the point — see this module's header.
 * The numbers are the fish implementation this package replaces, preserved rather than
 * re-chosen, so adopting `wrk` changes nothing about which pull requests are visible. Merged
 * gets the smaller window because it is only ever read for a marker on branches that are
 * already gone, while the open set is the graph itself.
 */
const LIMITS: Record<PullRequestState, number> = { OPEN: 100, MERGED: 50 };

/** One pull request, as much of it as `wrk` reads. */
export interface PullRequest {
  /** The pull request's number, as `gh pr view` and `gh pr checkout` take it. */
  number: number;

  /**
   * The pull request's title, verbatim.
   *
   * May hold a tab or a newline. That is only worth saying because the format this replaces
   * interpolated it straight into a tab-separated file, where either character desynced every
   * downstream column; JSON is the transport here, so the value arrives whole.
   */
  title: string;

  /** The branch the pull request is *from* — the key everything else joins on. */
  headRefName: string;

  /** The branch the pull request merges *into*, which is the parent edge of a stack. */
  baseRefName: string;

  /** Which query this row came from. Never `CLOSED`; see {@link PullRequestState}. */
  state: PullRequestState;

  /**
   * When the pull request was last updated, as an ISO-8601 instant.
   *
   * GitHub always reports UTC with a trailing `Z` — the schema requires it — so lexicographic
   * order on this string is chronological order, and a caller deduplicating rows can compare
   * them without parsing a date.
   */
  updatedAt: string;
}

/**
 * The attributes of one `gh pr list --json` row.
 *
 * This is the parse boundary in the literal sense — text `gh` wrote becoming a value the rest
 * of `wrk` acts on — so it is a schema rather than a hand-rolled fold, exactly as `git.ts`'s
 * `WORKTREE` is. {@link listPullRequests}'s return annotation is what ties it to
 * {@link PullRequest}, so the two cannot drift without a type error.
 *
 * The two refs are required **and non-empty**, which is the schema stating a precondition
 * rather than a case expected to fire: a row whose head ref is `""` would join against every
 * other empty value in a caller's map.
 */
const PULL_REQUEST = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  headRefName: z.string().min(1),
  baseRefName: z.string().min(1),
  state: z.enum(["OPEN", "MERGED"]),
  updatedAt: z.iso.datetime(),
});

/**
 * The `--json` field list, derived from the schema rather than written beside it.
 *
 * Asking `gh` for exactly what the schema parses means there is no second list to drift: a
 * field added to {@link PULL_REQUEST} is requested from `gh` by the same edit.
 */
const FIELDS = Object.keys(PULL_REQUEST.shape).join(",");

/**
 * Runs `gh` with `args` in `cwd`, or answers `null` when `gh` is not installed.
 *
 * The presence gate every wrapper below shares — see this module's header for why the spawn
 * is the gate and why reading its `ENOENT` as "not installed" is safe here. Anything else that
 * goes wrong starting the child is a real failure and propagates.
 *
 * A nonzero exit resolves rather than throwing, exactly as {@link run} does; what to make of
 * it is each wrapper's own decision.
 *
 * @param args - Arguments after `gh`, one array element per argv entry.
 * @param cwd - Directory to run in, which is what decides the repository `gh` answers about.
 * @param env - Variables for this call alone. {@link GH_ENV} is spread after it and therefore
 *   wins, so a caller can add to the environment but cannot re-enable the pager.
 */
// ponytail: no timeout, matching the implementation this replaces — a blackholed network wedges
// the call rather than failing it. Give `run` a `timeout` here if one is ever observed.
function gh(
  args: string[],
  cwd?: string,
  env?: Record<string, string | undefined>,
): Promise<RunResult | null> {
  return run("gh", args, { cwd, env: { ...env, ...GH_ENV } }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
}

/**
 * `JSON.parse`, with a syntax error as a value rather than a throw.
 *
 * `undefined` fails {@link PULL_REQUEST}'s array schema like any other unacceptable payload,
 * which is what lets malformed JSON and well-formed-but-wrong JSON share one error message
 * instead of surfacing as two unrelated failures a caller would have to tell apart.
 */
function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Pull requests in one state — **never both in one call**, per this module's header.
 *
 * Rows are ordered most-recently-updated first, which decides *which* of them fall inside the
 * state's window; a caller that depends on the order for anything else should compare
 * {@link PullRequest.updatedAt} instead.
 *
 * @param state - The single state to query. Each has a window of its own — see {@link LIMITS}.
 * @param cwd - Directory to run in. Defaults to this process's cwd.
 * @returns The matching pull requests, `[]` when there are none, or `null` when `gh` could not
 *   answer — not installed, not authenticated, offline, rate-limited, or no GitHub remote. The
 *   difference between `[]` and `null` is load-bearing: the first is `gh` saying "none", the
 *   second is `gh` saying nothing, and a cache that conflated them would overwrite a good
 *   result with an empty one.
 * @throws If `gh` exited 0 and then emitted something this module cannot read. That is a `gh`
 *   whose JSON shape has changed, which is a fault rather than one of the normal outcomes
 *   above — the same call `git.ts`'s `parseWorktree` makes about an unreadable record.
 */
export async function listPullRequests(
  state: PullRequestState,
  cwd?: string,
): Promise<PullRequest[] | null> {
  const result = await gh(
    [
      "pr",
      "list",
      "--state",
      state.toLowerCase(),
      "--limit",
      String(LIMITS[state]),
      "--search",
      "sort:updated-desc",
      "--json",
      FIELDS,
    ],
    cwd,
  );
  if (result === null || result.code !== 0) return null;

  const rows = z.array(PULL_REQUEST).safeParse(tryJson(result.stdout));
  if (!rows.success) {
    // The payload is truncated, unlike `git.ts`'s equivalent: one worktree record is a line,
    // whereas this is up to a hundred pull requests and a reader needs the shape, not all of
    // it. A `ZodError`'s issue array is deliberately not let out of the module.
    throw new Error(`gh emitted an unreadable pull-request list: ${result.stdout.slice(0, 200)}`);
  }

  return rows.data;
}

/** Options for {@link viewPullRequest}. */
export interface ViewOptions {
  /**
   * Column count to render at, which also forces `gh` to render at all.
   *
   * Piped, `gh` falls back to plain text; `GH_FORCE_TTY` is what makes it render the body as
   * markdown, and sizing it to the destination is what makes the wrapping right. Omit it for
   * the plain-text fallback. A caller displaying the result is responsible for re-rendering
   * when its width changes, since text wrapped for one width is wrong at another.
   */
  width?: number;
}

/**
 * `gh`'s own rendering of one pull request, ready to display.
 *
 * Both of `gh`'s streams are returned, concatenated — its output and then anything it said
 * about the attempt. That is what makes a failed lookup show its message rather than leaving a
 * preview pane blank, and it means a partial render followed by an error loses neither half.
 * The two are concatenated rather than interleaved, because {@link run} captures them
 * separately.
 *
 * @param number - The pull request to view.
 * @param cwd - Directory to run in. Defaults to this process's cwd.
 * @param options - See {@link ViewOptions}.
 * @returns What to display, or `null` when `gh` is not installed — the one case with nothing
 *   to show at all.
 */
export async function viewPullRequest(
  number: number,
  cwd?: string,
  options: ViewOptions = {},
): Promise<string | null> {
  const env = options.width === undefined ? undefined : { GH_FORCE_TTY: String(options.width) };

  const result = await gh(["pr", "view", String(number)], cwd, env);
  if (result === null) return null;

  return `${result.stdout}${result.stderr}`;
}

/**
 * Checks a pull request out into `cwd`.
 *
 * `gh` owns this rather than `git switch` because it resolves a fork's remote and sets the
 * branch's upstream, neither of which git can do from a pull request number alone.
 *
 * The one wrapper here that throws — see this module's header for the query/mutation split.
 *
 * @param number - The pull request to check out.
 * @param cwd - Directory to check out into. Defaults to this process's cwd.
 * @throws {Refusal} If `gh` is not installed, so there is nothing that could do this.
 * @throws {CommandFailed} If `gh` refused — most often because the branch is already checked
 *   out in another worktree. Carries `gh`'s own exit status, which becomes `wrk`'s.
 */
export async function checkoutPullRequest(number: number, cwd?: string): Promise<void> {
  const args = ["pr", "checkout", String(number)];

  const result = await gh(args, cwd);
  if (result === null) {
    throw new Refusal(
      "gh is not installed, so pull requests cannot be checked out — see https://cli.github.com.",
    );
  }
  if (result.code !== 0) {
    throw new CommandFailed(["gh", ...args], result.code, result.stderr);
  }
}
