# @macintacos/wrk-picker

A list you filter by typing, rendered **inline** beneath whatever the terminal already
held — no alternate screen, no scrollback taken, and the frame erased on the way out.

`fzf`'s shape, as a function you call rather than a process you pipe to. Rows arrive as
data, each carrying a payload of your own; `pick()` resolves the payload of the row the
user chose.

```bash
bun add @macintacos/wrk-picker
```

```ts
import { pick } from "@macintacos/wrk-picker";

const branch = await pick({
  rows: [
    { payload: "main", columns: [{ text: "main" }, { text: "the default", color: "gray" }] },
    { payload: "wip", columns: [{ text: "wip" }, { text: "3 commits ahead", color: "yellow" }] },
  ],
});

if (branch !== null) console.log(`you picked ${branch}`);
```

## Requirements

**A TypeScript-aware runtime.** The package publishes its source: `exports` points at
`src/index.ts`, so there is no build step, no `dist/`, and no separate `.d.ts` to fall out
of step with the code. Bun runs it as-is. Plain `node` does not.

**A terminal on stdin and stderr.** The picker draws to **stderr**, so stdout stays free
for whatever your program prints — the picker's own answer included. Neither stream being
a TTY is a refusal rather than a fallback: `pick()` throws `NotATerminal` before anything
is drawn, so a piped invocation fails immediately instead of waiting forever for a
keystroke it can never receive.

## The public API

Everything the package exports, and nothing else. The manifest's `exports` map names `"."`
alone, so a deep path such as `@macintacos/wrk-picker/src/fuzzy` does not resolve at all —
the surface below is enforced by the package, not merely documented by it.

| Export         | Kind      | What it is                                                       |
| -------------- | --------- | ---------------------------------------------------------------- |
| `pick`         | function  | Shows the picker; resolves the chosen payload, or `null`.        |
| `PickOptions`  | interface | Everything `pick` takes.                                         |
| `PickerRow`    | interface | One row: its payload and its columns.                            |
| `PickerColumn` | interface | One aligned column of a row.                                     |
| `NotATerminal` | class     | Thrown by `pick` when there is no terminal to pick in.           |
| `fuzzyMatch`   | function  | The matcher the filter uses: fzf's `FuzzyMatchV2`, with positions. |
| `FuzzyMatch`   | interface | A match: its score and the code-point positions it matched.      |
| `sanitize`     | function  | Makes untrusted text safe to write to a terminal, keeping colour. |

## `pick(options)`

Resolves the chosen row's `payload`, or `null`.
**`null` covers all three ways a run ends without a choice** — Escape, `Ctrl-C`, and Enter
on an empty result set — so a caller mapping this onto a cancellation should map all
three. Throws `NotATerminal` if stdin or stderr is not a TTY.

| Option    | Type                                                | Required | What it does                                                       |
| --------- | --------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `rows`    | `readonly PickerRow<T>[]`                           | yes      | The rows to open on, in the order they will be shown.              |
| `prompt`  | `string`                                            | no       | What precedes the query on the first line. Defaults to `"❯ "`.     |
| `onOpen`  | `(replace: (rows) => void) => void`                 | no       | Called once when the picker opens, with a handle that swaps the whole row set. |
| `preview` | `(payload: T, width: number) => string \| Promise<string>` | no | What to show beside the list for the selected row.                 |

**Filtering never reorders.** `fuzzyMatch` returns a score and the picker deliberately
ignores it: a list of worktrees or pull requests is already in an order that means
something, and re-ranking on every keystroke moves the row the user was reaching for.

**Keys.** Type to filter, `↑`/`↓` to move, `Enter` to choose, `Escape` to dismiss. With a
preview pane, `PageUp`/`PageDown` scroll the pane independently of the list.

**Colour.** Decided from stderr rather than stdout, because that is the stream being drawn
on — a picker whose stdout is piped keeps its colour. `NO_COLOR` is honoured, and it
strips a row's *own* colour too: passing that through would honour the letter of the
setting while breaking it. The selection is marked with a gutter bar rather than an
inverse, so it survives `NO_COLOR` with no escape sequence at all.

**Height.** The frame is held to ~80% of the terminal's rows, measured from stderr and
recomputed on resize. That is what keeps rendering inline: Ink takes the whole screen the
moment a frame is as tall as its viewport, with no gradual degradation in between.

### `PickerRow` and the payload-identity contract

```ts
interface PickerRow<T> {
  readonly payload: T;
  readonly columns: readonly PickerColumn[];
}
```

A row's `payload` is what choosing it resolves to — a worktree path, a pull-request number
— carried beside the columns rather than parsed back out of them. It is
**also the row's identity**, and that puts two obligations on the caller:

1. **A payload must come back equal from a refetch.** Selection is tracked by payload and
   restored with `===`. A string or a number does this; an object rebuilt from the same
   fields does not.
2. **A payload must be unique across the rows.** The cursor resolves to the *first* `===`
   hit, so a duplicate makes every later row carrying it unreachable.

Both fail silently — a row that cannot be selected, or a cursor that jumps somewhere the
user did not put it. When display text is the natural payload and two rows can share it,
carry something that distinguishes them (a path, an id) as the payload and show the text
in a column.

### `PickerColumn`

```ts
interface PickerColumn {
  readonly text: string;
  readonly color?: string;
}
```

`color` is a chalk colour name or hex string, ignored under `NO_COLOR`. There is
deliberately no `width`: a column is sized to its widest cell across **all** rows — all,
not the filtered ones, so a column cannot change width as the user types — and a caller
who wants a wider one pads its text.

`text` is sanitized before it reaches the terminal. A cell carrying its own SGR keeps its
colour but forgoes match highlighting; the two cannot both be had without an ANSI state
machine.

