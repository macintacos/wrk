/**
 * Public entry point for `@macintacos/wrk-picker`.
 *
 * The picker component lands in EXC-985; its public API surface and semver
 * policy are settled in EXC-1014, before the first publish. Until then this
 * module exports the matcher and keeps the package's `exports` map resolving.
 * The matcher's version constants stay internal to `./fuzzy` — they exist for
 * its own resync test, not for consumers.
 *
 * @packageDocumentation
 */

export { type FuzzyMatch, fuzzyMatch } from "./fuzzy";
