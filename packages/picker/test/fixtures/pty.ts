/**
 * A real pseudo-terminal to run a probe in, and the measurements taken over what it
 * captures.
 *
 * An inline renderer can only be tested against a terminal, because every question worth
 * asking about one — does it clear the screen, how far up does it erase, is the cursor a
 * TTY's cursor — is answered by the escape sequences it writes to a pty and by nothing
 * else. Piping its output to a buffer changes the answers: Ink reads `isTTY` and the
 * window size off the stream it renders to, and takes different branches when they are
 * absent.
 *
 * The pty comes from `Bun.spawn`'s `terminal` option, so this file adds no dependency —
 * which is the only reason the evidence for EXC-1009 is a `bun test` anyone can re-run
 * rather than a transcript someone eyeballed once. The size is set by the caller, because
 * the whole question is how a frame behaves relative to the viewport it sits in.
 *
 * **A capture is a log of bytes, not a screen.** Nothing here emulates a terminal, so no
 * measurement below can say what a viewer would see — only what was written. That is
 * enough for every claim these tests make, because each one is a statement about the
 * sequences Ink emits, but it is the reason there is no "the prompt is still visible"
 * helper: erasing the screen does not un-write the bytes that put the prompt there, so
 * such a helper could only ever return true.
 *
 * The capture is returned with its escape sequences **intact**. They are the evidence, not
 * noise to be stripped.
 *
 * @packageDocumentation
 */

/**
 * The escape byte every sequence below opens with.
 *
 * Named rather than written into each pattern: a regex literal carrying a control
 * character is invisible to read and rejected by biome's `noControlCharactersInRegex`, a
 * rule aimed at the control character nobody meant to type — the opposite of this file's
 * case. Composing the patterns through `RegExp` states the byte once, by name.
 */
const ESC = "\u001B";

/**
 * Erase-screen — the recognisable head of Ink's fullscreen path.
 *
 * `ansi-escapes` spells `clearTerminal` as erase-screen, erase-scrollback and cursor-home
 * together; this is the first of the three, and matching it alone is what keeps the
 * assertions independent of the other two ever changing.
 */
export const ERASE_SCREEN = `${ESC}[2J`;

/** Cursor hide, written once when a frame first renders. */
export const HIDE_CURSOR = `${ESC}[?25l`;

/** Cursor show, written when Ink unmounts. */
export const SHOW_CURSOR = `${ESC}[?25h`;

/**
 * Erase-line and column-move escapes, which sit between the cursor-up steps of an erase.
 *
 * `\d*[KG]` rather than the three literals, so it covers `2K`, `K`, `G` **and** `1G` — the
 * last being what Ink's incremental renderer writes, and the one that would otherwise
 * split a single walk into two shorter ones and understate {@link maxCursorRise}.
 */
const ERASE_NOISE = new RegExp(`${ESC}\\[\\d*[KG]`, "g");

/** The tail of an erase preamble, after which the frame's own text begins. */
const ERASE_PREAMBLE_END = `${ESC}[G`;

/**
 * Cursor-home, the tail of Ink's *fullscreen* preamble.
 *
 * The counterpart to {@link ERASE_PREAMBLE_END} on the other branch of
 * `shouldClearTerminalForFrame`: erase-screen, erase-scrollback, then home. A capture that
 * contains one of these has a frame beginning after it, and the run that produces one is a
 * viewport shrink — see the resize cases in [`../picker.test.ts`](../picker.test.ts).
 */
const HOME = `${ESC}[H`;

/** One cursor-up step: `ESC [ n A`, where an omitted `n` means one row. */
const CURSOR_UP = new RegExp(`${ESC}\\[(\\d*)A`, "g");

/** A run of cursor-up steps, uninterrupted by anything that writes. */
const CURSOR_UP_RUN = new RegExp(`(?:${ESC}\\[\\d*A)+`, "g");

