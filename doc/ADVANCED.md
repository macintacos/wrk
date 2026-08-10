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
asking for help is a human, so it renders on stdout and no envelope is involved. The two
commands that take that back are `wrk wt` and `wrk pr`, whose stdout is a path being fed
to `cd`; see [The cd protocol](#the-cd-protocol).

A global `--json` flag puts a command that would otherwise print for a human onto the same
envelope. The agent-facing commands are JSON either way, because their callers parse them
either way.

The envelope **never omits a key**. A value the run did not reach is `null`, not a missing
key, so `.reason` can be read unconditionally rather than guarded. Keys come out in the
order the result type declares them, so two runs of the same command diff cleanly.

Four exit rules, and the first is the one to know:

| Outcome                                   | Exit        | Shape                                      |
| ----------------------------------------- | ----------- | ------------------------------------------ |
| A verdict — **including one saying stop** | `0`         | The envelope, on stdout.                   |
| A refusal                                 | `1`         | One `wrk: …` line on stderr. Nothing else. |
| A command `wrk` ran failed                | the child's | Its argv, status and stderr, on stderr.    |
| A picker the user dismissed               | `130`       | Nothing on stdout, and no `wrk: …` line.   |

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

### The cd protocol

A picker cannot move the shell that launched it: `cd` changes a process's own working
directory, and `wrk` is a child. So the pickers take the route `fzf` took before them —
**`--print-path` writes the chosen path to stdout, alone, and a small shell function does
the `cd`**. The interface itself renders to stderr, so `wrk wt --print-path` is still a
usable picker with its stdout redirected, and the picker is testable without a shell at
all.

Cancelling is neither an answer nor a failure, so it gets neither shape: a dismissed
picker leaves stdout **empty**, adds no `wrk: …` line to stderr — it clears its own render
on the way out, so there is nothing left to explain — and exits `130`. That is
`128 + SIGINT`, the shell's own convention for "the user aborted" and what `fzf` exits
with on `ESC`, so a keybinding already written against `fzf` tells a dismissal from a
broken `wrk` without being re-taught. What a caller separates is therefore `0` with a path
on stdout, `130` with nothing, and anything else — which writes something for a human on
stderr, though not always a `wrk: …` line, since commander answers a malformed argv itself
and an unexpected error arrives as a stack.

The shell function is the whole of the caller's side. In fish:

```fish
function wt --description "Pick a worktree and cd into it"
    set -l target (wrk wt --print-path $argv)
    or return $status
    test -n "$target"; or return 1
    cd -- $target
end
```

In bash or zsh:

```bash
wt() {
  local target
  target=$(wrk wt --print-path "$@") || return $?
  [ -n "$target" ] || return 1
  cd -- "$target"
}
```

Both guards earn their line. **Forwarding the status** is what keeps a cancelled pick
distinguishable at the call site: fish propagates a command substitution's status through
`set`, so `or return $status` really does carry the `130` out, and bash's declaration is
split from its assignment on purpose, because `local target=$(…)` reports `local`'s own
status — always `0` — and would silently discard the very distinction this protocol exists
to draw. **Checking for emptiness** then catches the one case a status cannot: a run that
exited `0` having printed nothing. Without it fish expands `cd -- $target` to a bare `cd`
and sends you to your home directory.

**A picker's own `--help` renders on stderr**, which is the one place `wrk` departs from
the rule above it. Commander writes help to stdout, and for every other command that is
right — but a picker's stdout is a path being fed to `cd`, so a usage block there is a
directory name. `wrk wt` and `wrk pr` are carved out and nothing else is: `wrk --help` and
every `agent` command keep stdout. What a shim sees is therefore an empty stdout, which
its emptiness guard turns into a `1` while the help itself lands on the terminal.

`wrk pr` takes the same shim with `pr` in place of `wt` — the protocol belongs to the
command, not to `wt`. The shims and the keybindings that call them live in the dotfiles
repo rather than here.

## The worktree picker

`wrk wt` lists the repository's worktrees and answers where to go.

```bash
wrk wt [--print-path]
```

Every worktree the repository has, **less the one you are standing in** — moving there is
not a move — and less any whose directory is gone, which git still lists until it is
pruned and which would be a `cd` that could not succeed. The bare repository is never a
row: it has no work tree to stand in. A detached worktree is a row like any other, shown
as `(detached 1a2b3c4)`.

Each row is its branch, then its pull request when it has one: the stack marker,
`#number`, the position in the stack, and the title. Type to filter. The query is one
fuzzy pattern matched across the whole row, so it can span columns — but only in the order
they are drawn: `1016 preview` matches a branch named for the issue with `preview` in its
title, while `preview 1016` does not.

| Configured at   | Marks                                                   |
| --------------- | ------------------------------------------------------- |
| `glyphs.top`    | Nothing is stacked on this branch.                      |
| `glyphs.bottom` | The bottom layer that has not merged yet.               |
| `glyphs.merged` | The pull request has landed; the worktree is still here. |

The glyphs and their colours are configurable — see
[Configuration](../README.md#configuration).
**A one-layer stack gets neither a position nor a marker**, because there is no "where am
I" to answer and marking it both the top and the bottom would say nothing.

**With one candidate the picker never appears.** The destination is already decided, so
`wrk wt` goes straight there and says why on stderr rather than asking you to confirm a
list of one. With none it refuses: exit `1`, nothing on stdout.

**With `gh` absent, logged out, offline or rate-limited, rows render un-annotated** — the
branch name alone, exactly as if there were no pull requests to look for — and nothing is
said about it on stderr.

**The picker never waits on `gh`.** Your worktrees are something git already knows, so the
list is drawn from them alone and the annotation arrives underneath it: the marker,
`#number`, the position and the title appear in place, and the cursor stays on the row you
were reading. Once the shared `pr-graph` cache has been filled that is a frame later, and
the refresh that keeps it current runs in the background for the next invocation. The
first run in a repository is a `gh` round trip later instead — the list is on screen for
all of it, and a row chosen before that round trip finishes waits for it on the way out.

`--print-path` selects the bare-path stdout shape the `cd` protocol above consumes.
Without it the answer is the usual envelope, `{worktree_path, branch}`, with `branch` null
on a detached HEAD.

## The pull-request picker

`wrk pr` lists the repository's open pull requests and answers where to go for the one you
pick — creating a worktree and checking the pull request out into it if there is not one
already.

```bash
wrk pr [--print-path]
```

**Open pull requests only, most-recently-updated first.** A merged one is neither
somewhere to go nor something to review, so it is not a row — which is the one place this
list and `wrk wt`'s annotation disagree about the pull-request cache they share. Ties on
the timestamp are broken by the higher number, so the same repository always draws in the
same order.

Each row is `#number`, the title, then the head branch. Type to filter, exactly as in
`wrk wt`. Beside the list is a preview pane holding `gh`'s own rendering of the selected
pull request — markdown as ANSI, links intact, wrapped to the pane's width — scrolled
independently with `PageUp` and `PageDown`.

Choosing a row resolves to one of three destinations:

| The head branch                       | What happens                                                          |
| ------------------------------------- | ---------------------------------------------------------------------- |
| already has a worktree                | That is the answer. Nothing is created and `gh` is never run.           |
| has a worktree record but no directory | You are asked to confirm a prune, then it is created as below.          |
| has neither                           | A worktree is created detached and the pull request checked out into it. |

**The prune is repo-wide, and the prompt says so.** `git worktree prune` discards the
administrative record of *every* worktree whose directory is gone, not just the one in the
way — so the confirmation asks about all of them, and the record that provoked the
question is named on the line above it. Declining is a dismissal like any other: exit
`130`, nothing on stdout, nothing pruned.

**Checkout goes through `gh`, not `git`.** `gh pr checkout` resolves a fork's remote and
sets the branch's upstream from a pull-request number, neither of which plain git can do —
so the worktree is created **detached** first and `gh` decides its branch a moment later.
Detached rather than on a DWIM'd branch named after the directory, which `gh` would then
leave behind as a ref nobody asked for.

**If the checkout fails, the worktree is force-removed** and `gh`'s own exit status
becomes `wrk`'s. Nothing reaches stdout, so the shim's guards leave you exactly where you
were.

**A created worktree is provisioned before the path is printed**, exactly as
`wrk agent create`'s is: the codegraph index and the untracked `.env` are copied across
and the mise toolchain is installed. That is a pause of seconds to minutes on the first
checkout of a large repository, with those tools' own output on stderr. Every step is
best-effort, so none of it can fail the checkout that preceded it.

**With no open pull requests it refuses**: exit `1`, nothing on stdout. Unlike `wrk wt`, a
single candidate does **not** skip the picker — choosing it may create a worktree and run
a checkout, so `Enter` on a list of one is the confirmation that deserves.

The rows are read through the shared `pr-graph` cache, so once it has been filled the
refresh runs behind the draw rather than in front of it. The very first run in a
repository is the exception: with nothing stored there is nothing to draw, so it waits for
`gh` once.

`--print-path` selects the bare-path stdout shape the `cd` protocol above consumes.
Without it the answer is the usual envelope, `{worktree_path, number}`.

## Picker latency

**Both pickers are interactive within two seconds of process start, on a warm cache,
however slow `gh` is.** That is the budget, and
[`packages/wrk/test/latency.test.ts`](../packages/wrk/test/latency.test.ts) enforces it:
each command is driven in a real terminal against a `gh` stubbed to take four seconds, and
the clock starts before the shell does — so the runtime's own cold start, the module
graph, `git`, the configuration read and the cache read are all inside the number, not
excluded from it.

Two seconds is the ceiling the suite fails at, not the cost. Measured on Apple silicon,
medians of five runs:

| | idle | under eight spinning CPU burners |
| --- | --- | --- |
| `wrk wt` | 256 ms | 312 ms |
| `wrk pr` | 279 ms | 322 ms |

No single loaded run exceeded 384 ms.

The gap between the two is deliberate. A budget pinned just above the observed figure
fails on a loaded machine for a reason that is not a regression, and a suite that fails
for no reason teaches everyone to re-run it. Half the stub's delay is the honest ceiling:
no machine is slow enough to cross it, and no implementation that waited for `gh` is fast
enough to stay under it.

**Two things sit outside the budget, both by construction.**

The **first run in a repository** has nothing cached, and for `wrk pr` the pull requests
*are* the rows — so it waits for `gh` once, measured at 4426 ms against the four-second
stub. `wrk wt` does not: its rows come from git, so a cold cache costs it nothing at the
draw (293 ms) and only delays the annotation.

**Dismissing does not stop an in-flight `gh`.** Nothing kills the fetch, so a run that is
still waiting on one stays alive until it answers — measured at the full four seconds
against the stub, versus 90 ms when there is nothing outstanding. It reaches `wrk wt` only
on a cold cache, and `wrk pr` on the first view of any pull request at a given pane width,
because the preview pane fetches on the first frame. The wait moved from in front of the
draw to after the choice; the total is the same, and it is the trade both pickers are
built on.

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
