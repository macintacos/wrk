/**
 * Public entry point for `@macintacos/wrk-picker`.
 *
 * Three things: the picker itself, the matcher it filters with, and the
 * sanitizer it puts every row through. This list *is* the published surface —
 * the manifest's `exports` maps `"."` alone, so nothing reachable by a deep
 * path is public — and [`../README.md`](../README.md) states it alongside the
 * semver policy that governs changing it.
 *
 * Each module's working halves stay internal. The matcher's version constants
 * (`./fuzzy`) exist for its own resync test, `reduce` (`./picker`) is a batch
 * of actions applied with no render between them, and `stripSgr`
 * (`./sanitize`) is the form the picker matches against rather than anything a
 * consumer needs.
 *
 * @packageDocumentation
 */

export { type FuzzyMatch, fuzzyMatch } from "./fuzzy";
export {
  NotATerminal,
  type PickerColumn,
  type PickerRow,
  type PickOptions,
  pick,
} from "./picker";
export { sanitize } from "./sanitize";
