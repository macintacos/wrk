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

import { frameLines, KEY, runInPty } from "../../picker/test/fixtures/pty";
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

/** The probe the terminal cases run — see [`./fixtures/discover-probe`](./fixtures/discover-probe). */
const probe = join(import.meta.dir, "fixtures/discover-probe.ts");

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

/**
 * Recovery driven against a real terminal, which is the only place the picker path exists.
 *
 * Everything above runs in this process, where there is no TTY and therefore no picker — so
 * the three outcomes a user actually sees are unreachable from it. These cases run the real
 * recovery as a child process attached to a real pty, in a real directory that is in no
 * repository, against real containers, and read the answer off a redirected stdout while the
 * frames it was chosen from stay on the terminal.
 */
describe("resolveRepo in a terminal", () => {
  /**
   * Viewport width, wide enough that a fixture's path does not squeeze the name beside it.
   *
   * `mkdtemp` under macOS's `$TMPDIR` produces ~90-character paths, and a column is sized to
   * its widest cell, so at the usual 80 columns Ink shrinks *both* columns and the container
   * names these cases wait on render as `alp…`. A real root — `~/GitLocal/Play` — is a third
   * of that and never provokes it, so this is the fixture being pathological rather than the
   * layout being wrong, and widening the terminal is the honest fix.
   */
  const WIDE = 140;

  /** Where the probe's stdout is sent, so the pty capture holds only what was drawn. */
  function stdoutPath(purpose: string): string {
    return join(tempDir(), `EXC-1019-${purpose}-stdout.txt`);
  }

  /**
   * A shell script that runs the probe from `cwd` against `config`, with stdout redirected.
   *
   * The git environment variables are shed first, for the reason `fixtures/repo.ts` sheds
   * them: this suite runs under the repository's own pre-push hook, which exports `GIT_DIR`
   * to every child — under which the probe's cwd would resolve to *this* repository and every
   * case would find itself comfortably inside one.
   */
  function scenario(cwd: string, config: string, stdout: string): string {
    return [
      "unset $(git rev-parse --local-env-vars)",
      `cd "${cwd}"`,
      `PROBE_CONFIG="${config}" "${process.execPath}" "${probe}" > "${stdout}"`,
    ].join("\n");
  }

  /** Three real containers under one root, and the config that points a scan at them. */
  async function threeContainers(): Promise<{ root: string; config: string; beta: string }> {
    const root = tempDir();
    for (const name of ["alpha", "gamma"]) makeContainer("main", join(root, "group", name));
    const beta = makeContainer("main", join(root, "group", "beta")).container;

    return { root, config: (await withSearch(tempDir(), [root], 2)).globalPath, beta };
  }

  test("lists every container, and Enter on a row prints that container's path alone", async () => {
    const { config, beta } = await threeContainers();
    const stdout = stdoutPath("chosen");
    let frame: string[] = [];

    const run = await runInPty(scenario(tempDir(), config, stdout), {
      rows: 24,
      cols: WIDE,
      drive: async (pty) => {
        await pty.waitFor("alpha");
        // The keystroke handler attaches in an effect that runs around the first commit, so a
        // key sent the instant the frame appears can land in the gap and be dropped.
        await Bun.sleep(150);
        frame = frameLines(pty.capture());
        // Sorted, so the second row is `beta` — chosen by moving rather than by typing, since
        // a fuzzy query would also match the temp path every row shares.
        pty.write(KEY.down);
        await Bun.sleep(100);
        pty.write(KEY.enter);
      },
    });

    expect(frame[0]).toContain("no repository here, pick one");
    expect(frame.join("\n")).toContain("alpha");
    expect(frame.join("\n")).toContain("beta");
    expect(frame.join("\n")).toContain("gamma");
    expect(run.exitCode).toBe(0);
    expect(await Bun.file(stdout).text()).toBe(`${beta}\n`);
  });

  test("writes nothing and exits 130 when the picker is dismissed", async () => {
    const { config } = await threeContainers();
    const stdout = stdoutPath("dismissed");

    const run = await runInPty(scenario(tempDir(), config, stdout), {
      rows: 24,
      cols: WIDE,
      drive: async (pty) => {
        await pty.waitFor("alpha");
        await Bun.sleep(150);
        pty.write(KEY.escape);
      },
    });

    expect(run.exitCode).toBe(130);
    expect(await Bun.file(stdout).text()).toBe("");
    // Nothing on the human channel either: someone who just pressed escape knows why.
    expect(frameLines(run.capture).join("\n")).not.toContain("wrk: ");
  });

  test("prints one prefixed line and exits 1 when the roots hold no container", async () => {
    const root = tempDir();
    const { globalPath } = await withSearch(tempDir(), [root], 2);
    const stdout = stdoutPath("empty");

    const run = await runInPty(scenario(tempDir(), globalPath, stdout), { rows: 24, cols: WIDE });

    expect(run.exitCode).toBe(1);
    expect(await Bun.file(stdout).text()).toBe("");
    expect(run.capture).toContain(`wrk: no repository containers found under ${root}`);
    // A stack trace is the one thing the acceptance criteria name, so it is asserted against
    // rather than merely absent from the message that was checked above.
    expect(run.capture).not.toContain("    at ");
  });
});
