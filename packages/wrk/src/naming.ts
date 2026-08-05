/**
 * The single source of truth for `wrk`'s naming rules.
 *
 * Every question of the form "what is this thing called?" is answered here: what a run
 * branch looks like, what directory its worktree gets, whether a given directory *is* a
 * run worktree, whether a branch belongs to an issue, and what branch a new run should
 * mint. These rules previously existed as three partial reimplementations across Python,
 * fish and TypeScript, which had already drifted apart on the issue-key shape and on cache
 * keys.
 *
 * **This module is pure.** It spawns nothing, reads nothing, and touches neither git nor
 * the filesystem — {@link mintBranch} is handed the set of branches to avoid rather than
 * discovering it. That is what makes the rules cheap enough to pin exhaustively in tests,
 * which is precisely what the previous implementations lacked while they drifted. The
 * layers that own git state supply the inputs.
 *
 * @packageDocumentation
 */

/**
 * The project-key-and-number shape, written once and anchored differently below.
 *
 * `[A-Z][A-Z0-9]*-\d+` is adopted deliberately, over the `[A-Z][A-Z0-9]+-[0-9]+` variant
 * that the tab-title and issue-tracking hooks carry. It is a strict superset — every
 * branch the other form matches, this one matches too — so the only behavioural difference
 * is a single-letter project key such as `X-1`.
 *
 * That difference is settled by which error is worse. These predicates gate whether a
 * directory is treated as an isolated run worktree, so a false negative on a real
 * one-letter-key team stops a legitimate worktree from being recognised and blocks real
 * edits, while a false positive merely treats a branch literally shaped `X-1/foo` as a run
 * worktree — which is what a reader would want anyway. The permissive form is also the one
 * used by the tool that creates the worktrees and names their directories, making it the
 * shape actually minted in practice.
 */
const ISSUE_KEY_PATTERN = String.raw`[A-Z][A-Z0-9]*-\d+`;

/**
 * Matches a working branch carrying an `<ISSUE-ID>/` prefix.
 *
 * The trailing separator is part of the pattern: without it, the bare key `EXC-1` would
 * read as a working branch. The leading `^` is load-bearing in a way it is not in the
 * Python original — `re.match` anchors at the start implicitly, whereas
 * {@link RegExp.test} scans the whole string, so dropping it would accept
 * `feature/EXC-1/x`.
 *
 * Carries no `g` flag, so it holds no `lastIndex` and is safe to share at module scope.
 */
export const ISSUE_BRANCH_RE: RegExp = new RegExp(`^${ISSUE_KEY_PATTERN}/`);

/** Matches a bare issue identifier, with no separator and nothing trailing. */
const ISSUE_KEY_RE = new RegExp(`^${ISSUE_KEY_PATTERN}$`);

/** Longest descriptive slug {@link mintBranch} will produce, in characters. */
const MAX_SLUG_LENGTH = 40;

/** Slug used when a title survives slugification with nothing left. */
const FALLBACK_SLUG = "work";

/**
 * Folds every `/` in a string to `+`.
 *
 * The primitive behind {@link worktreeDirName}, exported separately so a caller folding
 * something that is not a branch does not have to misname its intent. Every slash folds,
 * not just the first: a branch may carry more than one, and each worktree has to stay a
 * single flat directory inside the container.
 *
 * @param value - Any string.
 * @returns The string with each `/` replaced by `+`.
 */
export function fold(value: string): string {
  return value.replaceAll("/", "+");
}

/**
 * Gives the directory name a branch's worktree is created under.
 *
 * Only the directory folds. The branch keeps its slashes and reaches `git worktree add -b`
 * verbatim — folding it there would create a literal `EXC-1+add-thing` ref.
 *
 * @param branch - The working branch, e.g. `EXC-1/add-thing`.
 * @returns The flat directory name, e.g. `EXC-1+add-thing`.
 */
export function worktreeDirName(branch: string): string {
  return fold(branch);
}

/**
 * Reports whether a branch is shaped like an exec run's working branch.
 *
 * @param branch - Branch name to test.
 * @returns `true` when the branch carries an `<ISSUE-ID>/` prefix.
 */
export function isIssueBranch(branch: string): boolean {
  return ISSUE_BRANCH_RE.test(branch);
}

