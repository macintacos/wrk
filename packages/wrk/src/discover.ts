/**
 * Finding a repository when the cwd is in none — the "my worktree was deleted under me" case.
 *
 * Every picker `wrk` offers begins by asking which repository it is in, and
 * [`./repo`](./repo)'s answer to "none" is `{ kind: "outside" }` — correct, and useless on its
 * own. This module is what a command does with it: scan the configured search roots for
 * repository containers, and hand back the one the user meant. {@link resolveRepo} is the
 * whole of that, and it is the first line of a picker command rather than a branch buried
 * inside one.
 *
 * **"Re-enters the normal flow" is a return value, not a recursion.** The fish implementation
 * this replaces ends its recovery with `builtin cd $target; cdwt` — it moves the shell and
 * calls itself. A command that takes its working directory as a parameter needs neither: it
 * asks {@link resolveRepo} where to work and then runs exactly as it would have anywhere else.
 * That is why the answer is a directory, and why a cwd already inside a repository comes back
 * untouched — the recovery is invisible on every run that does not need it.
 *
 * **This module is separate from [`./repo`](./repo) because it can block on a keystroke.**
 * `repo.ts` answers questions about a cwd, and every one of its functions is a pure query over
 * git's output. {@link resolveRepo} opens a picker. Keeping the interactive one out of the
 * module every other module imports is what stops "where am I?" from ever becoming a prompt.
 *
 * **Three things the fish did are deliberately not ported.** Its search path (`~/GitLocal`) and
 * its depth (`find -mindepth 2 -maxdepth 2`) are now `search.roots` and `search.depth`, which
 * [`./config`](./config) has carried since the config layer landed for precisely this caller.
 * And its `while` loop, which walked the cwd upward looking for a path segment named
 * `*worktrees*` and then for one named `*claude*`, is gone entirely: it decoded the old
 * `.claude/worktrees/<name>` nesting, which the bare-repo layout does not have, so under the
 * layout `wrk` actually uses it walked to `/` and found nothing every time. What survives of
 * that guess is its first line — under the bare-repo layout an orphaned cwd is
 * `<container>/<worktree-dir>`, so the parent directory's *name* is the container's name, and
 * that is the hint {@link resolveRepo} prefers a candidate by.
 *
 * @packageDocumentation
 */

import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { NotATerminal, type PickerRow, pick } from "@macintacos/wrk-picker";

import { type ConfigSources, loadConfig } from "./config";
import { Cancelled, Refusal } from "./errors";
import { locate } from "./repo";

/** The bare clone inside a container, as `repoSetup` and the conversion recipe both name it. */
const BARE_DIR = ".bare";

/** The pointer file beside it, holding `gitdir: ./.bare`. A **file**, which is the whole test. */
const GIT_POINTER = ".git";

/**
 * What precedes the query when the picker is opened because there is no repository here.
 *
 * The picker has no header, so the prompt carries the reason. It has to: a picker that opened
 * unannounced, listing directories the user did not ask for, reads as a bug rather than as a
 * recovery.
 */
const PROMPT = "no repository here, pick one ❯ ";

/**
 * Whether `path` is itself a bare-repo container.
 *
 * **Not [`isBareLayout`](./repo), and the difference is the reason this exists.** That
 * predicate answers "is *this cwd's repository* in the bare-repo layout", which from a checkout
 * is `true` while the container is a directory above — so a scan built on it would offer
 * checkouts as repositories. Making it exact costs a third `git` spawn per directory
 * (`containerFor(path) === path`), and a scan runs it across every directory under every
 * configured root.
 *
 * Two `stat`s instead, testing the layout directly: `.bare` is a directory and `.git` is a
 * regular **file**. Both halves are load-bearing for the same reasons `isBareLayout`'s two
 * are — an ordinary repository's `.git` is a directory, and a checkout inside a container has
 * a `.git` file but no `.bare` beside it.
 *
 * A path that does not exist, or is not a directory, is `false` rather than an error: a scan
 * asks this of whatever `readdir` happened to return.
 */
async function isContainer(path: string): Promise<boolean> {
  const [bare, pointer] = await Promise.all([
    stat(join(path, BARE_DIR)).catch(() => null),
    stat(join(path, GIT_POINTER)).catch(() => null),
  ]);

  return (bare?.isDirectory() ?? false) && (pointer?.isFile() ?? false);
}

/**
 * Every container sitting exactly `depth` levels below `dir`, unsorted.
 *
 * Dot-directories are skipped, which is what keeps a scan out of `.bare` and `.git` — a deep
 * enough `search.depth` would otherwise walk a repository's object store, and every directory
 * in it would be `stat`ed twice on the way past.
 *
 * A directory that cannot be read contributes nothing rather than raising. That covers a root
 * that does not exist, one the user cannot read, and a *file* where a directory was expected —
 * `readdir` answers `ENOTDIR` for the last, which is what makes the leaf-vs-branch test free.
 */
async function containersUnder(dir: string, depth: number): Promise<string[]> {
  if (depth === 0) return (await isContainer(dir)) ? [dir] : [];

  const names = await readdir(dir).catch((): string[] => []);
  const below = await Promise.all(
    names
      .filter((name) => !name.startsWith("."))
      .map((name) => containersUnder(join(dir, name), depth - 1)),
  );

  return below.flat();
}

