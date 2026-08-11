/**
 * Typed read and write of `.project-meta.json`, the per-repository file every tool in this
 * workflow keeps its own namespace in.
 *
 * ```jsonc
 * // <container>/.project-meta.json
 * {
 *   "search": { "externalPaths": ["~/GitLocal"] }, // the search-scope guard's
 *   "linear": { "projectName": "wrk" },            // the Linear skills'
 *   "git": { "allowDefaultBranchCommits": true },  // the commit guard's
 *   "wrk": { "search": { "depth": 1 } }            // this package's, read by ./config
 * }
 * ```
 *
 * **The file is resolved against the container, never against a checkout.** It is
 * *untracked* — it sits in the global gitignore — so git does not carry it into a new
 * worktree. Resolved against a checkout, every run worktree would look for its own copy,
 * find none, and silently fall back to defaults; resolved against the container, the
 * default-branch checkout and every worktree read the one file. That is why the container
 * arrives as a parameter here, exactly as it does in [`./config`](./config) and as
 * `CacheKey.container` does in [`./cache`](./cache): resolving it is
 * [`./repo`](./repo)'s single responsibility, and taking it rather than finding it leaves
 * this module testable with no git repository in sight.
 *
 * **Nothing here reports a bad file — on the read path.** A missing file, an unreadable
 * one, malformed JSON, a root that is not an object, an absent namespace and an absent key
 * all degrade to the same answer, because every caller does the same thing with each: fall
 * through to its default. Distinguishing them would only feed a diagnostic this module is
 * specified not to emit. {@link writeKey} is the exception and has to be: it has no
 * default to fall through to, so it reports a refusal in its return and lets a genuine I/O
 * failure throw.
 *
 * **No dependencies beyond `node:`, deliberately.** [`./config`](./config) validates a
 * dozen typed fields through `zod` and earns it; this module asks "is this a table?" and
 * "is this exactly `true` or exactly `false`?", which is two lines of TypeScript. The
 * consumer that matters most is an edit guard firing on every file write, whose governing
 * rule is that a guard must never block on its own bug — so the cheapest possible import
 * graph is a feature of this module rather than an accident.
 *
 * @packageDocumentation
 */

import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The container-level file every namespace hangs off.
 *
 * Exported so that a caller naming the file to a user — "add it to `.project-meta.json`" —
 * and a test writing a fixture both spell it from here rather than keeping a second copy
 * of the literal that can drift from the one this module actually resolves.
 */
export const PROJECT_META = ".project-meta.json";

/**
 * Anything `JSON.stringify` round-trips.
 *
 * `undefined` is excluded rather than tolerated: `JSON.stringify` **drops** an object
 * member whose value is `undefined`, so writing one would report success and leave the key
 * absent — the one outcome a durable authorization must never have.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A namespaced flag's three states, where **absent is not the same as `false`**.
 *
 * The distinction is the whole point of reading the file three-state rather than as a
 * boolean, and it is what the `git.allowDefaultBranchCommits` flag already means in
 * practice:
 *
 * - `granted` — the guard is skipped, and this counts as *durable* authorization: the user
 *   wrote it into a file rather than answering one prompt, so a later action covered by
 *   the same decision needs no fresh confirmation.
 * - `withheld` — the guard applies, silently. The question has been answered; asking again
 *   would be nagging.
 * - `unset` — the guard applies **and** the caller surfaces a tip naming the flag. Nobody
 *   has decided yet, so this is the one state where telling the user the file exists is
 *   useful rather than noise.
 *
 * Collapsing `withheld` and `unset` to `false` is the bug this type exists to prevent: it
 * would either nag a user who has already declined, or silently withhold the tip from one
 * who has never been offered it.
 */
export type Consent = "granted" | "withheld" | "unset";

/** A JSON object, as read back — one namespace's contents, or the whole document. */
type Table = Record<string, unknown>;

/**
 * Distinguishes staging files written by this process.
 *
 * The pid alone is not enough, for the reason [`./cache`](./cache) spells out: two
 * overlapping writes would share a staging path, so the first `rename` takes the file and
 * the second fails `ENOENT` — after {@link writeKey} has already promised the first caller
 * `true` for bytes no longer on disk.
 */
let staged = 0;

/**
 * `value` as a table, or `null` for everything else JSON can hold.
 *
 * The `Array.isArray` half is not defensive padding: `typeof [] === "object"`, and a
 * document whose root is a JSON array is a shape that reaches this in practice.
 */
function asTable(value: unknown): Table | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Table)
    : null;
}

/**
 * The document at `path`, an empty one when the file simply is not there, or `null` when
 * it exists but cannot be used.
 *
 * The three-way answer is what lets one helper serve both halves of this module. A reader
 * treats "absent" and "unusable" alike, because an empty document has no namespace to
 * offer either; a writer must not, because it may **create** a file that is absent and
 * must **refuse** one whose contents it cannot preserve.
 *
 * That is also why `ENOENT` is singled out rather than every read failure collapsing to an
 * empty document. A file that exists but cannot be read — mode `000`, a directory under
 * the name — would otherwise be treated as absent and replaced wholesale, destroying
 * exactly the namespaces this module promises to preserve.
 */
