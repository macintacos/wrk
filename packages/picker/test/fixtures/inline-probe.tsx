/**
 * The Ink program EXC-1009's evidence is gathered from — one file, switched by environment.
 *
 * Every question the spike asks is about how Ink behaves in a terminal, so the subject has
 * to be a real child process attached to a pty rather than a component rendered in-process:
 * raw mode, colour detection and the fullscreen threshold are all decided from `isTTY` and
 * the window size of the stream Ink renders to. `test/fixtures/pty.ts` supplies the
 * terminal; this file supplies the thing running inside it.
 *
 * Environment rather than argv, and one file rather than four, because a probe is a
 * fixture: the scenarios differ by a single prop or a single hook call, and four
 * near-identical files would hide that. `PROBE_MODE` selects the scenario; the rest are
 * knobs on it.
 *
 * | Variable | Default | What it does |
 * | --- | --- | --- |
 * | `PROBE_MODE` | `list` | `list`, `input-unguarded`, `input-guarded`, or `fixed-width`. |
 * | `PROBE_ROWS` | `19` | Rows the frame occupies — ~80% of a 24-row viewport. |
 * | `PROBE_ITEMS` | `200` | List length, deliberately far longer than the window. |
 * | `PROBE_FRAMES` | `4` | Redraws before unmounting, so relative addressing is used in anger. |
 * | `PROBE_CLIP` | unset | In `fixed-width` mode, apply the no-shrink and truncate settings. |
 *
 * **Rendering goes to stderr in every mode.** `packages/wrk/src/output.ts` promises stdout
 * is one JSON document per run, so an interactive component that takes Ink's default
 * stream puts escape sequences in the machine channel. Passing `stdout: process.stderr` is
 * the mechanism that file names, and the probe exercises it as its only rendering path
 * rather than as one case among several.
 *
 * @packageDocumentation
 */

import { Box, render, Text, useApp, useInput, useStdin } from "ink";
import { useEffect, useState } from "react";

const MODE = process.env.PROBE_MODE ?? "list";
const ROWS = Number(process.env.PROBE_ROWS ?? 19);
const ITEMS = Number(process.env.PROBE_ITEMS ?? 200);
const FRAMES = Number(process.env.PROBE_FRAMES ?? 4);
const CLIP = process.env.PROBE_CLIP !== undefined;

/** Every item the list could show, of which only {@link ROWS} ever fit. */
const items = Array.from({ length: ITEMS }, (_index, i) => `item ${i}`);

/**
 * Advances a cursor over the list a fixed number of times, then unmounts.
 *
 * The redraws are the point. A first paint proves nothing about relative addressing —
 * it is the second and every later frame, each erasing the last one by walking the cursor
 * back up, that either stays inside the frame or eats the terminal above it.
 *
 * @returns The index of the highlighted row.
 */
function useScroll(): number {
  const { exit } = useApp();
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let frame = 0;
    const timer = setInterval(() => {
      frame += 1;
      if (frame >= FRAMES) {
        clearInterval(timer);
        exit();
        return;
      }
      setSelected((previous) => previous + 1);
    }, 30);

    return () => clearInterval(timer);
  }, [exit]);

  return selected;
}

/** The window of the list that fits, drawn one row per line. */
function List() {
  const selected = useScroll();
  const start = Math.min(selected, items.length - ROWS);

  return (
    <Box flexDirection="column">
      {items.slice(start, start + ROWS).map((item, index) => (
        <Text key={item} inverse={index === selected - start} color="green">
          {item}
        </Text>
      ))}
    </Box>
  );
}

/**
 * The same window, with `useInput` called unconditionally.
 *
 * Ink's `useInput` puts stdin into raw mode, and raw mode is a TTY capability — so this is
 * the shape that throws the moment the picker is run with its stdin piped.
 */
function UnguardedInput() {
  useInput(() => {});
  return <List />;
}

/** The same window, with the guard Ink's own error message points at. */
function GuardedInput() {
  const { isRawModeSupported } = useStdin();
  useInput(() => {}, { isActive: isRawModeSupported });
  return <List />;
}

/**
 * A fixed-width column beside an over-long label.
 *
 * The height of the frame is the assertion: a label that wraps costs a row the height
 * budget did not allow for, and a picker whose rows silently grow is a picker that crosses
 * the fullscreen threshold on someone else's terminal.
 */
function FixedWidth() {
  useScroll();
  const label = "a label far wider than the column it was given to live in";

  return (
    <Box flexDirection="column">
      <Box width={20} flexShrink={CLIP ? 0 : undefined}>
        <Text wrap={CLIP ? "truncate" : undefined}>{label}</Text>
      </Box>
    </Box>
  );
}

const scenarios: Record<string, () => React.ReactElement> = {
  list: List,
  "input-unguarded": UnguardedInput,
  "input-guarded": GuardedInput,
  "fixed-width": FixedWidth,
};

const Scenario = scenarios[MODE];
if (!Scenario) throw new Error(`unknown PROBE_MODE: ${MODE}`);

const instance = render(<Scenario />, { stdout: process.stderr });
await instance.waitUntilExit();
