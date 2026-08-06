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

/** What `ansi-escapes` writes to wipe the screen and scrollback — Ink's fullscreen path. */
export const CLEAR_TERMINAL = `${ESC}[2J`;

/** Cursor hide, written once when a frame first renders. */
export const HIDE_CURSOR = `${ESC}[?25l`;

/** Cursor show, written when Ink unmounts. */
export const SHOW_CURSOR = `${ESC}[?25h`;

/** Erase-line and column-move escapes, which sit between the cursor-up steps of an erase. */
const ERASE_NOISE = new RegExp(`${ESC}\\[(?:2K|K|G)`, "g");

/** One cursor-up step: `ESC [ n A`, where an omitted `n` means one row. */
const CURSOR_UP = new RegExp(`${ESC}\\[(\\d*)A`, "g");

/** A run of cursor-up steps, uninterrupted by anything that writes. */
const CURSOR_UP_RUN = new RegExp(`(?:${ESC}\\[\\d*A)+`, "g");

/** `ESC [ row ; col H` — the cursor sent to a fixed cell rather than moved relatively. */
const ABSOLUTE_ADDRESSING = new RegExp(`${ESC}\\[\\d*(?:;\\d*)?H`);

/** Any SGR sequence — the colours and attributes a `NO_COLOR` run should not contain. */
const SGR = new RegExp(`${ESC}\\[\\d+(?:;\\d+)*m`);

/** Options for {@link runInPty}. */
export interface PtyOptions {
  /** Viewport height. */
  rows: number;
  /** Viewport width. Defaults to 80. */
  cols?: number;
  /** Extra environment for the shell. */
  env?: Record<string, string>;
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
 * @param options - Viewport size and environment; see {@link PtyOptions}.
 * @returns The capture and the exit status.
 */
export async function runInPty(script: string, options: PtyOptions): Promise<PtyRun> {
  const chunks: Uint8Array[] = [];

  const proc = Bun.spawn(["bash", "-c", script], {
    env: { ...process.env, ...options.env },
    terminal: {
      rows: options.rows,
      cols: options.cols ?? 80,
      data(_terminal, data) {
        chunks.push(data);
      },
    },
  });

  const exitCode = await proc.exited;
  proc.terminal?.close();

  return { capture: Buffer.concat(chunks.map(Buffer.from)).toString(), exitCode };
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
 * @returns The largest total rise, in rows. `0` when the cursor never moved up.
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
 * The frame's height, in rows, as the terminal would show it.
 *
 * Everything the shell wrote before the probe started is dropped by taking only what
 * follows the last cursor-hide, and the remaining escape sequences are removed so what is
 * left is the text of the final frame.
 *
 * @param capture - A pty capture from {@link runInPty}.
 * @returns The number of non-empty lines in the last frame.
 */
export function frameHeight(capture: string): number {
  const lastFrame = capture.slice(capture.lastIndexOf(HIDE_CURSOR) + HIDE_CURSOR.length);

  return lastFrame
    .replace(new RegExp(`${ESC}\\[[\\d;?]*[a-zA-Z]`, "g"), "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "").length;
}
