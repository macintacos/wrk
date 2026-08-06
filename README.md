# wrk

A TypeScript CLI that consolidates the git-worktree, PR-stack and agent-workflow tooling
that currently lives as fish functions and a standalone Python script.

The repository is a [Bun](https://bun.sh) workspace holding two published packages:

| Package                  | Path              | What it is                           |
| ------------------------ | ----------------- | ------------------------------------ |
| `@macintacos/wrk`        | `packages/wrk`    | The CLI.                             |
| `@macintacos/wrk-picker` | `packages/picker` | The reusable inline terminal picker. |

The bare npm name `wrk` is taken, so both packages publish under the `@macintacos` scope.

## Requirements

- [mise](https://mise.jdx.dev). It installs and pins every other tool the repository
  needs, Bun included, so nothing else has to be on your machine first.
- **git 2.36 or newer.** This is the one exception: `wrk` shells out to the system `git`
  rather than pinning its own. Run `git --version` before anything else — an older git
  does not fail cleanly, and [doc/ADVANCED.md](doc/ADVANCED.md#the-git-version-floor)
  explains why.

## Setup

From the repository root:

```bash
mise trust      # approve this repo's mise.toml
mise run setup  # install pinned tools, then workspace dependencies
```

Running any task on a fresh clone bootstraps it first, so `mise run setup` is only needed
to reconcile a checkout after a lockfile change.

## Try it

There is no `wrk` command to install yet — `packages/wrk/package.json` declares no `bin`,
so nothing puts a binary on your `PATH`. Run the CLI from source instead, from the
repository root:

```bash
bun packages/wrk/src/cli.ts --help
```

That prints the usage block: the global `--json` flag, and the two command groups the next
section covers, `repo` and `agent`. `--help` works at every level, so
`bun packages/wrk/src/cli.ts agent create --help` is the quickest way to see one command's
flags.

## The commands

| Command                      | What it does                                                  |
| ---------------------------- | ------------------------------------------------------------- |
| `wrk repo convert`           | Prints — and does not run — the recipe for converting this repository to the bare-repo layout. |
| `wrk agent repo-setup <url>` | Clones a repository into the bare-repo layout, in the cwd.     |
| `wrk agent preflight`        | Says whether an agent may cut a worktree here, and why not.    |
| `wrk agent create`           | Creates a branch and its worktree together.                    |

`wrk` exists to be driven by an agent as much as by a person, so every command can emit
JSON instead of prose: pass `--json` anywhere in the argument list. The `agent` commands
emit JSON regardless, because their callers parse them either way.

## Going further

[doc/ADVANCED.md](doc/ADVANCED.md) carries the rest: the output contract callers parse and
its exit rules, each `agent` command in full with its verdicts and envelope, the
configuration layers, the git version floor in detail, and the repository's own dev
workflow.
