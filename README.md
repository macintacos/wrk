# wrk

A TypeScript CLI that consolidates the git-worktree, PR-stack and agent-workflow tooling
that currently lives as fish functions and a standalone Python script.

The repository is a [Bun](https://bun.sh) workspace holding two published packages:

| Package                  | Path              | What it is                           |
| ------------------------ | ----------------- | ------------------------------------ |
| `@macintacos/wrk`        | `packages/wrk`    | The CLI. Will install a `wrk` binary. |
| `@macintacos/wrk-picker` | `packages/picker` | The reusable inline terminal picker.  |

The bare npm name `wrk` is taken, so both packages publish under the `@macintacos` scope.

## Getting started

Tool versions are pinned by [mise](https://mise.jdx.dev) and checksum-locked in
`mise.lock`; git hooks are managed by [hk](https://hk.jdx.dev).

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

```bash
mise trust      # approve this repo's mise.toml
mise run setup  # install pinned tools, then workspace dependencies
```

`mise install` runs `hk install --mise` as a postinstall hook, so the pre-commit and
pre-push hooks are registered as a side effect of a normal setup.

Running any task on a fresh clone bootstraps it first, so `mise run setup` is only needed
to reconcile a checkout after a lockfile change.

## Tasks

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

## Agent commands

`wrk agent preflight` is what an agent runs before it creates a worktree. It answers
whether to proceed, and says stop — without touching anything — when it cannot.

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
| `blocked` / `dirty-checkout`     | Tracked changes would block the switch or the pull. Nothing was modified.             |

The envelope carries nine keys on every run — `verdict`, `reason`, `repo_root`,
`default_branch`, `base`, `current_branch`, `worktree_root`, `current_worktree`,
`conversion_reference` — so any of them can be read unconditionally. `worktree_root` is
the **container**, not a worktree; the name is misleading and frozen.
**A blocked verdict leaves the repository byte-identical**: every check runs before the
first mutation.

## Configuration

`wrk` runs with no configuration at all. Two optional files override its defaults, the
later winning over the earlier:

1. **Machine-wide** — `$XDG_CONFIG_HOME/wrk/config.toml`, or `~/.config/wrk/config.toml`
   when that variable is unset, empty, or relative. Its sections sit at the root of the
   document, since the path already says the file is `wrk`'s.
2. **Per repository** — the `wrk` key of `.project-meta.json` in the repository's
   **container** (beside `.bare`), not in a checkout. That file is shared with other
   tools, so everything `wrk` reads there hangs off `wrk` — `wrk.search`, never a
   neighbouring top-level `search`.

The formats differ on purpose. The machine-wide file is `wrk`'s alone, so it is TOML;
`.project-meta.json` belongs to every tool that reads it, so it stays JSON under the name
those tools already know.

| Setting        | Default                        | What it does                                          |
| -------------- | ------------------------------ | ----------------------------------------------------- |
| `search.roots` | `["~/GitLocal"]`               | Directories scanned for repository containers.        |
| `search.depth` | `2`                            | How far below each root a container sits.             |
| `cache.ttls`   | `{"pr-graph": 900000}`         | Milliseconds before a cache entry goes stale.         |
| `glyphs`       | `U+F062` / `U+F063` / `U+F00C` | Marker per stack position: `top`, `bottom`, `merged`. |
| `colours`      | `green` / `yellow` / `brblack` | Colour per stack position.                            |

```toml
# ~/.config/wrk/config.toml
[search]
roots = ["~/GitLocal", "/srv/repos"]
depth = 2

[cache.ttls]
pr-graph = 300000

[colours]
merged = "brblue"
```

```jsonc
// <container>/.project-meta.json
{
  "wrk": {
    "search": { "depth": 1 }
  }
}
```

`search.roots` is replaced wholesale by the highest layer that sets it — it is one
decision, and appending to the defaults would make `~/GitLocal` impossible to remove.
`cache.ttls`, `glyphs` and `colours` merge key by key, so overriding one entry leaves the
others alone. A leading `~` in a root is expanded; a root that is still relative
afterwards is dropped, because it would otherwise be scanned from wherever you happened to
be standing.

**Nothing reports a bad config.** A file that is missing, unreadable, unparseable, or
carries none of these keys leaves the layer below it standing, and a single malformed
value falls through on its own while its well-formed neighbours still apply. So a typo
costs you the setting silently — if an override seems to do nothing, check the spelling
and the nesting first. A whole layer is lost only when the document itself will not parse:
in TOML that is an unterminated `[table]` header, a key defined twice, or an integer too
large to represent exactly; in JSON, anything that is not an object at the root.
