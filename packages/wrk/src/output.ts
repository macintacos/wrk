/**
 * The output contract every agent-facing command shares.
 *
 * `wrk` is read by machines before it is read by people: ten-plus skill files across two
 * agent trees pipe its stdout through `jq` and branch on the fields they find. This module
 * is the whole of what those callers are promised — two channels, one envelope, four exit
 * rules — and it is deliberately the only place any of them is decided.
 *
 * **stdout is the machine channel; stderr is the human one.** Every *answer* a command
 * produces goes through {@link emit}, so a run's stdout is one JSON document, and every
 * progress line, warning and failure message goes to stderr through {@link note}.
 * Interleaving the two is the failure this split exists to prevent: a single "cloning…"
 * line on stdout turns a parseable answer into a `jq` syntax error, and it does so only on
 * the runs slow enough to have printed progress.
 *
 * Two things on stdout are **not** answers and are not this module's to route. Commander
 * renders `--help` there itself, which is correct — a caller asking for help is a human.
 * And an interactive component must be constructed against stderr (Ink's `render` takes a
 * `stdout` option) rather than allowed its default, or its escape sequences land in the
 * machine channel.
 *
 * There is one answer that is deliberately **not** JSON, and it is routed through here
 * rather than written behind this module's back: {@link emitLine}, the shape the editor's
 * `WorktreeCreate` hook and the pickers' `--print-path` both consume. Its consumer is not a
 * parser but a `cd`, so the envelope would be the wrong answer rather than a more rigorous
 * one. A command uses one or the other and never both — see {@link emitLine} for why that is
 * a rule rather than a style.
 *
 * **The envelope never omits a key**, and its keys keep a fixed order. An absent value is
 * `null`, never a missing key, so a caller reads any documented field unconditionally
 * rather than guarding each one. {@link envelope} holds both mechanisms.
 *
 * **Four exit rules, and the first is the surprising one.** A *verdict* — including one
 * that tells the caller to stop — exits `0`, because callers branch on the payload's
 * verdict field and never on the exit status, so a well-formed "blocked" answer is a
 * successful run. A **refusal** ({@link Refusal}) exits `1` with a prefixed one-line
 * message and no stack trace. A failed subprocess ({@link CommandFailed}) exits with
 * **that command's own status**, so `git`'s 128 reaches the caller as 128. A
 * **cancellation** ({@link Cancelled}) exits `130` and writes nothing of its own — no path
 * on stdout, and no message on stderr, a user who just pressed escape needing neither —
 * which is what lets a shell function tell a dismissed picker from a `wrk` that broke.
 * {@link reportFailure} is where those rules live, and anything it does not recognise is
 * rethrown rather than mapped: an unexpected error is a bug in `wrk`, and its stack is the
 * only useful thing about it.
 *
 * **Callers set `process.exitCode`; they do not call `process.exit`.** Writing to stdout
 * is asynchronous whenever stdout is a pipe — which is every agent-facing invocation —
 * and `process.exit` discards writes still in flight, truncating the machine channel at
 * whatever byte it had reached. Assigning `process.exitCode` and returning lets the event
 * loop drain first. This is the one hazard the Python implementation `wrk` replaces never
 * had to think about, its `print` being synchronous.
 *
 * The streams come from `node:process` rather than from `Bun.stdout`, for the reason
 * `proc.ts` gives for its own choice: the published artifact targets Node, so a Bun-only
 * API here would have to be unpicked at build time.
 *
 * **The types the rules are written over live in [`./errors`](./errors), which is
 * this module's only import.** An exit rule needs a type to be expressed over, but a layer
 * that merely *throws* one needs nothing from this module — so the plumbing depends on the
 * dependency-free vocabulary rather than on the streams. That leaves every arrow in the
 * package running away from presentation, and this module's own single import pointing at a
 * file that imports nothing at all.
 *
 * @packageDocumentation
 */

import { Cancelled, CommandFailed, Refusal } from "./errors";

/**
 * What every human-facing line `wrk` **composes itself** is prefixed with.
 *
 * The tool's name, so a message stays attributable once it is one line among many in an
 * agent's transcript or a shell's scrollback. Output forwarded verbatim from a child process
 * is not one of `wrk`'s lines and keeps whatever the tool that wrote it chose.
 *
 * Exported for the modules that write their own progress and warnings through {@link note}
 * rather than raising for {@link reportFailure} to render — provisioning a worktree is the
 * first. A second literal `"wrk: "` elsewhere in the package is exactly the shape that drifts,
 * which is the whole reason this is shared rather than restated.
 */
export const PREFIX = "wrk: ";

/**
 * Renders one payload as the envelope's JSON text, without the trailing newline.
 *
 * Two guarantees, and the replacer is the whole of the first. `JSON.stringify` **omits** a
 * key whose value is `undefined`, so without it an optional field would be absent on the
 * runs that did not reach it and present on the runs that did — leaving every caller to
 * distinguish "no such key" from "key is null" for a distinction this contract does not
 * make. Mapping `undefined` to `null` before that decision is taken is what makes "never
 * omits a key" a property of the serializer rather than of each caller's discipline.
 *
 * `??` is exact rather than convenient: `0`, `""` and `false` are values a payload
 * legitimately carries, and `||` would quietly turn each of them into `null`.
 *
 * The second guarantee is key order, and it is inherited rather than enforced —
 * `JSON.stringify` walks a payload's own string keys in insertion order. A result type
 * built as one object literal is therefore emitted in the order that literal declares. A
 * caller assembling a payload conditionally is the one shape that can vary, and the fix is
 * to build the literal whole rather than to add machinery here.
 *
 * @param payload - The object to render, carrying JSON-native values only. `object` rather
 *   than `Record<string, unknown>`, which reads tighter but rejects every `interface`-
 *   declared result type in this package — TypeScript withholds an implicit index
 *   signature from interfaces. So the type says "not a scalar" and no more, and two
 *   constraints go unenforced: the payload is one JSON *object* per run, never a bare
 *   array, and a `Map` or `Set` value renders as `{}` while a function- or symbol-valued
 *   key is still dropped, both silently.
 * @returns Indented JSON, ready for {@link emit}.
 *
 * @example
 * ```ts
 * envelope({ verdict: "proceed", reason: undefined });
 * // '{\n  "verdict": "proceed",\n  "reason": null\n}'
 * ```
 */
