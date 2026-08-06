# wrk

A TypeScript CLI that consolidates the git-worktree, PR-stack and agent-workflow tooling
that currently lives as fish functions and a standalone Python script.

The repository is a [Bun](https://bun.sh) workspace holding two packages:

| Package                  | Path              | What it is                           |
| ------------------------ | ----------------- | ------------------------------------ |
| `@macintacos/wrk`        | `packages/wrk`    | The CLI.                             |
| `@macintacos/wrk-picker` | `packages/picker` | The reusable inline terminal picker. |

The bare npm name `wrk` is taken, so both packages publish under the `@macintacos` scope.

## Requirements

- [mise](https://mise.jdx.dev). It installs and pins every other tool the repository
  needs, Bun included, so nothing else has to be on your machine first.
- **git 2.36 or newer.** This is the one exception: `wrk` shells out to the system `git`
  rather than pinning its own. Run `git --version` before anything else — an old enough
  git fails silently rather than loudly, and
  [doc/ADVANCED.md](doc/ADVANCED.md#the-git-version-floor) explains how.

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

That prints the usage block: the global `--json` flag, the `wt` picker, and the two
command groups, `repo` and `agent`. `--help` works at every level, so
`bun packages/wrk/src/cli.ts agent create --help` is the quickest way to see one command's
flags.

## The commands

| Command                      | What it does                                                   |
| ---------------------------- | -------------------------------------------------------------- |
| `wrk wt`                     | Picks one of this repository's worktrees and says where to go.  |
| `wrk repo convert`           | Prints, and never runs, the bare-repo conversion recipe.        |
| `wrk agent repo-setup <url>` | Clones a repository into the bare-repo layout, in the cwd.      |
| `wrk agent preflight`        | Says whether an agent may cut a worktree here, and why not.     |
| `wrk agent create`           | Creates a branch and its worktree together.                     |

`wrk` is driven by an agent as much as by a person, so the `agent` commands print JSON
whatever you ask for. `--json` puts a command that would otherwise print for a human onto
the same shape, and may go anywhere in the argument list.

`wrk wt` is the one you type by hand. It lists every worktree in the repository except the
one you are standing in, annotated with where each branch sits in the PR stack, and
filters as you type. No child process can move the shell that launched it, so it prints
where to go and a small shell function does the `cd` —
[doc/ADVANCED.md](doc/ADVANCED.md#the-cd-protocol) has both shims and the rest of it.

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

## Going further

[doc/ADVANCED.md](doc/ADVANCED.md) carries the rest: the git version floor in detail, the
repository's own dev workflow, the output contract callers parse and its exit rules, the
`cd` protocol a picker moves your shell with, and each `agent` command in full.
