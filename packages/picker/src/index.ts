/**
 * Public entry point for `@macintacos/wrk-picker`.
 *
 * Three things: the picker itself, the matcher it filters with, and the
 * sanitizer it puts every row through. The API surface and semver policy are
 * settled in EXC-1014, before the first publish, so what is exported here is
 * what that issue will have to bless — which is why each module's working
 * halves stay internal. The matcher's version constants (`./fuzzy`) exist for
 * its own resync test, and `stripSgr` (`./sanitize`) is the form the picker
 * matches against rather than anything a consumer needs.
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
