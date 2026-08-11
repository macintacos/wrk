/**
 * The `.project-meta.json` accessor, driven against a real filesystem.
 *
 * Nothing is mocked, for `config.test.ts`'s reason: the behaviour under test is almost
 * entirely about what happens to a file this package does not own — absent, truncated,
 * unreadable, or carrying a namespace belonging to some other tool. A stubbed `fs` would
 * let every one of those pass while the real thing threw.
 *
 * Fixtures are written as **literal text** rather than through a serialiser, so a case can
 * express a truncated document at all, and so the write cases can assert on the exact
 * bytes that land — two-space indentation and the trailing newline are the acceptance
 * criteria, and a re-parse would report both as passing whatever the file really holds.
 *
 * Every fixture carries the foreign top-level `search` key that the `.project-meta.json`
 * files on this machine actually hold, so preservation is pinned against the real hazard
 * rather than against a convenient invention.
 */

import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROJECT_META, readConsent, readNamespace, writeKey } from "../src/meta";

/** Runs `body` against a throwaway container, removed afterwards even on failure. */
async function withContainer(body: (container: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "wrk-meta-"));
  const container = join(dir, "container");
  await mkdir(container, { recursive: true });
  try {
    await body(container);
  } finally {
    // Uncaught deliberately: the directory is this case's own `mkdtemp`, so nothing else
    // can be racing the call and hitting the Bun `EFAULT` that `cache.ts` documents.
    await rm(dir, { recursive: true, force: true });
  }
}

/** Writes a container's `.project-meta.json` verbatim. Every fixture goes through this. */
async function writeMeta(container: string, text: string): Promise<void> {
  await writeFile(join(container, PROJECT_META), text, "utf8");
}

/** Reads a container's `.project-meta.json` back as the bytes on disk. */
function readMeta(container: string): Promise<string> {
  return readFile(join(container, PROJECT_META), "utf8");
}

/** The container's entries by name, sorted, so a leftover staging file shows up as one. */
async function entries(container: string): Promise<string[]> {
  return (await readdir(container)).sort();
}

/** The neighbouring tool's top-level namespace, as it appears on disk today. */
const FOREIGN = '"search": { "externalPaths": ["~/GitLocal", "~/.config"] }';

/** The flag the `git` skill documents, and the reason the three states exist. */
const FLAG = "allowDefaultBranchCommits";

describe("readNamespace", () => {
  test("answers the namespace's own table", async () => {
    await withContainer(async (container) => {
      await writeMeta(container, `{ ${FOREIGN}, "git": { "${FLAG}": true } }`);

      expect(await readNamespace(container, "git")).toEqual({ [FLAG]: true });
    });
  });

  test("answers the container's file, not a checkout's", async () => {
    await withContainer(async (container) => {
      // The file is untracked, so git never carries it into a worktree. A checkout-relative
      // resolution would read this copy from the default-branch checkout and find nothing
      // at all from every run worktree.
      await writeMeta(container, `{ "git": { "${FLAG}": true } }`);
      const checkout = join(container, "trunk");
      await mkdir(checkout, { recursive: true });
      await writeMeta(checkout, `{ "git": { "${FLAG}": false } }`);

      expect(await readNamespace(container, "git")).toEqual({ [FLAG]: true });
    });
  });

  test("answers null when the file does not exist", async () => {
    await withContainer(async (container) => {
      expect(await readNamespace(container, "git")).toBeNull();
    });
  });

  test("answers null for a truncated document", async () => {
    await withContainer(async (container) => {
      await writeMeta(container, `{ "git": { "${FLAG}": tr`);

      expect(await readNamespace(container, "git")).toBeNull();
    });
  });

  test("answers null for a JSON array at the root", async () => {
    await withContainer(async (container) => {
      await writeMeta(container, '[{ "git": {} }]');

      expect(await readNamespace(container, "git")).toBeNull();
    });
  });

  test("answers null for a JSON scalar at the root", async () => {
    await withContainer(async (container) => {
      await writeMeta(container, '"git"');

      expect(await readNamespace(container, "git")).toBeNull();
    });
  });

  test("answers null for a file it cannot read", async () => {
    // Root can read a 0o000 file regardless of its mode, so the case is unprovable there.
    if (process.getuid?.() === 0) return;

    await withContainer(async (container) => {
      await writeMeta(container, `{ "git": { "${FLAG}": true } }`);
      await chmod(join(container, PROJECT_META), 0o000);

      expect(await readNamespace(container, "git")).toBeNull();
    });
  });

  test("answers null for a directory where the file should be", async () => {
    await withContainer(async (container) => {
      await mkdir(join(container, PROJECT_META), { recursive: true });

      expect(await readNamespace(container, "git")).toBeNull();
    });
  });

  test("answers null when the namespace is absent", async () => {
    await withContainer(async (container) => {
      await writeMeta(container, `{ ${FOREIGN} }`);

      expect(await readNamespace(container, "git")).toBeNull();
    });
  });

  test("answers null when the namespace is not a table", async () => {
    await withContainer(async (container) => {
      await writeMeta(container, '{ "git": 3, "linear": ["a"], "wrk": null }');

      expect(await readNamespace(container, "git")).toBeNull();
      expect(await readNamespace(container, "linear")).toBeNull();
      expect(await readNamespace(container, "wrk")).toBeNull();
    });
  });
});

