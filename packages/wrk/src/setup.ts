/**
 * The `repo-setup` engine: clones a repository straight into a fresh bare-repo container.
 *
 * The one entry point in `wrk`'s agent surface that covers a repository which is not on disk
 * yet. [`./convert`](./convert) prints a recipe for a checkout that already exists, and
 * [`./preflight`](./preflight) refuses with `unconverted-repo` and names the skill that runs
 * this — neither can help when there is nothing to convert. The steps are the conversion
 * recipe's, minus the half that relocates an existing checkout, with the checkout directory
 * named from the *resolved* default branch rather than assumed.
 *
 * **The cwd is the container.** There is no destination argument: the caller places the
 * repository by choosing where to run, which is what makes the command composable with a
 * `mkdir` the caller already had to do.
 *
 * **Two properties of how git is invoked, and both are security properties rather than
 * preferences.**
 *
 * `GIT_TERMINAL_PROMPT=0` is set on every call that reaches the network — the clone, the fetch
 * *and* the `set-head`. git reads `/dev/tty` directly, so capturing a child's output does not
 * suppress its credential prompt: an unauthenticated call would block forever having written
 * nothing, wedging the calling agent's subprocess instead of failing it. All three talk to the
 * remote, and a credential helper that answered the clone need not still answer the two after
 * it.
 *
 * **Every argv position carrying remote- or caller-supplied data is preceded by a `--`.** The
 * URL is the obvious one: an agent relays whatever a human or a ticket body supplied, a leading
 * `--upload-pack=<cmd>` is a command git would run, and without the separator git consumes it as
 * its own option and reads `.bare` as the repository, so the failure would not even name the
 * input that caused it. The branch name is the less obvious one and gets the same treatment —
 * it is read back off `origin/HEAD`, so it comes from the remote, and `refs/heads/-x` is a name
 * `git check-ref-format` accepts and a bare clone fetches. Neither `worktree add` nor `branch`
 * has an option that executes anything, so that one fails closed today; the separator is there
 * so the boundary is a property of the argv rather than of which options git happens to have.
 *
 * **A failure empties the cwd rather than leaving a half-built container**, and that matters
 * more than the usual tidiness argument: `.bare` plus the `.git` pointer *is* a repository, so
 * wreckage left behind trips {@link repoSetup}'s own inside-a-repository refusal on the next
 * attempt and sends the user off to convert a container with no checkout in it. The steps are
 * not as infallible as they look — the fetch reaches the network, and `remote set-head` fails
 * outright against a repository with no commits, which a freshly-created remote is.
 *
 * @packageDocumentation
 */

import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Refusal } from "./errors";
import { gitCommonDir, gitOk } from "./git";
import { worktreeDirName } from "./naming";
import { note, PREFIX } from "./output";
import { provisionCheckout } from "./provision";
import { resolveDefaultBranch } from "./repo";

/** The bare clone's directory inside the container, and the target of the `.git` pointer. */
const BARE_DIR = ".bare";

/**
 * What `git clone --bare` does not configure, and without which nothing ever populates
 * `refs/remotes/origin/*` — leaving the checkout with no upstream to fast-forward from.
 */
const ORIGIN_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

/**
 * The environment every networked step runs under — see this module's header.
 *
 * Named for what it does rather than for the Python's `offline`, which reads as the opposite of
 * the truth: this marks precisely the three calls that *do* reach the network, and all it
 * suppresses there is the credential prompt.
 */
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0" } as const;

/**
 * What `repo-setup` produced: the container, the checkout in it, and the branch that named it.
 *
 * **The property names are snake_case deliberately, and frozen.** This is not a
 * TypeScript-internal type — it is serialised straight into the run's JSON envelope, and its
 * consumers are shell one-liners reading `jq -er .checkout_path`. Renaming a property renames
 * the field, and every one of those callers fails at the `-e` rather than at anything that says
 * why.
 *
 * The properties are declared in the order the envelope emits them — `envelope` inherits
 * `JSON.stringify`'s insertion-order walk — which is why {@link repoSetup} builds its result as
 * a single object literal rather than assembling it.
 */
export interface Initialized {
  /**
   * Absolute path of the container that was built.
   *
   * The cwd the command ran in, and the `worktree_root` every later `preflight` reports.
   */
  container: string;

  /** Absolute path of the default-branch checkout inside it. */
  checkout_path: string;

  /** The branch that checkout is on, which also named its directory. */
  default_branch: string;
}

/**
 * Deletes everything a failed {@link repoSetup} left behind.
 *
 * Safe to empty the directory outright because {@link repoSetup} refused unless the cwd was
 * empty, so nothing in it predates the run.
 *
 * **Every failure here is swallowed**, which is the one thing this function must get right: it
 * runs from a `catch`, so a rejection would replace the {@link CommandFailed} carrying git's exit
 * status and stderr with a filesystem error `reportFailure` does not recognise — turning a
 * one-line refusal into a stack trace and losing the status the caller is meant to inherit.
 * `force: true` alone does not cover it: it ignores `ENOENT` and nothing else.
 *
 * Sequential rather than concurrent, for the reason `cache.ts` records: recursive `rm` calls
 * overlapping in one directory fail with `EFAULT` on Bun
 * ([oven-sh/bun#36984](https://github.com/oven-sh/bun/issues/36984)), and the entries here are
 * few enough that there is nothing to win by racing them anyway.
 *
 * @param cwd - The container being discarded.
 */