export function envelope(payload: object): string {
  return JSON.stringify(payload, (_key: string, value: unknown): unknown => value ?? null, 2);
}

/**
 * Writes one payload to stdout, and nothing else in `wrk` ever writes there.
 *
 * Called at most once per run: stdout is one JSON document, so a second call would append
 * a second object and leave the stream unparseable.
 *
 * @param payload - The run's result — see {@link envelope}.
 */
export function emit(payload: object): void {
  process.stdout.write(`${envelope(payload)}\n`);
}

/**
 * Writes one bare line to stdout, for the caller that reads a path rather than a document.
 *
 * The editor's `WorktreeCreate` hook is one such caller: Claude Code enters whatever
 * directory the hook's **last non-empty stdout line** names, so what it wants is a path and
 * nothing else — no braces, no quotes, no key. Handing it the envelope would not be a
 * stricter answer, it would be a directory that cannot be entered.
 *
 * The pickers' `--print-path` is the other, and it wants the same line for the same reason:
 * a Node process cannot move its parent shell, so the path goes to stdout and a shell
 * function does the `cd`. That caller adds a second obligation this function cannot carry on
 * its own — a run that produced no choice must leave stdout **empty** — which is why
 * cancelling throws {@link Cancelled} rather than reaching here with a sentinel.
 *
 * **A command uses this or {@link emit}, never both.** Both write to the one stdout, so a
 * run that called each would emit a document with a stray line glued to it — unparseable to
 * the `jq` caller and a nonexistent path to the hook, the single stream broken for both
 * consumers at once.
 *
 * @param line - The text, without a trailing newline.
 */
export function emitLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Writes one line to stderr, the channel a human reads.
 *
 * Progress, warnings and failures all come through here. The message is written as given,
 * with only the newline added, so a caller decorating its own progress lines keeps control
 * of how they look.
 *
 * @param message - The line, without a trailing newline.
 */
export function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Writes one diagnostic line to stderr, but only when `WRK_DEBUG` is set.
 *
 * For the paths that are correct when they work and *also* correct-looking when they do not
 * — a refresh that was supposed to happen in the background and silently did not. Nothing
 * downstream of one of those can tell, so the line is the only signal there is, and it has
 * to be available in the field rather than only under a debugger.
 *
 * An environment variable rather than a `--json`-style flag because the caller this exists
 * for is a shell prompt calling `wrk` as a library on every redraw, not a command someone
 * typed a flag onto. It routes through {@link note}, so a diagnostic can never reach the
 * machine channel, and carries {@link PREFIX} like every other line `wrk` composes.
 *
 * Any non-empty value enables it. `WRK_DEBUG=0` therefore *enables* it too, which is the
 * shell's own convention for "exported means set" and matches how `cache.ts` reads
 * `XDG_CACHE_HOME`; a variable someone exported to `0` to turn this off would be a surprise
 * worth having, not a bug worth branching on.
 *
 * @param message - The line, without a trailing newline or a prefix.
 */
export function debug(message: string): void {
  if (process.env.WRK_DEBUG) note(`${PREFIX}${message}`);
}

/**
 * Writes a thrown value's human message to stderr and answers the status to exit with.
 *
 * The four exit rules in one function — see this module's header. It is deliberately
 * **not** total: a value that is none of {@link Cancelled}, {@link Refusal} and
 * {@link CommandFailed} is rethrown untouched, and before anything is written, so the
 * runtime prints its stack and exits `1` on its own. Mapping an unexpected error to a tidy
 * one-line message would hide the one thing that makes a bug diagnosable.
 *
 * A {@link Cancelled} is the one arrival that writes nothing, so on that path the function's
 * name is a slight misnomer: it reports no failure, it only answers the status.
 *
 * The caller assigns the result to `process.exitCode` rather than passing it to
 * `process.exit`, for the flushing reason this module's header gives.
 *
 * @param error - Whatever was thrown.
 * @returns The exit status this outcome calls for.
 * @throws The value it was given, when that value is none of the three this module maps.
 *
 * @example
 * ```ts
 * try {
 *   await program.parseAsync(argv, { from: "user" });
 * } catch (error) {
 *   process.exitCode = reportFailure(error);
 * }
 * ```
 */
export function reportFailure(error: unknown): number {
  // First, and silent, because it is the one arrival here that is not a failure — see
  // {@link Cancelled}. Nothing is written, so neither channel can carry a path the shell
  // function would then try to enter.
  if (error instanceof Cancelled) return 130;

  if (error instanceof Refusal) {
    note(`${PREFIX}${error.message}`);
    return 1;
  }

  if (error instanceof CommandFailed) {
    note(`${PREFIX}${error.message}`);
    // A command that "failed" with status 0 would otherwise report the run as successful,
    // which is the single outcome this module exists to prevent.
    return error.code === 0 ? 1 : error.code;
  }

  throw error;
}
