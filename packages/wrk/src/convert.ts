/**
 * The bare-repo conversion recipe, rendered for one repository and never run.
 *
 * Converting a repository to the layout the rest of `wrk` requires — a `.bare` clone, a
 * `.git` file pointing at it, and one sibling checkout per branch — means renaming the
 * existing checkout aside and re-cloning it. **That is why nothing here executes.** The
 * caller is standing in the directory the first step renames, so running the recipe under
 * them would pull the ground out from under the very session that asked for it: their shell
 * would be left inside a directory that no longer has that name, and every path they were
 * holding would be stale. Printing it puts the caller in control of when — and from which
 * shell — each step happens.
 *
 * So this module has exactly two jobs, kept apart because one touches the world and the
 * other cannot: {@link resolveConversion} reads the repository (three read-only git queries,
 * no writes), and {@link renderConversion} turns what it read into text. Splitting them is
 * what lets the recipe's exact wording be tested without a repository, and what makes
 * "never executes anything" a property of the module's shape rather than a promise.
 *
 * The recipe is the prose form of the `repo-setup` skill's `bare-repo-conversion.md`
 * reference — its *Before you start*, *The recipe*, *Verify* and *Afterwards* sections —
 * with the repository's real container, remote and default branch substituted in. The
 * reference's layout diagram is not rendered: it describes the destination rather than how to
 * reach it, and whoever is reading this has already been sent here.
 *
 * @packageDocumentation
 */

import { basename, dirname, join } from "node:path";

import { git } from "./git";
import { worktreeDirName } from "./naming";
import { containerFor, resolveDefaultBranch } from "./repo";

/**
 * Everything the recipe substitutes, read off the repository as it stands today.
 *
 * The two nullable fields are nullable because a repository worth converting can genuinely
 * lack either, and neither absence makes the rest of the recipe unprintable — the renderer
 * emits a placeholder for the one value and fills in every other. Refusing outright would
 * withhold a recipe the caller could have used with one edit.
 */
export interface Conversion {
  /**
   * The directory the conversion turns into the container — `dirname` of the git *common*
   * dir, which for an unconverted repository is simply the directory holding its `.git`.
   *
   * Never `git rev-parse --show-toplevel`: that answers the *checkout*, and step 1 renames
   * whatever this names. See `./repo.ts`'s header for why the two are not interchangeable.
   */
  readonly container: string;

  /** `origin`'s URL, or `null` when the repository has no `origin` to restore. */
  readonly remoteUrl: string | null;

  /** The repository's default branch, or `null` when none could be resolved. */
  readonly defaultBranch: string | null;
}

/**
 * Reads what the recipe needs from the repository containing `cwd`.
 *
 * The three queries run concurrently: none depends on another, all three are process spawns,
 * and outside a repository all three fail anyway — so there is no cheap early exit to be had
 * by ordering them, only latency to lose.
 *
 * **An already-converted container is answered, not refused**, though `isBareLayout` sits one
 * call away in a module this one already imports from. Printing is read-only, and the
 * caller's preflight is what routes them here, so a refusal would withhold a recipe from
 * someone who knows why they asked. The rendered *Before you start* block is what covers that
 * case instead: its linked-worktree warning is the one that matters there, since an
 * already-converted container is precisely the shape that has them.
 *
 * @param cwd - Directory to inspect. Defaults to this process's cwd.
 * @returns The values to substitute, or `null` when `cwd` is in no repository — there is
 *   nothing to convert there, and a recipe naming an arbitrary directory would be one the
 *   caller could paste.
 */
export async function resolveConversion(cwd?: string): Promise<Conversion | null> {
  const [container, defaultBranch, origin] = await Promise.all([
    containerFor(cwd),
    resolveDefaultBranch(cwd),
    // Through the `git` escape hatch rather than a new wrapper in `./git.ts`, matching
    // `isBareLayout`'s single-use `config --get` call: one caller does not earn a wrapper.
    git(["remote", "get-url", "origin"], cwd),
  ]);
  if (container === null) return null;

  return {
    container,
    remoteUrl: origin.code === 0 ? origin.stdout.trim() : null,
    defaultBranch,
  };
}

