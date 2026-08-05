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