/** `ESC [ row ; col H` — the cursor sent to a fixed cell rather than moved relatively. */
const ABSOLUTE_ADDRESSING = new RegExp(`${ESC}\\[\\d*(?:;\\d*)?H`);

/** Any SGR sequence — the colours and attributes a `FORCE_COLOR=0` run should not contain. */
const SGR = new RegExp(`${ESC}\\[\\d+(?:;\\d+)*m`);

/** Every escape sequence, for the one measurement that wants the text rather than the codes. */
const ANY_ESCAPE = new RegExp(`${ESC}\\[[\\d;?]*[a-zA-Z]`, "g");

/**
 * The environment a probe starts from: this process's, minus everything that would decide
 * the answer before the probe runs.
 *
 * Shedding these is not tidiness, it is the difference between a suite that measures Ink
 * and one that measures the shell it was launched from. `CI` is the sharp one: Ink's own
 * `interactive` default is `!isInCi && Boolean(stdout.isTTY)`, so a single exported `CI`
 * turns interactive rendering off entirely — and the control assertion in
 * [`../inline-rendering.test.ts`](../inline-rendering.test.ts), the one the whole file's
 * falsifiability rests on, silently stops detecting the failure it exists to detect.
 * `TERM=dumb` and an inherited `NO_COLOR` / `FORCE_COLOR` each break the colour cases the
 * same way. Agent shells and CI runners set all of these routinely.
 *
 * `TERM` is pinned rather than merely dropped, because Ink's colour support is derived from
 * it and an unset `TERM` is as much a decision as a wrong one. The same shape, and the same
 * reasoning, as `FIXTURE_ENV` in
 * [`../../../wrk/test/fixtures/repo.ts`](../../../wrk/test/fixtures/repo.ts).
 */
const BASE_ENV: Record<string, string | undefined> = {
  ...process.env,
  CI: undefined,
  NO_COLOR: undefined,
  FORCE_COLOR: undefined,
  TERM: "xterm-256color",
};

/**
 * The bytes a terminal sends for the keys a picker binds.
 *
 * Written as what the *terminal* transmits, not as what the application receives: an arrow
 * key is three bytes on the wire and a `key.upArrow` only on the far side of Ink's parser.
 * A test that drives a picker is on the wire side.
 */
export const KEY = {
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  /** Carriage return, which is what Enter sends in raw mode — not a newline. */
  enter: "\r",
  escape: ESC,
  /**
   * `DEL`, which is what terminals send for Backspace; `\b` is what almost nothing sends.
   *
   * Built from its code point rather than written as an escape in a literal, so the byte is
   * named here the way {@link ESC} is named above rather than sitting in the source
   * invisibly.
   */
  backspace: String.fromCodePoint(0x7f),
  /** The tilde-terminated forms, which is how a terminal sends the two page keys. */
  pageUp: `${ESC}[5~`,
  pageDown: `${ESC}[6~`,
} as const;

/** The live terminal a {@link PtyOptions.drive} callback is handed. */
export interface PtySession {
  /** Sends bytes to the process as if typed. */
  write(data: string): void;
  /** Changes the viewport, which is a `SIGWINCH` to the process. */
  resize(cols: number, rows: number): void;
  /** Everything received so far. */
  capture(): string;
  /**
   * Waits until the capture satisfies `condition`.
   *
   * The alternative is sleeping a guessed interval before every keystroke, which is how a
   * suite becomes flaky on a loaded machine. Waiting on what the frame actually says is
   * both faster and deterministic.
   *
   * The predicate form is the load-bearing one, because a capture is **cumulative**:
   * {@link waitFor}'s substring can only wait for text that has never appeared, so waiting
   * on a redraw that shows rows already seen — a narrowed filter, a shrunk window — needs a
   * question about the *last frame*, which `frameLines` answers and a substring cannot.
   *
   * @throws If `condition` has not held within `timeoutMs` (3 s by default, deliberately
   *   under `bun test`'s own 5 s so the timeout that fires is the one that says what it was
   *   waiting for).
   */
  waitUntil(condition: (capture: string) => boolean, timeoutMs?: number): Promise<void>;
  /** {@link waitUntil} for the common case: waiting on text that has not appeared before. */
  waitFor(needle: string, timeoutMs?: number): Promise<void>;
}

