/**
 * The `create` engine: places a run worktree beside its siblings in the repository's
 * bare-repo container.
 *
 * One exported function, taking a cwd and the branch to create, returning the path it built.
 * **Nothing here knows a CLI exists** — it neither parses arguments, nor writes to a stream,
 * nor decides an exit status. That is not tidiness for its own sake: `create` is invoked from
 * the editor's `WorktreeCreate` hook and from agent skills that pipe stdout through `jq -er
 * .worktree_path`, so the answer has to be a value the command layer renders through
 * `output.ts`'s envelope rather than text this module prints. Keeping the split at the
 * function boundary is also what lets the whole contract below be pinned by tests that call
 * it directly, with no subprocess and no argv in the way.
 *
 * The repository rules it works from all live in `repo.ts`, and the naming rules in
 * `naming.ts`; this module is the composition of the two plus the single `git worktree add`
 * that follows from them.
 *
 * **Provisioning is not here.** Copying a codegraph index, seeding `.env`, running `mise
 * install` — everything that makes a fresh worktree usable rather than merely present — is
 * EXC-1000's, and lands on top of the path this returns.
 *
 * @packageDocumentation
 */

import { join } from "node:path";

import { addWorktree } from "./git";
import { worktreeDirName } from "./naming";
import { Refusal } from "./output";
import { checkoutFor, containerFor, isBareLayout, resolveDefaultBranch } from "./repo";

/**
 * What `create` produced: the worktree that now exists, and the branch checked out in it.
 *
 * **`worktree_path` is snake_case deliberately, and the name is frozen.** This is not a
 * TypeScript-internal type — it is serialised straight into the run's JSON envelope, and its
 * consumers are shell one-liners across two agent skill trees reading `jq -er
 * .worktree_path`. Renaming the property renames the field, and every one of those callers
 * fails at the `-e` rather than at anything that says why. Biome's recommended preset
 * enforces no naming convention, so nothing needs silencing here to keep it.
 *
 * The properties are declared in the order the envelope emits them — `envelope` inherits
 * `JSON.stringify`'s insertion-order walk — which is why {@link createWorktree} builds its
 * result as a single object literal rather than assembling it.
 */
export interface Created {
  /** Absolute path of the worktree that now exists. */
  worktree_path: string;

  /** The branch checked out in it, exactly as it was asked for — unfolded. */
  branch: string;
}

/** What to create. */
export interface CreateOptions {
  /**
   * The branch to create and check out, e.g. `EXC-1/add-thing`.
   *
   * Reaches `git worktree add -b` verbatim. Only the *directory* folds its slashes — see
   * {@link worktreeDirName}.
   */
  branch: string;

  /**
   * Commit-ish the branch starts at. Defaults to the repository's default branch.
   *
   * A tag, a sha or a remote-tracking ref are all equally acceptable; git resolves it, this
   * module does not.
   */
  base?: string;
}

/**
 * Creates a run worktree for `branch`, as a sibling inside `cwd`'s container.
 *
 * **`cwd` is resolved to a checkout first**, through {@link checkoutFor}, because callers
 * routinely have none. The editor's `WorktreeCreate` hook runs with `<container>/.bare` as
 * its cwd, and the container itself keeps the path the repository had before conversion, so
 * stale bookmarks and plain habit both land there — neither is a work tree, and `git worktree
 * add` run from a bare repository resolves a bare `base` name against a different HEAD than
 * the user is looking at. Resolving to the default-branch checkout first makes every one of
 * those cwds behave like the ordinary case.
 *
 * When no worktree holds the default branch, `cwd` is used as it was found. That is
 * deliberate parity with the Python implementation this replaces: git is left to report the
 * missing work tree in its own words rather than having a second refusal invented here for a
 * state the layer below already describes precisely.
 *
 * **An unconverted repository is a refusal, not a verdict.** Commands that *survey* a
 * repository answer with a verdict and exit 0, because their contract is "here is what I
 * found" and "blocked" is a finding. This command's contract is "the worktree now exists", so
 * a repository with nowhere to put one leaves nothing to report — there is no partial
 * success, and a `Refusal` exits 1 with the one line that says how to fix it.
 *
 * **The start point is passed explicitly rather than left to git.** With neither `-b` nor a
 * commit-ish, `git worktree add`'s convenience DWIM names the branch after the directory's
 * basename — which under this layout is the *folded* name, minting `EXC-1+add-thing` — or,
 * where `worktree.guessRemote` is set, silently tracks a same-named remote branch instead. A
 * run's branch and base are decisions `wrk` has already made by this point; neither is
 * something a directory name or a config setting gets a vote in.
 *
 * @param cwd - Anywhere in the repository: a checkout, a run worktree, the container, or
 *   `<container>/.bare`.
 * @param options - The branch to create, and optionally what to base it on.
 * @returns The absolute path of the new worktree and the branch in it — see {@link Created}.
 * @throws {@link Refusal} if `cwd`'s repository is not a bare-repo container, including when
 *   it is no repository at all.
 * @throws {@link CommandFailed} if git refused — the branch already exists, the path is
 *   taken, the base does not resolve. It carries git's own exit status, which is what `wrk`
 *   exits with, so nothing here needs to map it.
 *
 * @example
 * ```ts
 * await createWorktree(process.cwd(), { branch: "EXC-1/add-thing" });
 * // { worktree_path: "/…/repo/EXC-1+add-thing", branch: "EXC-1/add-thing" }
 * ```
 */
export async function createWorktree(cwd: string, options: CreateOptions): Promise<Created> {
  const { branch, base } = options;
  const from = (await checkoutFor(cwd)) ?? cwd;

  // Concurrent because neither answer depends on the other and both are process spawns —
  // the precedent `locate` sets for the same pair of probes.
  const [container, bare] = await Promise.all([containerFor(from), isBareLayout(from)]);
  if (container === null || !bare) {
    throw new Refusal(
      "not a bare-repo container, so there is nowhere to place a sibling worktree; convert it first with the repo-setup skill",
    );
  }

  const path = join(container, worktreeDirName(branch));
  // `undefined` omits the start point rather than substituting one, leaving git to use the
  // repository's HEAD — the only honest answer when no default branch resolves, and one that
  // needs no extra branch here to express.
  await addWorktree(path, from, {
    branch,
    startPoint: base ?? (await resolveDefaultBranch(from)) ?? undefined,
  });

  return { worktree_path: path, branch };
}
