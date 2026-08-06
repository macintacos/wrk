/**
 * Public entry point for `@macintacos/wrk-picker`.
 *
 * The picker component lands in EXC-985; its public API surface and semver
 * policy are settled in EXC-1014, before the first publish. Until then this
 * module re-exports what already exists, and keeps the package's `exports` map
 * resolving.
 *
 * @packageDocumentation
 */

export { type FuzzyMatch, fuzzyMatch } from "./fuzzy";