async function readDocument(path: string): Promise<Table | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }

  try {
    return asTable(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Reads one namespace's table out of the container's `.project-meta.json`.
 *
 * @param container - The repository's container, as `containerFor` answers it.
 * @param namespace - The top-level key the reading tool owns, e.g. `"wrk"` or `"git"`.
 * @returns The namespace's own table, or `null` when there is not one to answer with — a
 *   missing, unreadable or malformed file, a document that is not a JSON object, an absent
 *   namespace, or a namespace whose value cannot hold keys. Never throws.
 *
 * @example
 * ```ts
 * const linear = await readNamespace(await containerFor(), "linear");
 * const project = typeof linear?.projectName === "string" ? linear.projectName : null;
 * ```
 */
export async function readNamespace(
  container: string,
  namespace: string,
): Promise<Record<string, unknown> | null> {
  const document = await readDocument(join(container, PROJECT_META));

  return asTable(document?.[namespace]);
}

/**
 * Reads one namespaced flag as a three-state {@link Consent}.
 *
 * **Only a JSON `true` or `false` is a decision.** `"true"`, `1`, `null` and every other
 * value answer `unset`, alongside the absent key and the absent file. A truthy string is a
 * typo, and reading one as `granted` would authorize an action on the strength of it.
 *
 * @param container - The repository's container, as `containerFor` answers it.
 * @param namespace - The top-level key the flag lives under, e.g. `"git"`.
 * @param key - The flag's own name, e.g. `"allowDefaultBranchCommits"`.
 * @returns Which of the three states the file puts the flag in. Never throws.
 *
 * @example
 * ```ts
 * switch (await readConsent(container, "git", "allowDefaultBranchCommits")) {
 *   case "granted": return commit();
 *   case "withheld": return guard();
 *   case "unset": return guard({ tip: `add it to ${PROJECT_META} to skip this next time` });
 * }
 * ```
 */
export async function readConsent(
  container: string,
  namespace: string,
  key: string,
): Promise<Consent> {
  const value = (await readNamespace(container, namespace))?.[key];
  if (value === true) return "granted";

  return value === false ? "withheld" : "unset";
}

/**
 * Sets one namespaced key, leaving every other namespace and every sibling key alone.
 *
 * The document is read, one key inside one namespace is replaced, and the whole thing is
 * written back with **two-space indentation and a trailing newline** — the shape a human
 * hand-editing this file writes, and the shape the other tools sharing it already leave
 * behind. Rewriting a file `wrk` is a guest in to some other layout is not a tidy-up.
 *
 * **The refusal is an existing file whose contents cannot be preserved** — unparseable
 * JSON, a root that is not an object, or one this process cannot read at all. Storing one
 * flag is not worth destroying another tool's configuration, and all three cases leave the
 * caller with the same thing to say: something is in the way, go and look at the file. A
 * file that is simply *absent* is not that case — it is created holding just this
 * namespace, provided the container itself exists. A namespace whose current value cannot
 * hold keys — `"git": 3` — is replaced, since there is nothing there to preserve and the
 * loss is confined to the namespace the caller owns.
 *
 * Genuine I/O failures at write time propagate rather than degrading to `false`, so the
 * two channels split on what the caller can still believe about the disk rather than on
 * the error's kind: `false` means nothing was touched, while a throw means the attempt got
 * as far as writing. One consequence is worth knowing — an unreadable file answers `false`
 * while an unwritable container throws, so the same permission fault takes either channel
 * depending on which syscall meets it first.
 *
 * The value is staged to `<path>.<pid>.<n>.tmp` and `rename`d over the target, which is
 * [`./cache`](./cache)'s pattern down to the counter, and for a sharper reason here:
 * `rename(2)` within a directory is atomic, so a write that dies part-way never publishes
 * a truncated document — and a truncated document is precisely the loss of the namespaces
 * above.
 *
 * @param container - The repository's container, as `containerFor` answers it.
 * @param namespace - The top-level key the writing tool owns.
 * @param key - The key to set within it.
 * @param value - What to set it to. Anything JSON round-trips; see {@link JsonValue}.
 * @returns `true` when the file now holds the value, `false` when the write was declined
 *   because an existing document could not be read or parsed, and so could not be
 *   preserved.
 * @throws If the file cannot be written or renamed. The staging file is removed
 *   best-effort first; a cleanup that itself fails is swallowed rather than replacing the
 *   error the caller needs.
 *
 * @example
 * ```ts
 * await writeKey(container, "git", "allowDefaultBranchCommits", true);
 * ```
 */
// ponytail: read-modify-write under no lock at all, so two writers racing the same file
// still lose one update — within this process as much as across two. The staging counter
// only keeps them from corrupting each other on the way. Wrap the read and the rename in
// `withLock` from ./lock if a writer ever becomes something faster than a human approving
// a prompt.
export async function writeKey(
  container: string,
  namespace: string,
  key: string,
  value: JsonValue,
): Promise<boolean> {
  const path = join(container, PROJECT_META);
  const document = await readDocument(path);
  if (document === null) return false;

  const existing = asTable(document[namespace]) ?? {};
  const next = { ...document, [namespace]: { ...existing, [key]: value } };

  const staging = `${path}.${process.pid}.${staged++}.tmp`;
  try {
    await writeFile(staging, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(staging, path);
  } catch (error) {
    // Swallowed so a failed cleanup — an unwritable container being the likely reason the
    // write failed at all — cannot replace the error the caller needs.
    await rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }

  return true;
}