describe("readConsent", () => {
  test("answers granted for true", async () => {
    await withContainer(async (container) => {
      await writeMeta(container, `{ "git": { "${FLAG}": true } }`);

      expect(await readConsent(container, "git", FLAG)).toBe("granted");
    });
  });

  test("answers withheld for false", async () => {
    await withContainer(async (container) => {
      await writeMeta(container, `{ "git": { "${FLAG}": false } }`);

      expect(await readConsent(container, "git", FLAG)).toBe("withheld");
    });
  });

  test("answers unset when the key is absent from a namespace that exists", async () => {
    await withContainer(async (container) => {
      await writeMeta(container, '{ "git": { "somethingElse": true } }');

      expect(await readConsent(container, "git", FLAG)).toBe("unset");
    });
  });

  test("answers unset for a value that is not a boolean", async () => {
    await withContainer(async (container) => {
      // Only a real `true` or `false` is a decision. A truthy string is a typo, and
      // reading it as consent would authorize something on the strength of one.
      await writeMeta(container, `{ "git": { "${FLAG}": "true" }, "linear": { "x": 1 } }`);

      expect(await readConsent(container, "git", FLAG)).toBe("unset");
      expect(await readConsent(container, "linear", "x")).toBe("unset");
    });
  });

  test("answers unset when the namespace is absent", async () => {
    await withContainer(async (container) => {
      await writeMeta(container, `{ ${FOREIGN} }`);

      expect(await readConsent(container, "git", FLAG)).toBe("unset");
    });
  });

  test("answers unset when the file is missing or malformed, identically", async () => {
    await withContainer(async (container) => {
      expect(await readConsent(container, "git", FLAG)).toBe("unset");

      await writeMeta(container, `{ "git": { "${FLAG}": tr`);
      expect(await readConsent(container, "git", FLAG)).toBe("unset");
    });
  });
});

