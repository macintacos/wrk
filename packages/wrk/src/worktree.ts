/**
 * The `create` engine: places a run worktree beside its siblings in the repository's
 * bare-repo container.
 *
 * One exported function, returning the path it built rather than printing it — the two stdout
 * shapes its callers need are `output.ts`'s to choose between, not this module's.
 *
 * The repository rules it works from all live in `repo.ts`, and the naming rules in
 * `naming.ts`; this module is the composition of the two plus the single `git worktree add`
 * that follows from them.
 *
 * **Provisioning is part of it**, and lives in [`./provision`](./provision): copying a
 * codegraph index, seeding `.env`, running `mise install` — everything that makes a fresh
 * worktree usable rather than merely present. It runs here rather than in the command above it
 * because this function has already resolved the checkout to provision *from*, and because a
 * caller asking for a worktree wants a workable one; see {@link createWorktree}.
 *
 * @packageDocumentation
 */

import { join } from "node:path";

import type { CommandFailed } from "./errors";
import { Refusal } from "./errors";
import { addWorktree } from "./git";
import { worktreeDirName } from "./naming";
import { provision } from "./provision";
import { checkoutFor, containerFor, isBareLayout, resolveDefaultBranch, UNCONVERTED } from "./repo";

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
 * routinely have none: the editor's `WorktreeCreate` hook runs with `<container>/.bare` as
 * its cwd, and the container keeps the path the repository had before conversion, so stale
 * bookmarks and plain habit both land there. What that resolution buys is the meaning of a
 * `HEAD`-relative `base` and of the omitted-start-point case below — both are read from
 * whichever repository `from` names, and the user means the checkout's HEAD, not the bare
 * repository's. Plain ref names, tags and shas resolve identically either way, refs being
 * shared, so this is narrower than it looks and is pinned by exactly one test.
 *
 * When no worktree holds the default branch, `cwd` is used as it was found — the same
 * degradation the Python implementation this replaces documents. Nothing below needs a work
 * tree: the container lookup, the layout check and `git worktree add` all answer perfectly
 * well from a bare repository, so there is no failure here to pre-empt.
 *
 * **An unconverted repository is a {@link Refusal}, not a verdict**, because this command's
 * contract is that the worktree now exists — leaving nothing partial to report.
 *
 * **The start point is passed explicitly rather than left to git.** With `-b` and no
 * commit-ish, `git worktree add` starts the branch at `from`'s own HEAD — which from a run
 * worktree parked on `release` is `release`, not the repository's default branch. What a run
 * branches from is a decision `wrk` has already made by this point, and it is not one the
 * caller's current checkout gets a vote in.
 *
 * **The new worktree is then provisioned**, through {@link provision} — the codegraph index,
 * the untracked `.env`, and the mise toolchain. `from` is what it copies from, which is the
 * default-branch checkout on a fresh run and the parent worktree when stacking a layer: the
 * right answer in both cases, and already in hand here, where composing the two calls a level
 * up would spend two or three git spawns rediscovering it. Provisioning is best-effort and
 * writes only to stderr, so it can neither reject nor alter the value returned below —
 * `git worktree add` has already succeeded by then, and a missing `.env` is not a reason to
 * report a worktree that exists as one that does not.
 *
 * @param cwd - Anywhere in the repository: a checkout, a run worktree, the container, or
 *   `<container>/.bare`.
 * @param options - The branch to create, and optionally what to base it on.
 * @returns The absolute path of the new worktree and the branch in it — see {@link Created}.
 * @throws {@link Refusal} if `cwd` is in no repository at all, or is in one that is not a
 *   bare-repo container. The two carry different messages: only the second has something to
 *   convert.
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

  // Sequential, not concurrent: `isBareLayout` opens by calling `containerFor` itself, so
  // overlapping the two would race a probe against its own duplicate — and would spend the
  // second spawn precisely where `repo.ts` documents `isBareLayout` as short-circuiting to
  // avoid it, outside a repository.
  const container = await containerFor(from);
  if (container === null) {
    throw new Refusal("not a git repository; run this from inside the repository to add to");
  }

  if (!(await isBareLayout(from))) {
    throw new Refusal(UNCONVERTED);
  }

  const path = join(container, worktreeDirName(branch));
  // `undefined` omits the start point rather than substituting one, leaving git to start the
  // branch at `from`'s own HEAD — the only honest answer when no default branch resolves, and
  // one that needs no extra branch here to express.
  await addWorktree(path, from, {
    branch,
    startPoint: base ?? (await resolveDefaultBranch(from)) ?? undefined,
  });

  await provision(from, path);

  return { worktree_path: path, branch };
}
