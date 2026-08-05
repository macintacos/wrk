#!/usr/bin/env bash
# Fresh-clone guard for the .mise/tasks/ forwarders.
#
# Contract: SOURCED, never executed — `source scripts/bootstrap.sh || exit 1`.
# Sourcing is load-bearing twice over. It lets a failure propagate to the caller
# through a return status, and it lets the PATH repair below survive into the
# `exec bun ...` that follows; a subshell would discard both.
#
# The caller's `set -e` does NOT apply inside this file: sourcing it as the left
# operand of `||` disables errexit for everything it runs. Every fallible command
# here must therefore carry its own `|| return` — without one, a failed install
# is skipped silently and the guard reports success.
#
# Dependency-free by construction: this runs before `bun install` has, so it
# cannot import anything the task itself would import. A task that skipped this
# on a clean checkout would not fail with a useful message, it would fail during
# module resolution.
#
# Returns 0 when the checkout is ready, nonzero when it could not be made ready.

wrk_bootstrap() {
	# Located from this file rather than from cwd or MISE_PROJECT_ROOT, so the
	# `cd`s below are correct however the caller was invoked.
	local root
	root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)" || return 1

	# Warm path: dependencies present and a runtime to run them with. Two builtins,
	# no subprocess, so the common case costs nothing.
	if [[ -d ${root}/node_modules ]] && command -v bun >/dev/null 2>&1; then
		return 0
	fi

	if ! command -v mise >/dev/null 2>&1; then
		echo "wrk: mise is not installed — see https://mise.jdx.dev/getting-started.html" >&2
		return 1
	fi

	# Install chatter goes to stderr so it cannot corrupt a task whose stdout is
	# being piped somewhere that expects only the tool's own output.
	echo "wrk: preparing a fresh checkout (mise install, bun install)…" >&2

	# Subshell so the caller's cwd is never moved.
	(cd -- "${root}" && mise install) >&2 || return 1

	# mise fixed this task's PATH when it launched, so bun is still absent from it
	# even now that mise has put it on disk. Re-derive PATH before using bun, and
	# again for the caller's `exec bun` — which only works because we are sourced.
	local bin_paths
	bin_paths="$(cd -- "${root}" && mise bin-paths)" || return 1
	if [[ -n ${bin_paths} ]]; then
		export PATH="${bin_paths//$'\n'/:}:${PATH}"
	fi

	(cd -- "${root}" && bun install) >&2 || return 1
}

wrk_bootstrap
