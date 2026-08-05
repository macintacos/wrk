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
 * The recipe's steps, and the reasoning comments they carry, are the prose form kept in the
 * `repo-setup` skill's `bare-repo-conversion.md` reference. This module is that reference
 * with the repository's real container, remote and default branch substituted in.
 *
 * @packageDocumentation
 */

import { basename, dirname } from "node:path";

import { git } from "./git";
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
 * Characters that need no shell quoting, as `shlex.quote` defines the set.
 *
 * Deliberately conservative: anything outside it is quoted rather than reasoned about.
 */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * `value` as a single shell word.
 *
 * The recipe is written to be pasted into a shell, so an unquoted path containing a space
 * does not merely look wrong — it splits into two words, and step 1's `mv` then renames
 * something the caller did not mean. A single-quoted string is literal to every POSIX shell,
 * so the only case needing care is an embedded `'`, closed and re-opened around an escaped
 * one.
 *
 * The empty string is quoted too, since bare it would vanish rather than be an argument.
 */
function quote(value: string): string {
  return SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The six checks of the verification gate, rendered with their expectations aligned. */
function verification(container: string, branch: string, quotedBranch: string): string {
  const checks: ReadonlyArray<readonly [string, string]> = [
    [`git -C ${quotedBranch} config core.bare`, "true"],
    ["ls -l .git", "a FILE holding `gitdir: ./.bare`, not a directory"],
    [`git -C ${quotedBranch} rev-parse --git-common-dir`, `${container}/.bare`],
    [`git -C ${quotedBranch} rev-parse --abbrev-ref '@{upstream}'`, `origin/${branch}`],
    [`git -C ${quotedBranch} branch --list`, "every branch the old checkout had"],
    [`git -C ${quotedBranch} status`, `clean, on ${branch}`],
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
 * can be pasted into a terminal and read top to bottom without a paragraph of prose trying
 * to execute. The prose here talks about `mv` and `rm`, so that is a safety property rather
 * than a stylistic one.
 *
 * A value that did not resolve renders as an angle-bracketed placeholder — quoted, like
 * every other substitution, which keeps it from being read as a shell redirection if the
 * block is pasted before the caller fills it in.
 *
 * @param conversion - What {@link resolveConversion} read.
 * @returns The recipe, ending in exactly one newline.
 */
export function renderConversion(conversion: Conversion): string {
  const { container, remoteUrl, defaultBranch } = conversion;
  const branch = defaultBranch ?? "<default-branch>";
  const name = basename(container);
  const parent = quote(dirname(container));
  const old = quote(`${name}.old`);
  const url = quote(remoteUrl ?? "<remote-url>");
  const b = quote(branch);

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
#
# Local-only branches and unpushed commits do survive, because step 2 clones from the old
# checkout rather than from the remote. Keeping that old checkout until the verification
# below passes is the cheapest insurance available.

# --- The recipe -------------------------------------------------------------------------

# 1. Move the existing checkout aside and take its place. Run this from the PARENT of the
#    repository -- cd-ing into a directory you are about to rename leaves the shell inside
#    the renamed copy.
cd ${parent}
mv ${quote(name)} ${old}
mkdir ${quote(name)}
cd ${quote(name)}

# 2. Bare clone into .bare/, and point a .git file at it. The pointer is what makes every
#    git command run from the container -- or from any checkout under it -- find the
#    repository. Cloning from the OLD CHECKOUT rather than from the remote is what carries
#    local-only branches and unpushed commits across; the remote URL is restored straight
#    after.
git clone --bare ${quote(`../${name}.old`)} .bare
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
git worktree add ${b} ${b}
git -C ${b} branch --set-upstream-to=${quote(`origin/${branch}`)} ${b}

# --- Verify -----------------------------------------------------------------------------
#
# All six must hold before the old checkout is deleted.
${verification(container, branch, b)}

# Then re-run the preflight that refused, from the new checkout:
#
#     cd ${container}/${branch}
#
# It should proceed, naming as the container the directory step 1 renamed. Only once it
# does, remove ${name}.old.
`;
}