/** How long one {@link typeUntil} attempt waits for the program to react before typing again. */
const REACT_MS = 200;

/** How many times {@link typeUntil} will re-type before calling the program unresponsive. */
const ATTEMPTS = 12;

/**
 * Types `key` until the program reacts to it, rather than once and hopefully.
 *
 * **A frame on screen does not mean the terminal is ready to be typed at.** Ink enables raw
 * mode from an effect, and React runs effects *after* the frame they belong to has been
 * written, so a key sent the instant a list appears lands in the gap and is **dropped**. It is
 * observable from outside: the byte comes back echoed by the line discipline — an `ESC`
 * arrives in the capture as a literal `^[` — and the program never sees it, leaving the run
 * hung with its frame still up. Roughly one driven run in ten did that before this existed.
 *
 * Re-typing closes the gap, and does so on a **condition** rather than on a settle interval,
 * which is the same rule {@link PtySession.waitUntil} states: a guessed sleep is both slower
 * than it needs to be and still too short on a loaded machine.
 *
 * **`key` must be one whose repetition is harmless, and that is a real constraint rather
 * than a caution.** Nothing here can tell a key that was swallowed from one that landed while
 * the frame it caused was still being written, so a busy machine gets a second keystroke sent
 * after the first has already taken effect. For a key that ends the run the extra one falls on
 * the shell and costs nothing. For an arrow it does not: aiming at a row with another row
 * below it, the second press moves the cursor *past* the row `ready` is watching for, and no
 * later press can bring it back — the loop then spends every attempt and fails, having itself
 * caused the failure. Use this to reach the **last** row of a list, where the reducer clamps
 * and further presses are no-ops, and put the cursor somewhere else by some other means.
 *
 * **Only the first key of a session needs this.** Raw mode is enabled once and stays on, so a
 * key sent after any other key has been observed to land cannot fall into the gap — which is
 * why a driver typically reaches for this once and then writes directly.
 *
 * What the condition *is* belongs to the caller, because what a key causes is observed in
 * different places: a cursor moving is visible only in the frame, while a run ending is
 * whatever the driving script announces. It also has to be about the frame the key was aimed
 * at: a condition naming something a *later* screen shows leaves this typing into the gap
 * between the two, and a tty buffers those keystrokes for whoever goes raw next.
 *
 * @param session - The live terminal, as {@link PtyOptions.drive} is handed one.
 * @param key - The bytes to send. Repetition must be harmless — see above.
 * @param ready - What the capture looks like once the key has landed.
 * @param what - How the failure reads: "the program never `<what>` after N keystrokes".
 * @throws If `ready` never held, which is the genuine hang this is not allowed to hide.
 *
 * @example
 * ```ts
 * const onLastRow = (capture: string) =>
 *   frameLines(capture).some((line) => line.startsWith("▌ gamma"));
 *
 * await typeUntil(pty, KEY.down, onLastRow, "reached the last row");
 * pty.write(KEY.up); // safe unguarded: raw mode is on by now
 * ```
 */
export async function typeUntil(
  session: PtySession,
  key: string,
  ready: (capture: string) => boolean,
  what: string,
): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    session.write(key);
    try {
      await session.waitUntil(ready, REACT_MS);

      return;
    } catch {
      // Not yet raw, or not yet finished. Either way the answer is to type again.
    }
  }

  // The frame is quoted because `waitUntil`'s own message — the one that names it — was
  // swallowed by the `catch` above on every attempt, and "never moved" alone sends a reader to
  // re-drive the scenario by hand to find out where the cursor actually is.
  throw new Error(
    `the program never ${what} after ${ATTEMPTS} keystrokes; last frame: ${frameLines(session.capture())}`,
  );
}

