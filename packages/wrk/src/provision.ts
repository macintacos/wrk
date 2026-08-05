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
 * rejects when the child could not be started at all, which is exactly what a missing binary
 * is, so {@link tool} turns that rejection into `null` and no `which` has to be reimplemented
 * — and no window opens between a probe answering and the spawn running.
 *
 * **Progress and warnings go to stderr**, through [`./output`](./output)'s {@link note},
 * leaving stdout to the single JSON document `emit` writes. This module never touches stdout.
 *
 * Two deliberate divergences from `agent_exec_worktree.py`'s `provision`, which this
 * reproduces. Child output is **buffered and then forwarded** rather than streamed live,
 * because `proc.ts` has no `stdio: "inherit"` mode and widening a shared module for one caller
 * is not worth it; the channel and the content are unchanged, only the timing. And the mise
 * progress line prints *after* `mise trust` rather than before it, since that call is what
 * establishes the tool is installed at all. One divergence is a fix rather than a difference:
 * the Python's recursive copy dies on `.codegraph/daemon.sock` — a unix socket no copy can
 * carry — and warns on every single worktree creation. {@link copyContext} filters it out.
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
 * checkout — and so are the `.env`-style files mise can read but does not treat as project
 * config, which are off by default and would falsely flag every pyenv or nvm project.
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
 * spawned at all, so an `ENOENT` is precisely "that binary is not on `PATH`" and is mapped to
 * a value; anything else is a real failure and is left to propagate up to {@link bestEffort}.
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

/** Forwards whatever a child wrote to the human channel, saying nothing when it said nothing. */
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
 * `force: false` is what makes "never clobber what is already there" a property of the copy
 * rather than of a guard at each path, and `verbatimSymlinks` keeps a relative link pointing
 * where it pointed instead of being rewritten back at the source.
 *
 * **The tracked-file exclusion is not redundant with that**, and it is the subtle half. Git
 * checks a *tracked* `.codegraph/.gitignore` out into every worktree, so `force: false`
 * already skips it — but a file tracked on the source's branch and absent from the new
 * worktree's branch would be copied in as an **untracked** file, and the next rebase onto a
 * branch that adds it fails before it starts rather than overwriting it. So the decision is
 * per file, not per directory: a directory-level "already there?" guard reads the whole index
 * as seeded and copies nothing.
 *
 * Sockets are excluded because no recursive copy can carry one, and one aborts the copy
 * outright — `.codegraph` holds a live `daemon.sock` whenever the indexer is running.
 *
 * @param source - Checkout to copy from.
 * @param worktree - Freshly-created worktree to seed.
 * @throws If a copy failed for any reason other than the source not being there.
 */
async function copyContext(source: string, worktree: string): Promise<void> {
  if ((await statOf(join(source, ENV_FILE)))?.isFile() === true) {
    await cp(join(source, ENV_FILE), join(worktree, ENV_FILE), { force: false });
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
    filter: async (from) => !tracked.has(relative(source, from)) && !(await lstat(from)).isSocket(),
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
 * await addWorktree(path, from, { branch });
 * await provision(from, path); // stderr only; the worktree exists either way
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
