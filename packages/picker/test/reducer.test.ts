/**
 * The picker's reducer, applied by hand.
 *
 * [`./picker.test.ts`](./picker.test.ts) drives the component through a real terminal, which
 * is where every claim about what a *user* sees has to be settled. It cannot settle this
 * file's claims, because they are about **batching**: what happens when the keyboard and a
 * row replacement land in the same React batch, with no render in between. A pty can type
 * keys and drop a file, but it cannot schedule those two into one batch on purpose — the
 * closest it gets is a sequence with a `waitUntil` between the halves, which is the case the
 * hazard is not.
 *
 * So the reducer is applied directly here: no React, no terminal, one call per action, in
 * the order React would apply them. That is also the only place the fallback rule can be
 * observed as a *state transition* rather than as a rendered frame, which matters because
 * the difference between the two shows up one replacement later.
 *
 * @packageDocumentation
 */

import { describe, expect, test } from "bun:test";

import type { PickerRow } from "../src/picker";
import { reduce } from "../src/picker";

/** Three rows, as `wrk wt` first draws them. */
const PLAIN: PickerRow<string>[] = [
  { payload: "/wt/alpha", columns: [{ text: "wt-alpha" }] },
  { payload: "/wt/beta", columns: [{ text: "wt-beta" }] },
  { payload: "/wt/gamma", columns: [{ text: "wt-gamma" }] },
];

/** {@link PLAIN} annotated, with `gamma` gone — the refresh found it had been removed. */
const REFRESHED: PickerRow<string>[] = [
  { payload: "/wt/alpha", columns: [{ text: "wt-alpha" }, { text: "#41" }] },
  { payload: "/wt/beta", columns: [{ text: "wt-beta" }, { text: "#42" }] },
];

/** The payloads of a row set, which is the shape a `move` action carries. */
const payloadsOf = (rows: readonly PickerRow<string>[]): string[] => rows.map((row) => row.payload);

/** A picker that has just opened on {@link PLAIN}. */
const opened = () => ({ query: "", selected: undefined, top: 0, previewTop: 0, rows: PLAIN });

/** The list rows a `move` is budgeted, large enough that `top` never moves in these cases. */
const LIST_ROWS = 10;

describe("a replacement leaves the keystroke writer's state alone", () => {
  test("the query, the selection and the scroll top all survive it", () => {
    const typed = reduce(opened(), { type: "retype", edit: () => "beta" });
    const moved = reduce(typed, {
      type: "move",
      delta: 1,
      payloads: payloadsOf(PLAIN),
      listRows: LIST_ROWS,
    });

    const after = reduce(moved, { type: "replace", rows: REFRESHED });

    expect(after.query).toBe("beta");
    expect(after.selected).toBe("/wt/beta");
    expect(after.top).toBe(moved.top);
    expect(after.rows).toBe(REFRESHED);
  });

  test("a payload the replacement dropped stops being the selection", () => {
    // Not cosmetic, and not the same as the cursor rendering at the top: a dangling identity
    // left in state comes back to life the moment a later replacement re-introduces that
    // payload, and the cursor teleports out from under a user who has been sitting on the
    // fallback row. `onOpen` promises `replace` may be called any number of times, so "the
    // fallback holds for exactly one replacement" is not good enough.
    const onGamma = reduce(opened(), {
      type: "move",
      delta: 2,
      payloads: payloadsOf(PLAIN),
      listRows: LIST_ROWS,
    });

    expect(onGamma.selected).toBe("/wt/gamma");

    const dropped = reduce(onGamma, { type: "replace", rows: REFRESHED });
    const restored = reduce(dropped, { type: "replace", rows: PLAIN });

    expect(dropped.selected).toBeUndefined();
    expect(restored.selected).toBeUndefined();
  });
});

describe("the two writers meeting in one batch", () => {
  test("a move whose row list predates the replacement resolves against the old list", () => {
    // The batch the pty cannot schedule. A `useInput` handler closes over the payloads of
    // the last *render*, so a replacement dispatched from a promise earlier in the same
    // batch is already in the state the move is applied to while the move's own snapshot is
    // one row set behind. The reducer guarantees the two writes are applied **in order**; it
    // cannot make an action's payload fresh. So the move answers what the old list said —
    // here, two rows below `alpha`, which is a worktree the refresh has just removed.
    const onAlpha = reduce(opened(), {
      type: "move",
      delta: 0,
      payloads: payloadsOf(PLAIN),
      listRows: LIST_ROWS,
    });

    const swapped = reduce(onAlpha, { type: "replace", rows: REFRESHED });
    const stale = reduce(swapped, {
      type: "move",
      delta: 2,
      payloads: payloadsOf(PLAIN),
      listRows: LIST_ROWS,
    });

    expect(stale.selected).toBe("/wt/gamma");

    // Which costs one frame with the cursor on the top row — a payload the rows do not
    // contain has no index, and `Picker` floors that to zero exactly as it does for a row
    // the replacement dropped (`picker.test.ts` asserts that frame). The next replacement
    // then clears it, so the window is one batch wide and cannot compound.
    expect(reduce(stale, { type: "replace", rows: REFRESHED }).selected).toBeUndefined();
  });

  test("a replacement that empties the list leaves nothing selected", () => {
    // What a refresh that finds no worktrees at all produces. The component renders its
    // `no matches` line and Enter resolves `null`; the state half of that is here.
    const onBeta = reduce(opened(), {
      type: "move",
      delta: 1,
      payloads: payloadsOf(PLAIN),
      listRows: LIST_ROWS,
    });

    const emptied = reduce(onBeta, { type: "replace", rows: [] });

    expect(emptied.selected).toBeUndefined();
    expect(
      reduce(emptied, { type: "move", delta: 1, payloads: [], listRows: LIST_ROWS }).selected,
    ).toBeUndefined();
  });
});