/**
 * Every bare-repo container sitting exactly `depth` levels below one of `roots`.
 *
 * Exactly `depth`, not "up to" — `search.depth` describes where a container *sits*, so a scan
 * that also answered shallower directories would offer the parent of a repository as a
 * repository. `0` means each root is itself a candidate, which is what
 * [`./config`](./config)'s own schema documents.
 *
 * @param roots - Absolute directories to scan. Overlapping roots are fine; each container is
 *   answered once.
 * @param depth - How far below a root a container sits.
 * @returns The containers' absolute paths, deduplicated and sorted. Sorted because the answer
 *   becomes picker rows, and `readdir` order is whatever the filesystem felt like — an
 *   unsorted list would put the same repositories in a different order on two machines.
 *
 * @example
 * ```ts
 * const { roots, depth } = (await loadConfig()).search;
 * await findContainers(roots, depth); // ["/Users/me/GitLocal/Play/wrk", …]
 * ```
 */
export async function findContainers(roots: readonly string[], depth: number): Promise<string[]> {
  const found = await Promise.all(roots.map((root) => containersUnder(root, depth)));

  return [...new Set(found.flat())].sort();
}

/** One container as a picker row: its own name, then the directory holding it. */
function containerRow(container: string): PickerRow<string> {
  return {
    payload: container,
    // Two columns rather than the full path in one, so two repositories of the same name in
    // different roots are told apart by the second while the first is what the user types
    // against. `payload` is the absolute path and is unique across the rows, which is both
    // obligations `PickerRow.payload` places on a caller.
    columns: [{ text: basename(container) }, { text: dirname(container) }],
  };
}

/**
 * A directory inside a repository, recovering interactively when `cwd` is in none.
 *
 * The first call of a picker command. A cwd that is already in a repository — a checkout, a run
 * worktree, or the container itself — comes straight back, and nothing else in this module runs:
 * no config is read and no directory is scanned, so the cost on the ordinary path is the two
 * `rev-parse` spawns {@link locate} makes anyway.
 *
 * Outside a repository, the configured roots are scanned and the answer is narrowed the way the
 * fish implementation narrowed it. Candidates whose directory name matches the orphaned cwd's
 * parent are preferred — under the bare-repo layout that parent *is* the container the deleted
 * worktree lived in — and if none match, every candidate is offered. Either way a single
 * remaining choice is taken without opening anything, which is what makes recovery from a
 * removed worktree silent in the case that matters.
 *
 * The config is loaded with the caller's `sources` and therefore with no container, which is
 * correct rather than a shortcut: `ConfigSources.container` documents `null` as what a caller
 * outside any repository has, so only the machine-wide layer applies. There is no container
 * whose per-repo layer could be read — finding one is the point of the call.
 *
 * @param cwd - Where the command was run.
 * @param sources - Which config layers to read; see `ConfigSources`. Defaults to the
 *   machine-wide file alone.
 * @returns An absolute directory inside a repository: `cwd` itself, or the chosen container.
 * @throws {@link Refusal} when the roots hold no container at all, and when there is a choice
 *   to make but no terminal to make it in — `pick`'s own {@link NotATerminal} is translated
 *   rather than propagated, because an unrecognised throw reaches `reportFailure` as a stack
 *   trace, and "there is nowhere to draw a picker" is a refusal with a sentence to say.
 * @throws {@link Cancelled} when the user dismissed the picker. Thrown rather than returned as
 *   `null` for the reason that class documents: the cd protocol promises a dismissed run leaves
 *   stdout empty, and unwinding is what enforces it.
 *
 * @example
 * ```ts
 * const dir = await resolveRepo(process.cwd());
 * const worktrees = await listWorktrees(dir);
 * ```
 */
export async function resolveRepo(cwd: string, sources: ConfigSources = {}): Promise<string> {
  // A directory that is not there is `outside` by definition, and is the issue's headline case
  // — the worktree you were standing in was removed. It is checked here rather than left to
  // {@link locate} because git would fail to *spawn* rather than answer: `run` rejects with
  // `ENOENT` on a cwd that does not exist, and that rejection is a missing-git report, so
  // nothing downstream maps it to a "no repository" answer.
  const here = await stat(cwd).catch(() => null);
  if (here?.isDirectory() === true && (await locate(cwd)).kind !== "outside") return cwd;

  const { roots, depth } = (await loadConfig(sources)).search;
  const found = await findContainers(roots, depth);
  if (found.length === 0) {
    throw new Refusal(
      `no repository containers found under ${roots.join(", ")}; point search.roots and search.depth at where yours live`,
    );
  }

  const hint = basename(dirname(cwd));
  const named = found.filter((container) => basename(container) === hint);
  const choices = named.length > 0 ? named : found;

  // Indexed through a ternary rather than guarded after the fact, so `noUncheckedIndexedAccess`
  // is satisfied by the one narrowing below instead of by a branch that cannot be reached.
  const only = choices.length === 1 ? choices[0] : undefined;
  if (only !== undefined) return only;

  const chosen = await pick({ rows: choices.map(containerRow), prompt: PROMPT }).catch(
    (error: unknown) => {
      if (error instanceof NotATerminal) throw new Refusal(error.message);
      throw error;
    },
  );
  if (chosen === null) throw new Cancelled("the repository picker was dismissed");

  return chosen;
}
