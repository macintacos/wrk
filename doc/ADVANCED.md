# Advanced

The reference half of `wrk`'s documentation. [README.md](../README.md) is the front door —
start there if you have not run the CLI yet.

Commands below are written as `wrk …`, which is the shape they will take once the binary
is wired up. Until then, substitute `bun packages/wrk/src/cli.ts …` from the repository
root.

## The git version floor

`wrk` shells out to the system `git` rather than pinning its own, and requires
**git 2.36 or newer**: `worktree list --porcelain -z` arrived in 2.36 and
`rev-parse --path-format` in 2.31.

The floor is not merely advisory. `worktree list` rejects an unknown option loudly, but
`rev-parse` hand-rolls its option parsing and
**echoes an unrecognised flag to stdout, exiting 0** — so below 2.31,
`rev-parse --path-format=absolute --git-common-dir` returns the flag itself followed by a
relative path, and the repository resolves to a container named `--path-format=absolute`.
That answer is silent, stable, and wrong. Check `git --version` before reaching for a
debugger.

## Tasks

Tool versions are pinned by [mise](https://mise.jdx.dev) and checksum-locked in
`mise.lock`; git hooks are managed by [hk](https://hk.jdx.dev). `mise install` runs
`hk install --mise` as a postinstall hook, so the pre-commit and pre-push hooks are
registered as a side effect of a normal setup.

Every entry point is a `mise run <task>`. Each is a thin `.mise/tasks/` forwarder into one
commander tree in `scripts/tasks/cli.ts`, so `mise run <task> --help` documents the task
and any further arguments reach the underlying tool.

| Task      | What it runs                          | What it does                                   |
| --------- | ------------------------------------- | ---------------------------------------------- |
| format    | `hk fix --all --no-stage`             | Rewrites files into canonical form.            |
| lint      | `hk check --all`                      | Read-only: formatter diffs, lint rules, types. |
| typecheck | `bun x tsc --noEmit -p tsconfig.json` | Types across the workspace.                    |
| test      | `bun test`                            | The test suite.                                |
| setup     | `mise install`, `bun install`         | Toolchain, then dependencies.                  |

`typecheck` and `test` reach their tool directly so a path or filter can be forwarded —
`mise run test test/tasks.test.ts` and `mise run test -t "some name"` both work.

The same checks exist as hk lanes, which is what the git hooks run: `pre-commit` runs the
format and lint lanes in fix mode, `pre-push` runs the test lane. Invoke a lane directly
as `hk run <lane>`, never `hk <lane>` — `hk test` is hk's own fixture runner and
`hk typecheck` is not a subcommand.

Biome owns JS/TS formatting and linting, `tsc` owns types, rumdl owns Markdown, and taplo
owns TOML.

## Output contract

`wrk` is read by machines before it is read by people, so its two streams have separate
jobs. **stdout is the machine channel**: every answer a command produces goes there, as
one JSON object per run. **stderr is the human channel**: progress, warnings and failure
messages, whatever the run's outcome. `--help` is the exception that proves it — a caller
asking for help is a human, so it renders on stdout and no envelope is involved.

A global `--json` flag puts a command that would otherwise print for a human onto the same
envelope. The agent-facing commands are JSON either way, because their callers parse them
either way.

The envelope **never omits a key**. A value the run did not reach is `null`, not a missing
key, so `.reason` can be read unconditionally rather than guarded. Keys come out in the
order the result type declares them, so two runs of the same command diff cleanly.

Three exit rules, and the first is the one to know:

| Outcome                                   | Exit        | Shape                                      |
| ----------------------------------------- | ----------- | ------------------------------------------ |
| A verdict — **including one saying stop** | `0`         | The envelope, on stdout.                   |
| A refusal                                 | `1`         | One `wrk: …` line on stderr. Nothing else. |
| A command `wrk` ran failed                | the child's | Its argv, status and stderr, on stderr.    |

A well-formed "blocked" answer is a **successful run**: callers branch on the payload's
verdict field, never on the exit status. An exit status that is not `0` means `wrk` has no
answer to give, not that the answer was no.

One command has a second machine shape. `wrk agent create --hook` prints the worktree path
alone, because the editor's `WorktreeCreate` hook enters whatever directory the
**last non-empty stdout line** names — a JSON document there is a path that cannot be
entered, not a stricter answer. Both shapes obey the same failure rule, and it is the one
the whole contract rests on: a run that fails writes **nothing** to stdout and exits
nonzero. Callers pipe through `jq -er`, which exits `0` on empty input, so a run that
failed while still exiting `0` would be read as a success carrying no path, and one that
printed a partial answer before failing would be read as a success outright.

## Agent commands

`wrk agent repo-setup` is what runs when the repository is not on disk at all. It clones
straight into the bare-repo layout — `.bare`, the `.git` pointer, and the default-branch
checkout — and emits `{container, checkout_path, default_branch}`.

```bash
mkdir ~/GitLocal/project && cd ~/GitLocal/project
wrk agent repo-setup git@github.com:owner/project.git
```

**The cwd is the container**; there is no destination argument, so the caller places the
repository by choosing where to run. Two refusals, in this order: already inside a
repository — convert it instead — and then a cwd that is not empty. An existing checkout
trips both, and the first is the one whose advice applies.

**If a step fails after the clone has started, the cwd is emptied before the error is
reported** — a refusal never gets that far, which is exactly why both checks run first.
That is not tidiness: `.bare` plus the `.git` pointer *is* a repository, so wreckage left
behind would trip the inside-a-repository refusal on the next attempt and send you off to
convert a container with no checkout in it.

The checkout directory folds `/` to `+` exactly as a run worktree's does, so a default
branch named `release/2.0` lands in `release+2.0` while the branch keeps its slashes.

`wrk agent preflight` is what an agent runs before it creates a worktree. It answers
whether to proceed, and says stop — without touching the repository — when it cannot.

```bash
wrk agent preflight --issue EXC-997 [--base EXC-996/parent-slug]
```

`--base` is the stacked path: it skips the default-branch sync in its entirety — no fetch,
no switch, no pull, no dirty check — while still running the layout and isolation checks.

| verdict / reason                 | What it means                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `proceed`                        | Create the worktree; `worktree_root` is the container to place it in.                 |
| `resumed`                        | Already in this issue's worktree. Create nothing.                                     |
| `blocked` / `container-cwd`      | Run from the container. `cd` into the default-branch checkout and re-run.             |
| `blocked` / `unconverted-repo`   | Not a bare-repo container. `conversion_reference` names the skill that converts it.   |
| `blocked` / `unrelated-worktree` | Inside a worktree for different work. Return to the default-branch checkout.          |
| `blocked` / `dirty-checkout`     | Tracked changes would block the switch or the pull. The repository was not modified.  |

The envelope carries nine keys on every run — `verdict`, `reason`, `repo_root`,
`default_branch`, `base`, `current_branch`, `worktree_root`, `current_worktree`,
`conversion_reference` — so any of them can be read unconditionally. `worktree_root` is
the **container**, not a worktree; the name is misleading and frozen.
**A blocked verdict leaves the repository byte-identical**: every check runs before the
first mutation of the repository.

**Concurrent runs are safe, and need no lock from the caller.** The checkout preflight
syncs is shared, and every checkout in a container has one git directory between them, so
two runs overlapping would otherwise collide on `FETCH_HEAD` — which is `git pull`'s
`fatal: Cannot fast-forward to multiple branches` — on the remote-tracking ref locks, and
on `index.lock`. Worse than any of those, `git status` reads an index another run is
part-way through replacing, so a clean checkout is reported dirty and the answer is wrong
rather than absent. The sync and that dirty check are therefore one critical section,
serialised inside `wrk` by a lock directory in the container. That covers `preflight`; a
caller that needs `preflight` and `create` to be **atomic together** — so that no other
run can move the default branch between the base it was told and the worktree it then
creates — still coordinates that itself.

`wrk agent create` is what runs next, once preflight says proceed. It creates the branch
and its worktree together, as a sibling of the default-branch checkout inside the
container, and emits `{worktree_path, branch}`.

```bash
wrk agent create --branch EXC-999/some-slug [--base EXC-996/parent-slug] [--hook]
```

Only the **directory** folds `/` to `+` — the branch reaches `git worktree add -b`
verbatim, so `EXC-999/some-slug` lives in `EXC-999+some-slug`. `--base` is the stacked
path again, and defaults to the repository's default branch. `--hook` selects the
bare-path stdout shape described above.

Unlike preflight, `create` has no blocked verdict to return: its contract is that the
worktree now exists, so an unconverted repository is a **refusal** — exit `1`, nothing on
stdout — rather than an answer.