/**
 * Reports whether a checkout is one of this tool's isolated run worktrees.
 *
 * Both halves matter, and neither is sufficient alone: the branch must carry an issue
 * prefix, *and* the directory must be the one that branch would have been given. That
 * pairing is what distinguishes an isolation worktree from a default-branch checkout
 * someone happens to have parked on a feature branch.
 *
 * @param dirName - The checkout's directory name, not its full path.
 * @param branch - The branch that checkout currently holds.
 * @returns `true` when the pair is one this tool would have created.
 */
export function isRunWorktree(dirName: string, branch: string): boolean {
  return isIssueBranch(branch) && dirName === worktreeDirName(branch);
}

/**
 * Reports whether a branch is a given issue's working branch.
 *
 * The trailing separator carries the whole rule. Comparing against a bare prefix would let
 * `EXC-1` claim `EXC-10/add-thing`, silently attaching a run to the wrong issue's
 * worktree.
 *
 * The comparison is case-sensitive and does not normalise, so a lowercased identifier
 * matches nothing. {@link mintBranch} rejects such an identifier up front rather than
 * letting it reach here.
 *
 * @param branch - Branch name to test.
 * @param issue - Issue identifier, e.g. `EXC-1`.
 * @returns `true` when the branch belongs to that issue.
 */
export function branchBelongsToIssue(branch: string, issue: string): boolean {
  return branch.startsWith(`${issue}/`);
}

/**
 * Reduces an arbitrary key to one filesystem-safe path segment.
 *
 * Unifies four previously divergent sanitizers onto a single alphabet. This subsumes the
 * `/`-to-`_` form rather than contradicting it: on a container path every slash still
 * folds, and the characters that form left alone are made safe too.
 *
 * The `u` flag is load-bearing. Without it the class matches UTF-16 code units, so an
 * astral character such as an emoji would yield one `_` per surrogate half. Two callers
 * disagreeing about a cache key do not error — they silently stop sharing the cache.
 *
 * @param key - Any string used to key a cache — an issue identifier, a container path.
 * @returns The key with every character outside `[A-Za-z0-9._-]` replaced by `_`.
 */
export function cacheSlug(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/gu, "_");
}

/**
 * Kebab-cases a title into the descriptive half of a branch name.
 *
 * Non-alphanumerics collapse in runs rather than one-for-one, so `Fix: the (broken) login`
 * yields `fix-the-broken-login` instead of a string of empty segments. Non-ASCII letters
 * are replaced rather than transliterated — a branch name is not the place to be clever
 * about Unicode, and a title that reduces to nothing is caught by the caller.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/**
 * Mints the working branch for an issue.
 *
 * Slugifies the title, caps the descriptive portion at {@link MAX_SLUG_LENGTH}, and walks
 * past any branch already taken by appending `-2`, `-3`, and so on. A collision suffix is
 * added *after* the cap, so a disambiguated branch may run slightly longer — the cap
 * exists to keep names readable, not to satisfy a hard limit.
 *
 * `issue` is validated rather than trusted. Minting from a malformed or lowercased
 * identifier used to produce a branch that {@link isIssueBranch} then rejected, so the
 * worktree it created was never recognised as a run worktree — a failure that surfaced far
 * from its cause. A title that slugifies to nothing falls back to
 * {@link FALLBACK_SLUG} for the same reason: `EXC-1/` is not a valid git ref, and it would
 * fold to the directory `EXC-1+`.
 *
 * @param issue - Issue identifier, e.g. `EXC-992`. Must be a bare key with no separator.
 * @param title - The issue's title, in any shape.
 * @param existing - Branches already taken. Defaults to none.
 * @returns A branch name of the form `<ISSUE-ID>/<slug>`.
 * @throws If `issue` is not a well-formed issue identifier.
 *
 * @example
 * ```ts
 * mintBranch("EXC-992", "Naming module and branch minting");
 * // "EXC-992/naming-module-and-branch-minting"
 *
 * mintBranch("EXC-1", "Add thing", await listBranches());
 * // "EXC-1/add-thing-2", when "EXC-1/add-thing" is already checked out
 * ```
 */
export function mintBranch(issue: string, title: string, existing: Iterable<string> = []): string {
  if (!ISSUE_KEY_RE.test(issue)) {
    throw new Error(`Not a well-formed issue identifier: ${issue}`);
  }

  const slug = slugify(title).slice(0, MAX_SLUG_LENGTH).replace(/-+$/u, "") || FALLBACK_SLUG;
  const base = `${issue}/${slug}`;

  const taken = new Set(existing);
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) {
    candidate = `${base}-${n}`;
  }

  return candidate;
}