async function discardPartialContainer(cwd: string): Promise<void> {
  // ponytail: empties the directory rather than removing the three paths this run created, so a
  // file that arrived *during* a multi-minute clone goes with it. Naming them instead is more
  // code, not less -- the checkout's name is not known until `resolveDefaultBranch` answers, so
  // a failure before that has nothing to name. Narrow the deletion if it ever bites.
  const entries = await readdir(cwd).catch(() => []);
  for (const entry of entries) {
    await rm(join(cwd, entry), { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Clones `url` into a fresh bare-repo container at `cwd`.
 *
 * **The two refusals are ordered, and the order is the contract.** An existing checkout trips
 * both — it is inside a repository *and* it is not empty — and only the first has advice that
 * applies to it. Reversed, someone standing in their own repository would be told to go and
 * find an empty directory.
 *
 * `git.ts` unsets every variable `git rev-parse --local-env-vars` names, so an inherited
 * `GIT_DIR` cannot reach the inside-a-repository probe and make it answer "yes" for any
 * directory at all. The residual is a git that honours a binding variable that list omits, and
 * it fails safe: a spurious refusal, never a clone into somebody else's repository.
 *
 * **The checkout directory is folded**, where the Python implementation this reproduces leaves
 * the branch name as it found it. The checkout is a flat sibling of `.bare`, so a default branch
 * carrying a `/` has to fold exactly as a run worktree's does — [`./convert`](./convert) already
 * settled that for the recipe it prints, and the two render the same layout. For every default
 * branch anyone actually has, the folded and unfolded names are identical.
 *
 * The checkout is provisioned last and **outside the cleanup boundary**: git has built the whole
 * container by then, and a machine without a toolchain is not a reason to delete a repository.
 *
 * @param cwd - Directory to build the container in. It *is* the container.
 * @param url - What to clone, in any form `git clone` accepts.
 * @returns The container, the checkout inside it, and the default branch — see
 *   {@link Initialized}.
 * @throws {@link Refusal} if `cwd` is inside a repository or is not empty — each naming the
 *   directory, since it is the one thing the user has to look at and nothing else in the output
 *   carries it — or, from inside the cleanup boundary, if the clone produced no branch to check
 *   out. That third one names the URL instead, and see its throw site for why it is unreachable
 *   in practice.
 * @throws {@link CommandFailed} if any git step failed. It carries git's own exit status, which
 *   is what `wrk` exits with, so nothing here needs to map it — and the cwd has been emptied
 *   before it is raised.
 *
 * @example
 * ```ts
 * await repoSetup(process.cwd(), "git@github.com:owner/project.git");
 * // { container: "/…/project", checkout_path: "/…/project/main", default_branch: "main" }
 * ```
 */
export async function repoSetup(cwd: string, url: string): Promise<Initialized> {
  if ((await gitCommonDir(cwd)) !== null) {
    throw new Refusal(
      `${cwd} is already inside a git repository; convert that repository instead — see the repo-setup skill`,
    );
  }

  if ((await readdir(cwd)).length > 0) {
    throw new Refusal(
      `${cwd} is not empty, so there is nowhere to clone into; run this from an empty directory`,
    );
  }

  note(`${PREFIX}cloning ${url} into ${cwd}`);

  const bare = join(cwd, BARE_DIR);
  let checkout: string;
  let defaultBranch: string;
  try {
    await gitOk(["clone", "--bare", "--", url, BARE_DIR], cwd, NO_PROMPT);
    // The pointer is what makes every git command run from the container -- or from any
    // checkout under it -- find the repository.
    await writeFile(join(cwd, ".git"), `gitdir: ./${BARE_DIR}\n`, "utf8");

    await gitOk(["config", "remote.origin.fetch", ORIGIN_REFSPEC], bare);
    await gitOk(["fetch", "origin"], bare, NO_PROMPT);
    // Belt-and-braces: git 2.47 and newer set origin/HEAD during the fetch above, older git
    // does not -- and `resolveDefaultBranch` reads it first.
    await gitOk(["remote", "set-head", "origin", "-a"], bare, NO_PROMPT);

    const branch = await resolveDefaultBranch(cwd);
    if (branch === null) {
      // Unreachable in practice: `set-head -a` above fails outright unless the remote had a HEAD
      // to copy, and a resolvable HEAD is a branch. Thrown rather than asserted because
      // `resolveDefaultBranch` is honestly nullable, and a refusal is the honest answer.
      throw new Refusal(`${url} has no branch to check out; clone it by hand and look at it`);
    }

    // Bound once: the directory name and the path have to agree, and two calls can drift.
    const dir = worktreeDirName(branch);
    defaultBranch = branch;
    checkout = join(cwd, dir);
    await gitOk(["worktree", "add", "--", dir, branch], cwd);
    await gitOk(["branch", `--set-upstream-to=origin/${branch}`, "--", branch], checkout);
  } catch (error) {
    await discardPartialContainer(cwd);
    throw error;
  }

  await provisionCheckout(checkout);

  return { container: cwd, checkout_path: checkout, default_branch: defaultBranch };
}