### `onOpen`, and cancelling background work

`onOpen` is the channel for rows that are not ready when the picker has to be: open on a
stale cache, and take the fresh rows when they land. `replace` may be called any number of
times, from anywhere, and takes effect on the next frame. The user's query and the row
their cursor is on both survive it — see the payload contract above for what "the row they
are on" is matched by.

A `replace` arriving after the user has chosen is ignored, so a refresh losing its race is
not an error to guard against. **Stopping that refresh is the caller's job**, and the
caller already owns everything it needs to do so:

```ts
const refresh = new AbortController();

try {
  return await pick({
    rows: cached,
    onOpen: (replace) => {
      fetchFresh({ signal: refresh.signal }).then(replace, () => {});
    },
  });
} finally {
  refresh.abort();
}
```

`pick()` takes no `AbortSignal` of its own. Handing one out would be an additive second
parameter to `onOpen` — a callback ignoring it keeps compiling — so it stays available as
a minor-version change if a consumer shows it is worth having, rather than surface added
before anyone needs it.

### `preview`

Called with the selected row's `payload` and the pane's exact width in terminal cells, and
called again whenever either changes. The pane takes 40% of the terminal's columns behind
a one-column seam, and its height is the list's own — so a pane costs the frame no extra
rows.

**The width is handed to you rather than inferred**, and answering it is the caller's half
of the resize contract: text rendered for one width and replayed at another is wrapped
wrong, so cache your rendered output keyed on the number you were given.

The text is displayed as given — pre-rendered ANSI, colour and hyperlinks intact — after
sanitizing. A rejected promise is displayed rather than thrown, since an unhandled one
would take the process down with the terminal still in raw mode.

### `sanitize`

```ts
function sanitize(text: string): string;
```

The picker's own trust boundary, exported because a program showing untrusted text
elsewhere needs the same filter. **SGR survives; everything else goes** — every other CSI
sequence, every string family (OSC, DCS, SOS, PM, APC) with its payload, the C0/C1 ranges
including their eight-bit CSI and OSC forms, and the bidirectional controls.

A branch name or a pull-request title on a fork is written by whoever opened it, and a
terminal does not distinguish text from instructions: an embedded escape can erase the
screen, rename the window, write the clipboard through OSC 52, or reverse a row so it
reads as a different branch than the one it carries. **Ink does not already do this** — it
preserves OSC by design, which is the family that matters most here.

`pick()` runs every row through this itself. You need it only for text you render outside
the picker.

### `fuzzyMatch`

```ts
function fuzzyMatch(text: string, query: string): FuzzyMatch | null;
interface FuzzyMatch {
  readonly score: number;
  readonly positions: readonly number[];
}
```

fzf's `FuzzyMatchV2` ported to TypeScript — scores *and* the positions that matched, which
is what a cheaper subsequence scan gets wrong. `positions` are **code-point** indices into
`text`, not terminal cells; they differ for every wide, combining and emoji character.

Exactness is pinned by a golden corpus of several thousand cases frozen from real fzf
`v0.74.2` and replayed in this package's tests. It diverges from fzf only above fzf's own
slab threshold, where fzf switches to a greedy fallback this port does not implement:
`text.length × query.length` past `100 * 1024`. List rows are four orders of magnitude
short of that.

## Semver policy

The package is **`0.x`**. Under [semver](https://semver.org) that means a **minor** may
break the surface below and a **patch** never does. When the surface has held through real
use it will go to `1.0.0` and minors become additive-only; until then, pin what you depend
on.

**What the policy covers** is exactly the exports table above and the documented behaviour
of each. Anything not reachable through `@macintacos/wrk-picker` is not covered, and the
`exports` map makes that unreachable rather than merely discouraged.

These are the changes that are **not** breaking, so the deferrals this package ships with
can be resolved without a major:

- A new optional field on `PickOptions`.
- A new **parameter** on `onOpen` or `preview` — a callback that ignores it keeps
  compiling. This is the door left open for a cancellation signal.
- A new export.
- A widening of an accepted type, or a narrowing of a returned one.

These **are** breaking: removing or renaming an export, adding a required field, changing
what `pick()` resolves to, narrowing an accepted type, and changing which key does what.

Behaviour not described here — the exact escape sequences a frame is made of, the score a
particular query earns, the pane's 40% share — is implementation, and may move in a patch.

## Known ceilings

- **The filter is O(rows) per keystroke.** `fuzzyMatch` runs once per row per keystroke
  and the query is not pre-compiled: roughly 4–6 ms per keystroke at 5,000 rows, and
  imperceptible at the hundreds these pickers actually list. If you feed it thousands,
  that is the number to measure against.
- **The preview is not debounced.** One call per row the cursor passes through, and one
  per column count a resize drag passes through. Cache on `(payload, width)` — which you
  want anyway, per the resize contract above.
- **Mid-session terminal *shrink* is out of scope.** The frame that meets a smaller
  viewport is the one budgeted for the old size, so Ink takes the screen for exactly that
  frame before the re-budgeted one lands. It settles back on the next frame. Every inline
  Ink app behaves this way.

## Publishing

**`bun publish`, from `packages/picker`. Never `npm publish`.** npm performs no
workspace-protocol substitution, so a tarball cut by it carries the literal `workspace:`
specifier and every install fails with `EUNSUPPORTEDPROTOCOL` — while the publish itself
reports success, so nothing catches it.

`bun pm pack --dry-run` lists what would ship. It must be `package.json`, this README, and
`src/` — the repository's `test/workspace.test.ts` asserts exactly that, because the
`tools/fzf-golden` Go generator and the 0.33 MB golden corpus beside it are six times the
size of the package and belong to nobody but the tests.
