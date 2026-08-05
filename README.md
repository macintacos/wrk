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

```bash
mise trust      # approve this repo's mise.toml
mise install    # install pinned tools; registers git hooks via `hk install --mise`
bun install     # install workspace dependencies
```

`mise install` runs `hk install --mise` as a postinstall hook, so the pre-commit and
pre-push hooks are registered as a side effect of a normal setup.

## Toolchain

Four lanes, all defined in `hk.pkl`:

| Lane      | Command                   | What it does                                   |
| --------- | ------------------------- | ---------------------------------------------- |
| format    | `hk fix --all --no-stage` | Rewrites files into canonical form.            |
| lint      | `hk check --all`          | Read-only: formatter diffs, lint rules, types. |
| typecheck | `hk run typecheck --all`  | `tsc --noEmit` across the workspace.           |
| test      | `hk run test --all`       | `bun test`.                                    |

Run the last two as `hk run <lane>`, never `hk <lane>` — `hk test` is hk's own fixture
runner and `hk typecheck` is not a subcommand. Shorter `mise run` aliases arrive with the
task runner in EXC-989.

`pre-commit` runs the format and lint lanes in fix mode; `pre-push` runs the test lane.

Biome owns JS/TS formatting and linting, `tsc` owns types, rumdl owns Markdown, and taplo
owns TOML.
