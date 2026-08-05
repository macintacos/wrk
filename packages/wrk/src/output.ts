/**
 * The output contract every agent-facing command shares.
 *
 * `wrk` is read by machines before it is read by people: ten-plus skill files across two
 * agent trees pipe its stdout through `jq` and branch on the fields they find. This module
 * is the whole of what those callers are promised — two channels, one envelope, three exit
 * rules — and it is deliberately the only place any of the three is decided.
 *
 * **stdout is the machine channel; stderr is the human one.** {@link emit} is the only
 * thing that writes to stdout, so a run's stdout is one JSON document and nothing else,
 * and every progress line, warning and failure message goes to stderr through
 * {@link note}. Interleaving the two is the failure this split exists to prevent: a single
 * "cloning…" line on stdout turns a parseable answer into a `jq` syntax error, and it does
 * so only on the runs slow enough to have printed progress.
 *
 * **The envelope never omits a key.** An absent value is `null`, never a missing key, so a
 * caller reads any documented field unconditionally rather than guarding each one — see
 * {@link envelope}. Key order is the payload's own declaration order, which
 * `JSON.stringify` preserves; a result type declared once as a literal is therefore
 * serialized identically on every run, which is what makes a captured run diffable.
 *
 * **Three exit rules, and the first is the surprising one.** A *verdict* — including one
 * that tells the caller to stop — exits `0`, because callers branch on the payload's
 * verdict field and never on the exit status, so a well-formed "blocked" answer is a
 * successful run. A **refusal** ({@link Refusal}) exits `1` with a prefixed one-line
 * message and no stack trace. A failed subprocess ({@link CommandFailed}) exits with
 * **that command's own status**, so `git`'s 128 reaches the caller as 128.
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
 * @packageDocumentation
 */

/**
 * What every human-facing failure line is prefixed with.
 *
 * The tool's name, so a message stays attributable once it is one line among many in an
 * agent's transcript or a shell's scrollback.
 */
const PREFIX = "wrk: ";

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
 * @param payload - The object to render. An object, never a bare array or scalar: the
 *   contract is one JSON *object* per run.
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
 * A refusal: `wrk` will not do what was asked, and nothing was changed.
 *
 * Distinct from a verdict, which is an *answer* a caller acts on and therefore exits `0`.
 * A refusal has no answer to give — the cwd is not somewhere a container can be built, the
 * repository is not one this tool can place a worktree in — so there is no partial success
 * to report and the run exits `1`. The message is the whole of what the user sees, so it
 * says what is wrong and what to do about it, in one sentence.
 */
export class Refusal extends Error {}

/**
 * A subprocess `wrk` ran failed, carrying its exit status so the caller can inherit it.
 *
 * Thrown only where the child's failure has no honest value to return — the git wrappers
 * that mutate, and the commands built on them. A query with a "no" to express answers
 * `null` instead; see `git.ts`'s header for that split.
 *
 * The message embeds the child's own stderr rather than keeping it aside, so the one line
 * {@link reportFailure} prints carries both what `wrk` ran and what it was told.
 */
export class CommandFailed extends Error {
  /**
   * The child's exit status, which becomes the process's.
   *
   * Read by {@link reportFailure}, which is the only thing that needs it — a caller
   * catching this type is usually deciding whether to continue, not what to exit with.
   */
  readonly code: number;

  /**
   * @param command - The argv that failed, executable first, for the message.
   * @param code - The child's exit status.
   * @param stderr - What the child wrote to stderr; trimmed into the message.
   */
  constructor(command: readonly string[], code: number, stderr: string) {
    super(`${command.join(" ")} failed (exit ${code}): ${stderr.trim()}`);
    this.code = code;
  }
}

/**
 * Writes a thrown value's human message to stderr and answers the status to exit with.
 *
 * The three exit rules in one function — see this module's header. It is deliberately
 * **not** total: a value that is neither a {@link Refusal} nor a {@link CommandFailed} is
 * rethrown untouched, and before anything is written, so the runtime prints its stack and
 * exits `1` on its own. Mapping an unexpected error to a tidy one-line message would hide
 * the one thing that makes a bug diagnosable.
 *
 * The caller assigns the result to `process.exitCode` rather than passing it to
 * `process.exit`, for the flushing reason this module's header gives.
 *
 * @param error - Whatever was thrown.
 * @returns The exit status this failure calls for.
 * @throws The value it was given, when that value is not one of the two failure types.
 *
 * @example
 * ```ts
 * try {
 *   await main();
 * } catch (error) {
 *   process.exitCode = reportFailure(error);
 * }
 * ```
 */
export function reportFailure(error: unknown): number {
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