describe("writeKey", () => {
  test("creates a missing file with two-space indentation and a trailing newline", async () => {
    await withContainer(async (container) => {
      expect(await writeKey(container, "git", FLAG, true)).toBe(true);

      expect(await readMeta(container)).toBe(`{\n  "git": {\n    "${FLAG}": true\n  }\n}\n`);
    });
  });

  test("preserves a namespace it does not understand", async () => {
    await withContainer(async (container) => {
      await writeMeta(container, `{ ${FOREIGN} }`);

      expect(await writeKey(container, "git", FLAG, true)).toBe(true);

      expect(JSON.parse(await readMeta(container))).toEqual({
        search: { externalPaths: ["~/GitLocal", "~/.config"] },
        git: { [FLAG]: true },
      });
    });
  });

  test("preserves sibling keys inside its own namespace", async () => {
    await withContainer(async (container) => {
      await writeMeta(container, '{ "linear": { "projectName": "wrk" } }');

      expect(await writeKey(container, "linear", "milestone", "v1")).toBe(true);

      // Literal bytes here as well as on the create path: updating an existing file is
      // where the indentation criterion is actually load-bearing, since that is the file
      // another tool already hand-edited.
      expect(await readMeta(container)).toBe(
        '{\n  "linear": {\n    "projectName": "wrk",\n    "milestone": "v1"\n  }\n}\n',
      );
    });
  });

  test("overwrites the key it was given", async () => {
    await withContainer(async (container) => {
      await writeMeta(container, `{ "git": { "${FLAG}": false } }`);

      expect(await writeKey(container, "git", FLAG, true)).toBe(true);

      expect(await readConsent(container, "git", FLAG)).toBe("granted");
    });
  });

  test("replaces a namespace whose value cannot hold keys, and only that namespace", async () => {
    await withContainer(async (container) => {
      await writeMeta(container, `{ ${FOREIGN}, "git": 3 }`);

      expect(await writeKey(container, "git", FLAG, true)).toBe(true);

      expect(JSON.parse(await readMeta(container))).toEqual({
        search: { externalPaths: ["~/GitLocal", "~/.config"] },
        git: { [FLAG]: true },
      });
    });
  });

  test("refuses, byte for byte, when the existing document cannot be preserved", async () => {
    // Overwriting here would destroy whatever the other tools had in it, which is exactly
    // what the criterion about unknown namespaces forbids.
    for (const unusable of [`{ ${FOREIGN}`, '["search"]', '"search"', ""]) {
      await withContainer(async (container) => {
        await writeMeta(container, unusable);

        expect(await writeKey(container, "git", FLAG, true)).toBe(false);

        expect(await readMeta(container)).toBe(unusable);
      });
    }
  });

  test("refuses a file it cannot read, rather than replacing it", async () => {
    // The branch that makes this pass is the one place `readDocument` tells `ENOENT` apart
    // from every other read failure. Collapse the two and this file is silently replaced.
    if (process.getuid?.() === 0) return;

    await withContainer(async (container) => {
      const path = join(container, PROJECT_META);
      await writeMeta(container, `{ ${FOREIGN} }`);
      await chmod(path, 0o000);

      expect(await writeKey(container, "git", FLAG, true)).toBe(false);

      await chmod(path, 0o600);
      expect(await readMeta(container)).toBe(`{ ${FOREIGN} }`);
    });
  });

  test("round-trips through readConsent", async () => {
    await withContainer(async (container) => {
      expect(await readConsent(container, "git", FLAG)).toBe("unset");

      await writeKey(container, "git", FLAG, true);
      expect(await readConsent(container, "git", FLAG)).toBe("granted");

      await writeKey(container, "git", FLAG, false);
      expect(await readConsent(container, "git", FLAG)).toBe("withheld");
    });
  });

  test("leaves no staging file behind", async () => {
    await withContainer(async (container) => {
      await writeKey(container, "git", FLAG, true);

      expect(await entries(container)).toEqual([PROJECT_META]);
    });
  });

  test("two overlapping writes both settle, and publish a whole document", async () => {
    await withContainer(async (container) => {
      // A staging name shared between overlapping writes is the failure this pins: the
      // first rename takes the file, the second rejects `ENOENT` — and the caller of the
      // first has already been told `true` for bytes that are no longer on disk. Which
      // update survives is *not* asserted: one is lost by the read-modify-write, which is
      // the ceiling the `ponytail:` comment in `meta.ts` names.
      const settled = await Promise.all([
        writeKey(container, "git", FLAG, true),
        writeKey(container, "linear", "projectName", "wrk"),
      ]);

      expect(settled).toEqual([true, true]);
      expect(await entries(container)).toEqual([PROJECT_META]);
      expect(JSON.parse(await readMeta(container))).toBeObject();
    });
  });
});
