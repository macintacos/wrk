/**
 * The two failure types `wrk`'s exit rules are expressed over.
 *
 * They live in a module of their own because **every layer of the package throws one and
 * nothing here needs anything back.** This module imports nothing — not `node:process`, not a
 * repository-shaped value, not even a type — so depending on it costs a layer nothing and says
 * nothing about that layer's own dependencies. That is the whole design: the git plumbing in
 * [`./git`](./git) and the pure naming rules in [`./naming`](./naming) both raise a failure, and
 * neither should have to import a module that writes to `process.stderr` in order to do it.
 *
 * The split against [`./output`](./output) runs along "does it touch a stream": the classes are
 * here, and `reportFailure` — which decides what a thrown value *prints* and what the process
 * exits with — stays there, with the two channels it writes to. `output.ts`'s header is the
 * specification for the contract itself; this module is only the vocabulary it is written in.
 *
 * @packageDocumentation
 */

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
 * It is a class here rather than beside `RunResult` in `proc.ts` because `proc.ts`
 * deliberately reports a nonzero exit as a *value* and raises nothing, so an error class there
 * would be one the module itself never throws.
 *
 * The message embeds the child's own stderr rather than keeping it aside, so the one line
 * `reportFailure` prints carries both what `wrk` ran and what it was told.
 */
export class CommandFailed extends Error {
  /**
   * The child's exit status, which becomes the process's.
   *
   * Read by `reportFailure`, which is the only thing that needs it — a caller catching this
   * type is usually deciding whether to continue, not what to exit with.
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
