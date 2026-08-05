/**
 * What a freshly-created worktree lacks, and the four best-effort steps that supply it.
 *
 * A worktree is a clean checkout, so nothing git does not track comes along: a project's
 * `.env` holds secrets that were never committed, its `.codegraph` index was built in the
 * checkout it sits in, and its toolchain is installed per-directory. Until this module has
 * run, git has produced a directory rather than somewhere work can happen.
 *
 * **The order is the contract, and it is load-bearing at both ends.** The refresh must
 * precede the copy, or it updates the index the copy has already left behind. The sync must
 * follow the copy, or the index that arrived still answers about the *source's* branch —
 * which is every stacked layer and every run whose base is not the default branch. Downstream
 * skills are told to treat a new worktree as already seeded and never re-run the install or
 * hand-copy `.env`; that promise is only as good as this order.
 *
 * **Every step is best-effort, and every step is gated on its tool being present.** Git has
 * already created the worktree by the time any of this runs, so no failure here is worth
 * turning that success into an error — but a failure is *reported* rather than swallowed,
 * because a silent step leaves a worktree that merely has no `.env` and nothing to explain
 * it. An absent tool is the one thing that is silent: a machine without `codegraph` is not a
 * machine with a problem.
 *
 * The presence gate is the spawn itself rather than a `PATH` scan. [`./proc`](./proc)'s `run`
 * rejects when the child could not be started at all, so {@link tool} turns that rejection
 * into `null` and no `which` has to be reimplemented — and no window opens between a probe
 * answering and the spawn running. See {@link tool} for the one thing that reading is not
 * allowed to assume.
 *
 * **Progress and warnings go to stderr**, through [`./output`](./output)'s {@link note},
 * leaving stdout to the single JSON document `emit` writes. This module never touches stdout.
 *
 * Two deliberate divergences from `agent_exec_worktree.py`'s `provision`, which this
 * reproduces. Child output is **buffered and then forwarded** rather than streamed live,
 * because `proc.ts` has no `stdio: "inherit"` mode and widening a shared module for one caller
 * is not worth it. That is not free, and the cost is not merely timing: the Python passed an
 * inherited fd, so its caps were deadlines on the *process*, while `run` settles when the
 * output pipes close — see the `ponytail:` note in {@link installMiseTooling} — and a child
 * handed a pipe rather than a terminal drops whatever colour and progress rendering it
 * reserves for a TTY. The channel is unchanged; the enforceability of the caps and the
 * decoration are not. The second divergence is that the mise progress line prints *after*
 * `mise trust` rather than before it, since that call is what establishes the tool is
 * installed at all.
 *
 * One further divergence is a fix rather than a difference: the Python's recursive copy dies
 * on `.codegraph/daemon.sock` — a unix socket no copy can carry — and warns on every single
 * worktree creation. {@link copyContext} filters it out, along with the two neighbouring
 * shapes that would abort a copy the same way.
 *
 * @packageDocumentation
 */