/** Options for {@link runInPty}. */
export interface PtyOptions {
  /** Viewport height. */
  rows: number;
  /** Viewport width. Defaults to 80. */
  cols?: number;
  /** Variables layered over {@link BASE_ENV}, which has already shed the ambient ones. */
  env?: Record<string, string>;
  /**
   * Drives the session while the process runs — types keys, resizes the window.
   *
   * Without this a capture can only show a program's opening frame, which for an
   * interactive component is the one frame that proves the least. Omit it for a probe that
   * runs to completion on its own.
   */
  drive?: (session: PtySession) => Promise<void>;
}

/** What a probe run leaves behind. */
export interface PtyRun {
  /** Everything the terminal received, escape sequences included. */
  capture: string;
  /** The shell's exit status. */
  exitCode: number;
}

/**
 * Runs a shell script inside a pty of the given size and returns everything it wrote.
 *
 * A script rather than an argv because every scenario needs a shell anyway — to lay down
 * scrollback, to print a prompt, to redirect a stream — and threading those through
 * separate options would be more machinery for the same result.
 *
 * @param script - Shell source, run through `bash -c`.
 * @param options - Viewport size, environment, and an optional driver; see
 *   {@link PtyOptions}.
 * @returns The capture and the exit status.
 */
export async function runInPty(script: string, options: PtyOptions): Promise<PtyRun> {
  const chunks: Uint8Array[] = [];
  const capture = () => Buffer.concat(chunks.map(Buffer.from)).toString();

  const proc = Bun.spawn(["bash", "-c", script], {
    env: { ...BASE_ENV, ...options.env },
    terminal: {
      rows: options.rows,
      cols: options.cols ?? 80,
      data(_terminal, data) {
        chunks.push(data);
      },
    },
  });

  const terminal = proc.terminal;
  if (options.drive) {
    // Loudly, rather than silently skipping the driver: a scenario that meant to type keys
    // and instead captured an untouched opening frame would still produce assertions, and
    // they would be about the wrong thing.
    if (!terminal) throw new Error("the spawned process has no terminal to drive");

    const waitUntil = async (condition: (text: string) => boolean, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      while (!condition(capture())) {
        if (Date.now() > deadline)
          throw new Error(`timed out; last frame: ${frameLines(capture())}`);
        await Bun.sleep(10);
      }
    };

    try {
      await options.drive({
        write: (data) => terminal.write(data),
        resize: (cols, rows) => terminal.resize(cols, rows),
        capture,
        waitUntil,
        waitFor: (needle, timeoutMs) => waitUntil((text) => text.includes(needle), timeoutMs),
      });
    } catch (error) {
      // A driver that throws abandons the scenario mid-run, and nothing else will ever end this
      // child: the keystroke that would have dismissed the picker is the one that did not
      // happen. Without this the whole `bash → wrk → gh` tree outlives the failure and keeps
      // running for the test process's lifetime — so one failing case slows every case after
      // it, which is how a single failure becomes a suite that looks flaky.
      //
      // The signal goes to `bash`, and the rest of the tree dies because `bash` is the pty's
      // session leader and its children are the foreground group — not because anything here
      // walks the tree. A **detached** descendant is outside that group and survives, which is
      // why a fixture whose `gh` polls still needs a bound of its own.
      //
      // Awaited, and the terminal closed, because the success path below does both: a kill
      // that has not landed by the time the next case starts is the same leak one step later,
      // and the pty's own file descriptor leaks on every failure otherwise.
      proc.kill();
      await proc.exited;
      terminal.close();

      throw error;
    }
  }

  const exitCode = await proc.exited;
  terminal?.close();

  return { capture: capture(), exitCode };
}

