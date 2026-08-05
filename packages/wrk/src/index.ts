/**
 * Public entry point for `@macintacos/wrk`.
 *
 * The package's public surface. The `wrk` binary and its command tree do not
 * exist yet, so what is re-exported here is what other code — and, once there is
 * one, each command — consumes.
 *
 * @packageDocumentation
 */

export { type Conversion, renderConversion, resolveConversion } from "./convert";