/**
 * A whole value needing no shell quoting, as `shlex.quote` defines the set.
 *
 * Anchored, and `+` rather than `*`, so the empty string does **not** match and is quoted —
 * bare, it would vanish rather than be an argument. Deliberately conservative otherwise:
 * anything outside the set is quoted rather than reasoned about.
 */
const SHELL_SAFE_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * `value` as a single shell word.
 *
 * The recipe is written to be pasted into a shell, so an unquoted path containing a space
 * does not merely look wrong — it splits into two words, and step 1's `mv` then renames
 * something the caller did not mean. A single-quoted string is literal to every POSIX shell,
 * so the only case needing care is an embedded `'`, closed and re-opened around an escaped
 * one.
 */
function quote(value: string): string {
  return SHELL_SAFE_RE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The six checks of the verification gate, rendered with their expectations aligned.
 *
 * Aligned at render time rather than written into a static template because the column
 * depends on the branch name's length, which is not known until here.
 *
 * @param container - The container, for the `--git-common-dir` expectation.
 * @param branch - The default branch, for the expectations naming a ref.
 * @param dir - The checkout's directory as a shell word. Not `branch` spelled differently:
 *   it is folded, so a branch carrying a `/` still names one flat sibling.
 */
function verification(container: string, branch: string, dir: string): string {
  const checks: ReadonlyArray<readonly [string, string]> = [
    [`git -C ${dir} config core.bare`, "true"],
    ["ls -l .git", "a FILE holding `gitdir: ./.bare` -- a directory means step 2 landed wrong"],
    [`git -C ${dir} rev-parse --git-common-dir`, `${container}/.bare`],
    [`git -C ${dir} rev-parse --abbrev-ref '@{upstream}'`, `origin/${branch}`],
    [`git -C ${dir} branch --list`, "every branch the old checkout had"],
    [`git -C ${dir} status`, `clean, on ${branch}`],
  ];

  const width = Math.max(...checks.map(([check]) => check.length));
  return checks.map(([check, expected]) => `${check.padEnd(width)}  # ${expected}`).join("\n");
}

/**
 * The full conversion recipe for `conversion`, as text to print.
 *
 * Pure — no git, no filesystem, no clock — which is the point: the recipe cannot run itself,
 * and its exact wording is testable without building a repository.
 *
 * **Every line is a shell comment or one of the recipe's own commands**, so the whole block
 * can be pasted into a terminal and read top to bottom. That is a safety property rather than
 * a stylistic one: the explanatory lines carry backticks and a `refs/heads/*` glob, so a
 * prose line that lost its `#` would run command substitution and glob expansion rather than
 * merely reading oddly.
 *
 * A value that did not resolve renders as an angle-bracketed placeholder — quoted, like every
 * other substitution, which keeps it from being read as a shell redirection if the block is
 * pasted before the caller fills it in.
 *
 * @param conversion - What {@link resolveConversion} read.
 * @returns The recipe, with **no** trailing newline, so that the whole command body is
 *   `console.log(renderConversion(await resolveConversion()))` — `console.log` supplies the
 *   final newline, and one here would print a blank line after it.
 */
export function renderConversion(conversion: Conversion): string {
  const { container, remoteUrl, defaultBranch } = conversion;
  const branch = defaultBranch ?? "<default-branch>";
  const name = basename(container);
  const oldName = `${name}.old`;
  const parent = quote(dirname(container));
  // The checkout is a flat sibling of `.bare`, so the *directory* folds while the branch
  // handed to `worktree add` keeps its slashes. `naming.ts` owns that rule for `wrk`'s own
  // worktrees, and the checkout this recipe creates is subject to it just the same.
  const dirName = worktreeDirName(branch);
  const dir = quote(dirName);
  const url = quote(remoteUrl ?? "<remote-url>");

  // ponytail: the paste-safe property holds for newline-free paths only -- a container path
  // containing a newline splits the comment lines interpolating it, leaving their tails as
  // live commands. POSIX permits such a name and git reports it verbatim. Refuse that
  // container in the command layer if it ever bites.
  return `# Convert ${container} to the bare-repo layout.
#
# Nothing below has been run. The conversion renames and re-clones the checkout you are
# standing in, so it is yours to run -- a step at a time, from a shell that is not inside it.

# --- Before you start -------------------------------------------------------------------
#
# The conversion re-clones the repository, so anything git is not tracking does not come
# across:
#
#   - Uncommitted work. Commit it, or push it to a branch, first.
#   - Untracked files git will not carry over -- .env, local secrets, .codegraph/, editor
#     state. Copy them into the new checkout afterwards.
#   - Stashes do not survive: refs/stash is not copied by any clone. Pop or commit the whole
#     stack first; \`git stash list\` must be empty.
#   - Linked worktrees. Each one's .git file names an absolute path step 1 renames, so after
#     the move git cannot read them at all and any uncommitted work inside them is
#     unreachable; \`git worktree list\` must show only this checkout.
#
# Local-only branches and unpushed commits do survive, because step 2 clones from the old
# checkout rather than from the remote. Keeping that old checkout until the verification
# below passes is the cheapest insurance available.

# --- The recipe -------------------------------------------------------------------------

# 1. Move the existing checkout aside and take its place. Run this from the PARENT of the
#    repository -- cd-ing into a directory you are about to rename leaves the shell inside
#    the renamed copy.
cd ${parent}
mv ${quote(name)} ${quote(oldName)}
mkdir ${quote(name)}
cd ${quote(name)}

# 2. Bare clone into .bare/, and point a .git file at it. The pointer is what makes every
#    git command run from the container -- or from any checkout under it -- find the
#    repository. Cloning from the OLD CHECKOUT rather than from the remote is what carries
#    local-only branches and unpushed commits across; the remote URL is restored straight
#    after.
git clone --bare ${quote(`../${oldName}`)} .bare
git --git-dir=.bare remote set-url origin ${url}
printf 'gitdir: ./.bare\\n' > .git

# 3. Give the bare clone what \`git clone --bare\` does not set up. Without the refspec
#    nothing ever populates refs/remotes/origin/*; without the upstream \`git pull --ff-only\`
#    has nothing to fast-forward from, so every preflight would silently cut worktrees from
#    a stale base. \`remote set-head\` is belt-and-braces: git 2.47 and newer set origin/HEAD
#    during the fetch above, older git does not.
git --git-dir=.bare config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git --git-dir=.bare fetch origin
git --git-dir=.bare remote set-head origin -a

# 4. Check the default branch out as the first worktree -- the directory is named after the
#    branch -- and set its upstream.
git worktree add ${dir} ${quote(branch)}
git -C ${dir} branch --set-upstream-to=${quote(`origin/${branch}`)} ${quote(branch)}

# --- Verify -----------------------------------------------------------------------------
#
# All six must hold before the old checkout is deleted.
${verification(container, branch, dir)}

# --- Afterwards -------------------------------------------------------------------------
#
# Work from the new checkout, never from the container. The container keeps the path the
# repository always had, so a stale bookmark and plain habit both land one level too high,
# where there is no work tree at all:
#
#     cd ${quote(join(container, dirName))}
#
# From there, re-run the preflight that refused: it should proceed, naming as the container
# the directory step 1 renamed. Then:
#
#   - Copy the untracked files noted at the top into the new checkout.
#   - Re-point whatever held the old path -- tool configs, shell aliases, editor projects, a
#     dotfile manager's source directory.
#   - Remove ${oldName} once all of the above checks out.`;
}
