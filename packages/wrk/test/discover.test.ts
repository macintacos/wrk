/**
 * Repository discovery and orphan recovery, driven against real directories.
 *
 * Every container here is a real one, built by [`./fixtures/repo`](./fixtures/repo) with the
 * real `git` — because the whole of what the scan does is tell a container from the four
 * things that look like one at a glance: a plain directory, an unconverted clone, a checkout
 * *inside* a container, and `.bare` itself. A synthesised `.git`-and-`.bare` shape would pass
 * against a predicate that was wrong about every one of them.
 *
 * The configured search roots arrive through a temp `config.toml` handed to
 * `ConfigSources.globalPath`, the seam `config.ts` opens for exactly this. Nothing here
 * mutates `XDG_CONFIG_HOME`, and nothing reads the machine's real config.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { findContainers, resolveRepo } from "../src/discover";
import { Refusal } from "../src/errors";
import {
  addRunWorktree,
  cleanupFixtures,
  makeContainer,
  makeUnconverted,
  tempDir,
} from "./fixtures/repo";

afterAll(cleanupFixtures);

/**
 * Writes a global config file naming `roots` and `depth`, and answers the sources to read it.
 *
 * Paths go through `JSON.stringify` because a TOML basic string and a JSON string escape the
 * same way, and a temp path is not guaranteed free of a character that needs it.
 */
async function withSearch(
  dir: string,
  roots: readonly string[],
  depth: number,
): Promise<{ globalPath: string }> {
  const globalPath = join(dir, "config.toml");
  const list = roots.map((root) => JSON.stringify(root)).join(", ");
  await writeFile(globalPath, `[search]\nroots = [${list}]\ndepth = ${depth}\n`, "utf8");
  return { globalPath };
}

describe("findContainers", () => {
  test("finds a bare-repo container sitting exactly `depth` levels below a root", async () => {
    const root = tempDir();
    const { container } = makeContainer("main", join(root, "group", "project"));

    expect(await findContainers([root], 2)).toEqual([container]);
  });

  test("ignores a plain directory at the scanned depth", async () => {
    const root = tempDir();
    await mkdir(join(root, "group", "plain"), { recursive: true });
    await writeFile(join(root, "group", "loose-file"), "", "utf8");

    expect(await findContainers([root], 2)).toEqual([]);
  });

  test("ignores an unconverted clone at the scanned depth", async () => {
    const clone = makeUnconverted();

    // `<tmp>/work` — its parent is the root, so the clone itself is the one candidate.
    expect(await findContainers([join(clone, "..")], 1)).toEqual([]);
  });

  test("ignores the checkouts inside a container, and never descends into `.bare`", async () => {
    const root = tempDir();
    makeContainer("main", join(root, "group", "project"));

    // One level past the container: its `main` checkout and its `.bare` are the only leaves.
    expect(await findContainers([root], 3)).toEqual([]);
  });

  test("treats the root itself as the candidate at depth 0", async () => {
    const { container } = makeContainer();

    expect(await findContainers([container], 0)).toEqual([container]);
    expect(await findContainers([tempDir()], 0)).toEqual([]);
  });

  test("skips a root that does not exist rather than raising", async () => {
    const root = tempDir();
    const { container } = makeContainer("main", join(root, "group", "project"));

    expect(await findContainers([join(root, "nowhere"), root], 2)).toEqual([container]);
  });

  test("answers each container once, sorted, when roots overlap", async () => {
    const root = tempDir();
    const first = makeContainer("main", join(root, "group", "alpha")).container;
    const second = makeContainer("main", join(root, "group", "beta")).container;

    expect(await findContainers([root, root, join(root, "group")], 2)).toEqual([first, second]);
  });
});

describe("resolveRepo", () => {
  test("hands back a cwd that is already inside a repository, unchanged", async () => {
    const { container, checkout } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/add-thing");
    // Roots that would answer something else entirely, so a wrong answer is visible rather
    // than coincidentally equal to the right one.
    const sources = await withSearch(tempDir(), [tempDir()], 0);

    expect(await resolveRepo(checkout, sources)).toBe(checkout);
    expect(await resolveRepo(worktree, sources)).toBe(worktree);
    expect(await resolveRepo(container, sources)).toBe(container);
  });

  test("takes the only candidate without opening a picker", async () => {
    const root = tempDir();
    const { container } = makeContainer("main", join(root, "group", "project"));
    const sources = await withSearch(tempDir(), [root], 2);

    // No terminal anywhere in this process, so a picker would raise rather than answer.
    expect(await resolveRepo(tempDir(), sources)).toBe(container);
  });

  test("takes the candidate whose name matches the orphaned worktree's container", async () => {
    const root = tempDir();
    makeContainer("main", join(root, "group", "alpha"));
    const wanted = makeContainer("main", join(root, "group", "beta")).container;
    const sources = await withSearch(tempDir(), [root], 2);

    // Deliberately a path that does **not** exist: this is the case the issue is named for, so
    // the fixture is the removed worktree itself rather than a stand-in that is merely outside a
    // repository. Its parent still names the container it lived in, which is the whole hint.
    const orphan = join(tempDir(), "beta", "EXC-1+add-thing");

    expect(await resolveRepo(orphan, sources)).toBe(wanted);
  });

  test("refuses, naming the configured roots, when the roots hold no container", async () => {
    const root = tempDir();
    const sources = await withSearch(tempDir(), [root], 2);

    const failure = await resolveRepo(tempDir(), sources).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Refusal);
    expect((failure as Refusal).message).toContain(root);
    expect((failure as Refusal).message).toContain("search.roots");
  });

  test("refuses rather than raising the picker's own error when there is no terminal", async () => {
    const root = tempDir();
    makeContainer("main", join(root, "group", "alpha"));
    makeContainer("main", join(root, "group", "beta"));
    const sources = await withSearch(tempDir(), [root], 2);

    const failure = await resolveRepo(tempDir(), sources).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Refusal);
    expect((failure as Refusal).message).toContain("terminal");
  });
});