import type { Stats } from "node:fs";
import { cp, lstat, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { git } from "./git";
import { note, PREFIX } from "./output";
import { type RunResult, run } from "./proc";

/** The index directory, in the source checkout and in the worktree alike. */
const CODEGRAPH_DIR = ".codegraph";

/** The untracked secrets file a worktree is seeded with. */
const ENV_FILE = ".env";

/**
 * Hard cap on each `codegraph` call, which indexes a whole repository.
 *
 * 120 s, per the issue's acceptance criteria, and preserved from the Python implementation.
 */
const CODEGRAPH_TIMEOUT_MS = 120_000;

/**
 * Hard cap on each `mise` call, so a hung install cannot wedge a run.
 *
 * 60 s, per the issue's acceptance criteria, and preserved from the Python implementation.
 */
const SETUP_TIMEOUT_MS = 60_000;

/**
 * Project-local config files that mark a checkout as mise-managed, per
 * [mise's configuration docs](https://mise.jdx.dev/configuration.html).
 *
 * Global and system-level paths are deliberately absent — they say nothing about *this*
 * checkout. So are the idiomatic version files (`.python-version`, `.nvmrc`, …): mise can read
 * them but does not treat them as project config by default, so honouring them would falsely
 * flag every pyenv and nvm project. `.tool-versions` is **not** one of those — mise reads it
 * as project config out of the box, for asdf compatibility, and a repository pinning its
 * toolchain that way is precisely one where nothing else will install it.
 */
const MISE_CONFIG_FILES = [
  "mise.toml",
  "mise.local.toml",
  ".mise.toml",
  ".mise.local.toml",
  "mise/config.toml",
  ".mise/config.toml",
  ".config/mise.toml",
  ".config/mise/config.toml",
  ".tool-versions",
] as const;

/** The drop-in directory whose `*.toml` files count as project config too. */
const MISE_CONF_D = ".config/mise/conf.d";

/** `stat` with a missing path as a value rather than a throw. */
function statOf(path: string): Promise<Stats | null> {
  return stat(path).catch(() => null);
}

/**
 * Runs one provisioning tool, answering `null` when it is not installed.
 *
 * This is the presence gate every step shares. `run` rejects only when the child could not be
 * spawned at all, and an `ENOENT` there is mapped to a value; anything else is a real failure
 * and is left to propagate up to {@link bestEffort}.
 *
 * **An `ENOENT` is not proof the binary is missing.** `spawn` reports a `cwd` that does not
 * exist with a byte-identical error — same `code`, same `syscall`, same `path` — so nothing
 * here can tell the two apart, and reading it as "not installed" would swallow a bad `cwd` in
 * the silence this module reserves for an absent tool. What makes the reading safe is that
 * every caller below reaches this only after stat-ing a path *inside* `cwd`: `codegraph` stats
 * the index, and `installMiseTooling` clears `isMiseProject` first. A step added without such
 * a gate must not use this helper.
 *
 * @param cmd - Executable to run.
 * @param args - Arguments after it, one array element per argv entry.
 * @param cwd - Directory to run in.
 * @param timeout - Milliseconds before the child is killed.
 * @returns What the child said, or `null` if there was no child to say it.
 */
function tool(
  cmd: string,
  args: string[],
  cwd: string,
  timeout: number,
): Promise<RunResult | null> {
  return run(cmd, args, { cwd, timeout }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
}

/**
 * Forwards whatever a child wrote to the human channel, saying nothing when it said nothing.
 *
 * The two streams are concatenated rather than interleaved — `run` captures them separately,
 * where the Python merged them into one fd — so a tool that alternates between them comes out
 * regrouped rather than in the order it wrote.
 */
function echo({ stdout, stderr }: RunResult): void {
  const output = `${stdout}${stderr}`.trimEnd();
  if (output !== "") note(output);
}

/**
 * Runs one `codegraph` command against a checkout that already has an index.
 *
 * Two gates, and both are required: the index has to exist, because every subcommand used
 * here operates on one rather than creating one, and the binary has to be installed.
 *
 * @param checkout - Directory to run in.
 * @param args - Subcommand and arguments, excluding the program name.
 */
async function codegraph(checkout: string, ...args: string[]): Promise<void> {
  if ((await statOf(join(checkout, CODEGRAPH_DIR)))?.isDirectory() !== true) return;

  const result = await tool("codegraph", args, checkout, CODEGRAPH_TIMEOUT_MS);
  if (result !== null) echo(result);
}

/**
 * Seeds a new worktree with the untracked context git does not carry over.
 *
 * `force: false` is what makes "never clobber what is already there" a property of both copies
 * rather than of a guard at each path.
 *
 * **`.env` is copied by value.** `dereference` makes a symlinked `.env` arrive as the file it
 * pointed at, which is what the Python's `shutil.copy` did and is the only answer that holds
 * up here: `source` is the *parent worktree* when a layer is stacked, so a link would outlive
 * the directory it names. It also settles a difference between the two runtimes this package
 * straddles, which resolve a copied symlink's target differently.
 *
 * The index is copied structurally instead — `verbatimSymlinks` keeps a relative link pointing
 * where it pointed rather than being rewritten back at the source — because it is a directory
 * of a tool's own making, not a value this module is responsible for the meaning of.
 *
 * **The tracked-file exclusion is not redundant with `force: false`**, and it is the subtle
 * half. Git checks a *tracked* `.codegraph/.gitignore` out into every worktree, so `force:
 * false` already skips it — but a file tracked on the source's branch and absent from the new
 * worktree's branch would be copied in as an **untracked** file, and the next rebase onto a
 * branch that adds it fails before it starts rather than overwriting it. So the decision is
 * per file, not per directory: a directory-level "already there?" guard reads the whole index
 * as seeded and copies nothing. Being per file also means an index only *partly* present in
 * the worktree is filled in rather than skipped whole, which is the Python's one behaviour
 * this deliberately does not reproduce.
 *
 * @param source - Checkout to copy from.
 * @param worktree - Freshly-created worktree to seed.
 * @throws If a copy failed — in practice a destination that is there but is the wrong shape,
 *   such as a plain file where the index directory belongs. A missing source is not a failure
 *   and is guarded above rather than caught.
 */
async function copyContext(source: string, worktree: string): Promise<void> {
  if ((await statOf(join(source, ENV_FILE)))?.isFile() === true) {
    await cp(join(source, ENV_FILE), join(worktree, ENV_FILE), {
      force: false,
      dereference: true,
    });
  }

  const index = join(source, CODEGRAPH_DIR);
  if ((await statOf(index))?.isDirectory() !== true) return;

  // The non-throwing wrapper deliberately: a source in no git checkout tracks nothing, which
  // is also the answer that copies everything.
  const { stdout } = await git(["ls-files", "-z", "--", CODEGRAPH_DIR], source);
  const tracked = new Set(stdout.split("\0").filter((path) => path !== ""));

  await cp(index, join(worktree, CODEGRAPH_DIR), {
    recursive: true,
    force: false,
    verbatimSymlinks: true,
    filter: async (from) => {
      if (tracked.has(relative(source, from))) return false;

      // Three shapes abort the whole copy rather than being skipped, and the live indexer
      // produces all three: it holds a `daemon.sock`, and its journal files appear and vanish
      // between the parent's `readdir` and this `lstat`. `cp` refuses a socket and a FIFO
      // outright, and a `null` here is an entry that no longer exists to copy.
      const entry = await lstat(from).catch(() => null);
      return entry !== null && !entry.isSocket() && !entry.isFIFO();
    },
  });
}

/**
 * Whether mise manages a checkout.
 *
 * Filesystem-only — no mise invocation — so a project mise has no business in stays
 * completely silent and nothing is trusted or installed where nothing asked for it.
 *
 * @param root - Checkout to inspect.
 * @returns `true` if any recognised project-level mise config is present.
 */
async function isMiseProject(root: string): Promise<boolean> {
  const present = await Promise.all(
    MISE_CONFIG_FILES.map(async (name) => (await statOf(join(root, name)))?.isFile() === true),
  );
  if (present.includes(true)) return true;

  // `readdir` rather than a glob: `fs.glob` is still experimental on the Node the published
  // artifact targets, and an ExperimentalWarning on every worktree creation is a worse trade
  // than one directory read.
  const dropIns = await readdir(join(root, MISE_CONF_D)).catch(() => []);
  return dropIns.some((entry) => entry.endsWith(".toml"));
}

/**
 * Trusts and installs a worktree's mise-managed tooling.
 *
 * A worktree's tools may be pinned to versions the machine lacks, and its per-language
 * dependencies (`node_modules`, `.venv`, …) are absent outright, so it is not workable until
 * this runs. **Trust comes first**: a branch may have edited `mise.toml`, which leaves the new
 * path untrusted, and `mise run` refuses an untrusted config rather than running it. It also
 * doubles as this step's presence gate — a `mise` that is not installed cannot be spawned, and
 * there is nothing to announce or install on a machine that has none.
 *
 * `mise run setup` is preferred where the project defines that task, since the mise-hk-init
 * scaffold's `setup` installs tools *and* dependencies; bare `mise install` covers tools only.
 *
 * @param worktree - Freshly-created worktree to provision.
 */
async function installMiseTooling(worktree: string): Promise<void> {
  if (!(await isMiseProject(worktree))) return;

  const trusted = await tool("mise", ["trust", "--quiet"], worktree, SETUP_TIMEOUT_MS);
  if (trusted === null) return;
  echo(trusted);

  note(`${PREFIX}provisioning mise tooling in ${worktree}`);
  const probe = await run("mise", ["tasks", "info", "setup"], {
    cwd: worktree,
    timeout: SETUP_TIMEOUT_MS,
  });
  const argv = probe.code === 0 ? ["run", "setup"] : ["install"];

  // ponytail: `run` settles when the output pipes close, so this is a cap on `mise` and not on
  // the `bun install` grandchild that inherited the pipe — and the whole install log is
  // buffered before any of it is forwarded. This is the first caller of `run` to spawn a build
  // rather than a `git` query, so it is the first place either ceiling can be reached. Give
  // `proc.ts` an inherit-stdio mode if a wedged install or an unbounded log ever shows up.
  const installed = await run("mise", argv, { cwd: worktree, timeout: SETUP_TIMEOUT_MS });
  echo(installed);
  const outcome = installed.code === 0 ? "ready" : `failed (exit ${installed.code})`;
  note(`${PREFIX}\`mise ${argv.join(" ")}\` → worktree ${outcome}`);
}

/**
 * Runs one provisioning step, reporting rather than raising on failure.
 *
 * The catch is deliberately total. Git has already created the worktree, so nothing a step can
 * throw is worth failing that success over — and isolating each step is also what keeps one
 * broken step from taking the three after it down with it.
 *
 * @param label - What to call the step in the warning it may emit.
 * @param step - The step to run.
 */
async function bestEffort(label: string, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    note(`${PREFIX}${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Brings a freshly-created worktree up to the state a session expects.
 *
 * The four calls below are the whole specification — see this module's header for why their
 * order is load-bearing and why none of them can fail the run.
 *
 * @param source - The checkout the run was invoked from, and the context to copy from. On a
 *   fresh run that is the default-branch checkout; when stacking a layer it is the parent
 *   worktree, which is the right answer in both cases.
 * @param worktree - Freshly-created worktree to provision.
 * @returns Once every step has been attempted. Never rejects.
 *
 * @example
 * ```ts
 * // Nothing to catch and nothing to read: the worktree exists either way, and everything
 * // this has to say went to stderr while it ran.
 * await provision(from, path);
 * ```
 */
export async function provision(source: string, worktree: string): Promise<void> {
  await bestEffort("codegraph refresh", async () => {
    await codegraph(source, "index");
    await codegraph(source, "sync");
  });
  await bestEffort("context copy", () => copyContext(source, worktree));
  await bestEffort("codegraph sync", () => codegraph(worktree, "sync"));
  await bestEffort("mise install", () => installMiseTooling(worktree));
}
