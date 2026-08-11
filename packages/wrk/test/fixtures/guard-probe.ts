/**
 * One cold `guardEdit` call, as the wiring around it would make it.
 *
 * Not a test file, and deliberately outside the `*.test.ts` glob `bun test` collects. It exists
 * because the number `guard.test.ts`'s budget case asserts on is **invocation to verdict**, and
 * the runtime's own cold start and this module graph's load are the larger halves of it — both
 * outside the clock of any in-process measurement.
 *
 * The import is static, exactly as a hook's entrypoint would write it, so whatever `./guard`
 * reaches is paid for here in full rather than deferred past the answer.
 */

import { guardEdit } from "../../src/guard";

const [filePath, cwd] = process.argv.slice(2);
if (filePath === undefined || cwd === undefined) throw new Error("usage: guard-probe <path> <cwd>");

const decided = await guardEdit(filePath, cwd);

process.stdout.write(decided.allowed ? "allowed\n" : "blocked\n");
