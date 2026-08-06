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
 * **"Re-enters the normal flow" is a return value, not a recursion.** The recovery ends by
 * *answering a directory*, which the caller then works from exactly as it would work from any
 * other — [`./cli`](./cli) spells that as `chooseWorktree(await resolveRepo(process.cwd()))`.
 * The shell implementation this replaces has to `cd` and call itself instead, because its
 * every step reads the shell's own `$PWD`; a module whose functions all take a `cwd` does not.
 *
 * **This module is separate from [`./repo`](./repo) because it can block on a keystroke.**
 * `repo.ts` answers questions about a cwd, and every one of its functions is a pure query over
 * git's output. {@link resolveRepo} opens a picker. Keeping the interactive one out of the
 * module every other module imports is what stops "where am I?" from ever becoming a prompt.
 *
 * **The search path and depth are configuration, not constants.** `search.roots` and
 * `search.depth` have sat unread in [`./config`](./config) since the config layer landed, for
 * precisely this caller; they are what replaces the `find ~/GitLocal -mindepth 2 -maxdepth 2`
 * the shell implementation hardcodes, and a root whose containers sit at a different nesting is
 * unusable with either frozen.
 *
 * **Which candidate the orphan meant is decided by path containment, not by name.** A cwd that
 * is no longer a work tree is still *written down* as a path, and the container it lived in is
 * whichever candidate that path sits inside — at any depth, whether the shell was in the
 * worktree root or four directories below it. Matching on the directory *name* instead is both
 * looser and tighter in the ways that hurt: `~/Downloads/wrk/tmp` would silently resolve to the
 * real `wrk` container, while `<container>/<worktree>/packages/wrk` would match nothing at all.
 *
 * @packageDocumentation
 */

import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import { NotATerminal, type PickerRow, pick } from "@macintacos/wrk-picker";

import { type ConfigSources, loadConfig } from "./config";
import { Cancelled, Refusal } from "./errors";
import { containerFor } from "./repo";

/** The bare clone inside a container, as `repoSetup` and the conversion recipe both name it. */
const BARE_DIR = ".bare";

/** The pointer file beside it, holding `gitdir: ./.bare`. */
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
 * enough `search.depth` would otherwise walk a repository's object store, `readdir`ing
 * thousands of directories to reach a level that holds no container.
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
 * @param roots - Absolute directories to scan. Listing one twice is fine; each container *path*
 *   is answered once. Two roots reaching the same container by different paths — one of them
 *   through a symlink — are two answers, because the deduplication is over the strings.
 * @param depth - How far below a root a container sits.
 * @returns The containers' absolute paths, deduplicated and sorted. Built by `join` and
 *   therefore **not** realpath-resolved, unlike every path [`./repo`](./repo) returns: what
 *   comes back is a directory to work *from*, spelled the way the user's own config spells it,
 *   and a caller keying a cache off the repository still goes through `containerFor`. Sorted
 *   because the answer becomes picker rows, and `readdir` order is whatever the filesystem felt
 *   like — an unsorted list would order the same repositories differently on two machines.
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
 * no config is read and no directory is scanned, so the ordinary path costs one `rev-parse`
 * spawn and one `stat`.
 *
 * Outside a repository, the configured roots are scanned and the candidates narrowed to the one
 * `cwd` sits inside, if any — see this module's header for why containment rather than the
 * directory's name. A single remaining choice is taken without opening anything, which is what
 * makes recovery from a removed worktree silent in the case that matters; several open the
 * picker; and when nothing contains `cwd` the whole set is offered rather than nothing.
 *
 * The config is loaded with the caller's `sources` and therefore with no container, which is
 * correct rather than a shortcut: `ConfigSources.container` documents `null` as what a caller
 * outside any repository has, so only the machine-wide layer applies. There is no container
 * whose per-repo layer could be read — finding one is the point of the call.
 *
 * @param cwd - Where the command was run. A path that **does not exist** is accepted and is the
 *   removed-worktree case — but reaching it takes care on the caller's side, because
 *   `process.cwd()` cannot produce one: Bun refuses to start a script at all when its working
 *   directory has been unlinked, and Node's `process.cwd()` throws `ENOENT`. A caller that wants
 *   the shell's own idea of where it stands, which survives the unlink, passes `$PWD` through
 *   rather than reading it back from the process.
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
  // The existence check is not redundant with `containerFor`: git would fail to *spawn* on a
  // directory that is not there, and `run` rejects that as `ENOENT` — a report that git is
  // missing, which nothing downstream maps back to "no repository".
  const here = await stat(cwd).catch(() => null);
  if (here?.isDirectory() === true && (await containerFor(cwd)) !== null) return cwd;

  const { roots, depth } = (await loadConfig(sources)).search;
  const found = await findContainers(roots, depth);
  if (found.length === 0) {
    throw new Refusal(
      `no repository containers found under ${roots.join(", ")}; point search.roots and search.depth at where yours live`,
    );
  }

  const inside = found.filter((c) => cwd === c || cwd.startsWith(`${c}${sep}`));
  const choices = inside.length > 0 ? inside : found;

  // Indexed through a ternary so `noUncheckedIndexedAccess` is satisfied by one narrowing
  // rather than by a branch that cannot be reached.
  const only = choices.length === 1 ? choices[0] : undefined;
  if (only !== undefined) return only;

  const chosen = await pick({ rows: choices.map(containerRow), prompt: PROMPT }).catch(
    (error: unknown) => {
      if (error instanceof NotATerminal)
        throw new Refusal(`no repository here, and ${error.message}`);
      throw error;
    },
  );
  if (chosen === null) throw new Cancelled("the repository picker was dismissed");

  return chosen;
}
