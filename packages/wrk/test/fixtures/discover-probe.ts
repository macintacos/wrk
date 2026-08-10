/**
 * Orphan recovery, run as a real process so a real terminal can be driven against it.
 *
 * `resolveRepo` opens a picker, and a picker reads `process.stdin` and draws on
 * `process.stderr` — both of which answer differently when they are not a TTY. So the three
 * things this exists to pin are all properties of a *process*: the path on stdout, the empty
 * stdout of a dismissal, and the exit status that tells the two apart. The terminal comes from
 * [`../../../picker/test/fixtures/pty.ts`](../../../picker/test/fixtures/pty.ts), exactly as
 * [`../../../picker/test/fixtures/picker-probe.ts`](../../../picker/test/fixtures/picker-probe.ts)
 * takes it; nothing here rebuilds one.
 *
 * | Variable | What it does |
 * | --- | --- |
 * | `PROBE_CONFIG` | Path of the global `config.toml` to read `search.roots` and `search.depth` from. Unset reads the machine's real one, which no case wants. |
 *
 * The answer goes out through `emitLine` and every throw through `reportFailure`, so this
 * probe is the real `cd` protocol rather than an imitation of it: the exit statuses a case
 * asserts (`0`, `1`, `130`) are the ones `output.ts` decides, not ones written here.
 *
 * @packageDocumentation
 */

import { resolveRepo } from "../../src/discover";
import { emitLine, reportFailure } from "../../src/output";

try {
  emitLine(await resolveRepo(process.cwd(), { globalPath: process.env.PROBE_CONFIG }));
} catch (error) {
  process.exitCode = reportFailure(error);
}