/**
 * How far up the screen a capture ever walked the cursor in one uninterrupted move.
 *
 * This is the blast radius of an inline redraw. Ink erases its previous frame by stepping
 * up one row at a time (`ansi-escapes`' `eraseLines`) or in one multi-row jump (its
 * incremental renderer), then rewrites from there — so a walk deeper than the frame is a
 * walk into whatever the terminal held beforehand, which is exactly how an inline renderer
 * destroys a prompt.
 *
 * The erase and column-move escapes woven through a walk are stripped first, so the steps
 * of a single `eraseLines` collapse into one run and are counted together rather than as a
 * series of unrelated one-row moves.
 *
 * @param capture - A pty capture from {@link runInPty}.
 * @returns The largest total rise, in rows. `0` when the cursor never moved up — which a
 *   caller must not read as "stayed inline": a frame that clears the screen instead of
 *   redrawing relatively also never moves up.
 */
export function maxCursorRise(capture: string): number {
  let deepest = 0;

  for (const [run] of capture.replace(ERASE_NOISE, "").matchAll(CURSOR_UP_RUN)) {
    let rise = 0;
    for (const [, count] of run.matchAll(CURSOR_UP)) rise += count ? Number(count) : 1;
    deepest = Math.max(deepest, rise);
  }

  return deepest;
}

/**
 * Whether the capture ever sent the cursor to a fixed cell.
 *
 * The second way a frame stops being inline: relative addressing survives a scroll because
 * it is relative, and an absolute move does not.
 *
 * @param capture - A pty capture from {@link runInPty}.
 */
export function hasAbsoluteAddressing(capture: string): boolean {
  return ABSOLUTE_ADDRESSING.test(capture);
}

/**
 * Whether the capture carries any colour or text attribute.
 *
 * @param capture - A pty capture from {@link runInPty}.
 */
export function hasColour(capture: string): boolean {
  return SGR.test(capture);
}

/**
 * The height, in rows, of the **last** frame the capture contains.
 *
 * Blank rows are not counted: a frame is measured by its non-empty lines, so a component
 * that deliberately renders a spacer row reads one short here. No probe scenario has one,
 * and a caller that grows one should count differently rather than work around this.
 *
 * @param capture - A pty capture from {@link runInPty}.
 * @returns The number of non-empty lines in the last frame.
 */
export function frameHeight(capture: string): number {
  return frameLines(capture).length;
}

/**
 * Where the **last** frame in a capture begins.
 *
 * Finding this is the whole of {@link frameLines}. The cursor is hidden exactly once, at
 * first paint, so slicing from it keeps every frame ever drawn. Each redraw instead opens
 * with a preamble whose tail is either {@link ERASE_PREAMBLE_END} or {@link HOME}, one per
 * branch of Ink's inline/fullscreen decision, so the text after the *last* of the three
 * markers is the final frame and nothing before it — and on a single-frame run, where no
 * redraw ever happened, the hide is the latest of them and wins.
 */
function lastFrameStart(capture: string): number {
  return Math.max(
    capture.lastIndexOf(ERASE_PREAMBLE_END) + ERASE_PREAMBLE_END.length,
    capture.lastIndexOf(HOME) + HOME.length,
    capture.lastIndexOf(HIDE_CURSOR) + HIDE_CURSOR.length,
  );
}

/**
 * The non-empty lines of the **last** frame, as plain text.
 *
 * What a reader would have seen, in order — which is what an assertion about *ordering*
 * needs and what a substring search over the whole capture cannot give, since every earlier
 * frame is still in the capture too.
 *
 * @param capture - A pty capture from {@link runInPty}.
 * @returns One entry per rendered line, escape sequences stripped.
 */
export function frameLines(capture: string): string[] {
  return capture
    .slice(lastFrameStart(capture))
    .replace(ANY_ESCAPE, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
}

/**
 * The **last** frame with its escape sequences intact.
 *
 * The companion to {@link frameLines}, for the one question that is about the codes rather
 * than the text: whether a highlight was actually emitted, and where.
 *
 * @param capture - A pty capture from {@link runInPty}.
 */
export function lastFrame(capture: string): string {
  return capture.slice(lastFrameStart(capture));
}
