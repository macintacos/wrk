/**
 * The contract conformance suite: proof that `wrk` answers what `agent_exec_worktree.py` answered.
 *
 * Every other test file in this package asserts against the TypeScript implementation's own idea
 * of what it does. This one asserts against [`./golden/contracts.json`](./golden/contracts.json) —
 * the frozen contract written down as data, derived from the Python original — and it does so by
 * driving the **real CLI as a subprocess**, because three of the things under test are properties
 * of the process rather than of any function: the exit status, the stdout/stderr split, and the
 * bare-line shape `--hook` writes.
 *
 * **Semantic equivalence, not byte-for-byte.** Both sides are parsed before comparison, so
 * Python's `json.dumps` indent and separator choices are out of scope by construction — every
 * known consumer parses with `jq`, so reproducing a serializer quirk would buy nothing. What is
 * compared is the key set, the key order, the values and the types. Two parsed JSON values
 * compared with `toEqual` already distinguish `null` from `""` and `1` from `"1"`, and parsed
 * JSON holds no `undefined`, so type equivalence needs no separate mechanism. Key *order* is the
 * one thing `toEqual` does not check, so {@link expectContract} checks it explicitly — and it
 * matters, because `preflight.ts` and `output.ts` both document the wire order as frozen while
 * nothing outside one `KEYS` assertion pins it, and nothing at all pins it through the CLI.
 *
 * **Four divergences from the Python are deliberate and are asserted as expected**, each marked
 * `DIVERGENCE` at the case that pins it. A future reader who "fixes" one has broken a decision,
 * not a bug — see each site for which issue took it. Three are envelope values and live in the
 * golden file; the fourth is a line of `repo convert`'s recipe, so it is pinned here only.
 *
 * A case that merely *comments* a divergence pins nothing: two of these originally sat on
 * fixtures whose code path overwrote the diverging value before it was reported, so the suite
 * stayed green against a `wrk` that answered exactly as the Python did. Each one now runs on the
 * narrower fixture that leaves the difference standing, and says in-line why that fixture and not
 * the obvious one.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunResult } from "../src/proc";
import {
  addRunWorktree,
  cleanupFixtures,
  dirty,
  fixtureGit,
  makeContainer,
  makeUnconverted,
  runCli,
  tempDir,
} from "./fixtures/repo";

afterAll(cleanupFixtures);

/**
 * The golden contracts, read once as text so tokens can be substituted before parsing.
 *
 * Text rather than an `import` of the JSON: the substitution has to happen on the serialized form
 * for the parsed object to come back with the run's real absolute paths in it.
 */
const GOLDEN = readFileSync(join(import.meta.dir, "golden/contracts.json"), "utf8");

/**
 * Absolute paths a case substitutes into its golden before parsing.
 *
 * The token names are a closed union rather than open strings: a typo in one would substitute
 * nothing and fail with a diff showing a literal `<contianer>`, which reads as a contract
 * violation rather than as the typo it is. This makes it a typecheck error instead.
 */
type Paths = Partial<Record<"container" | "checkout" | "worktree" | "clone", string>>;

/**
 * Reads one contract out of the golden file, with this run's paths substituted in.
 *
 * @param name - The contract's key in the golden file.
 * @param paths - Token name (without angle brackets) to absolute path.
 * @returns The parsed contract, keys in the order the file declares them.
 */
function golden(name: string, paths: Paths = {}): Record<string, unknown> {
  let text = GOLDEN;
  for (const [token, value] of Object.entries(paths)) {
    // Escaped through `JSON.stringify` because the substitution happens on JSON *text*: a path
    // holding a quote or a backslash would otherwise produce invalid JSON rather than a mismatch,
    // failing with a parse error that names nothing useful. Unreachable under `mkdtemp` today.
    text = text.replaceAll(`<${token}>`, JSON.stringify(value).slice(1, -1));
  }

  const contracts = JSON.parse(text) as Record<string, Record<string, unknown>>;
  const contract = contracts[name];
  if (contract === undefined) throw new Error(`no golden contract named ${name}`);
  return contract;
}

/**
 * Asserts an actual payload matches its golden in keys, key order, values and types.
 *
 * The key-order assertion is first because it is the one a reader is most likely to think
 * redundant: `toEqual` compares two objects by content and is entirely indifferent to the order
 * their keys were inserted in, so without this line a reordered envelope passes.
 *
 * @param name - The contract's key in the golden file.
 * @param actual - What the CLI printed, already parsed.
 * @param paths - Token substitutions for the golden.
 */
function expectContract(name: string, actual: object, paths: Paths = {}): void {
  const expected = golden(name, paths);
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
  expect(actual).toEqual(expected);
}

/**
 * Asserts a successful run: exit `0`, one JSON document on stdout, matching its golden.
 *
 * `JSON.parse` on the whole of stdout is what pins "stdout is exactly one JSON document" — a
 * second `emit`, or a progress line that escaped onto the machine channel, leaves the stream
 * unparseable and fails here rather than somewhere downstream. That is `output.ts`'s central
 * promise and this is the assertion that holds it.
 *
 * @param result - What the child wrote and how it exited.
 * @param name - The contract's key in the golden file.
 * @param paths - Token substitutions for the golden.
 */
function expectEnvelope(result: RunResult, name: string, paths: Paths = {}): void {
  expect(result.code).toBe(0);
  expectContract(name, JSON.parse(result.stdout), paths);
}

/**
 * Asserts a refusal: exit `1`, nothing on stdout, a `wrk: `-prefixed message on stderr, no stack.
 *
 * The stack-trace check is the point of the last assertion rather than decoration. `reportFailure`
 * maps a `Refusal` to one prefixed line precisely so a user who typed something wrong is not
 * answered with a stack, and the only way to observe that it did is to look at what reached
 * stderr. An `at ` frame line there means the error escaped the handler.
 *
 * @param result - What the child wrote and how it exited.
 * @param message - A substring the refusal's sentence must contain.
 */
function expectRefusal(result: RunResult, message: string): void {
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`wrk: ${message}`);
  expect(result.stderr).not.toMatch(/^\s+at /m);
}

describe("preflight — the three verdicts", () => {
  test("proceed, from a synced default-branch checkout", async () => {
    const { container, checkout } = makeContainer();
    expectEnvelope(
      await runCli(["agent", "preflight", "--issue", "EXC-1"], checkout),
      "preflight.proceed",
      {
        container,
        checkout,
      },
    );
  });

  test("resumed, from this issue's own run worktree", async () => {
    const { container } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-1/thing");
    expectEnvelope(
      await runCli(["agent", "preflight", "--issue", "EXC-1"], worktree),
      "preflight.resumed",
      { worktree },
    );
  });

  test("blocked exits 0, because callers branch on the payload and never on the status", async () => {
    const { container } = makeContainer();
    const result = await runCli(["agent", "preflight", "--issue", "EXC-1"], container);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: "blocked" });
  });
});

describe("preflight — the four block reasons", () => {
  test("container-cwd, run from the container rather than a checkout in it", async () => {
    const { container } = makeContainer();
    // DIVERGENCE 1 (EXC-997): current_branch is null where the Python reports "". The empty
    // string was a consequence of a non-optional dataclass field, not a meaning.
    expectEnvelope(
      await runCli(["agent", "preflight", "--issue", "EXC-1"], container),
      "preflight.blocked.container-cwd",
      { container },
    );
  });

  test("unconverted-repo, and it is the only reason carrying conversion_reference", async () => {
    const clone = makeUnconverted();
    expectEnvelope(
      await runCli(["agent", "preflight", "--issue", "EXC-1"], clone),
      "preflight.blocked.unconverted-repo",
      { clone },
    );
  });

  test("unrelated-worktree, run from a worktree belonging to different work", async () => {
    const { container } = makeContainer();
    const worktree = addRunWorktree(container, "EXC-2/other");
    expectEnvelope(
      await runCli(["agent", "preflight", "--issue", "EXC-1"], worktree),
      "preflight.blocked.unrelated-worktree",
      { worktree },
    );
  });

  test("dirty-checkout, on a tracked modification", async () => {
    const { container, checkout } = makeContainer();
    dirty(checkout);
    expectEnvelope(
      await runCli(["agent", "preflight", "--issue", "EXC-1"], checkout),
      "preflight.blocked.dirty-checkout",
      { container, checkout },
    );
  });

  test("an untracked file is not dirty — the check excludes them deliberately", async () => {
    const { container, checkout } = makeContainer();
    writeFileSync(join(checkout, "scratch.txt"), "not tracked\n");
    expectEnvelope(
      await runCli(["agent", "preflight", "--issue", "EXC-1"], checkout),
      "preflight.proceed",
      { container, checkout },
    );
  });
});

describe("preflight — the stacked path", () => {
  test("--base is reported back and the sync is skipped", async () => {
    const { container, checkout } = makeContainer();
    expectEnvelope(
      await runCli(["agent", "preflight", "--issue", "EXC-1", "--base", "EXC-0/parent"], checkout),
      "preflight.proceed-base",
      { container, checkout },
    );
  });

  test("an explicitly empty --base is reported back rather than replaced", async () => {
    const { container, checkout } = makeContainer();
    // DIVERGENCE 4 (EXC-997): Python's `base or default_branch` silently substitutes the default
    // branch here; wrk's `??` is exact and hands the empty string back, because a caller that
    // passed one has a bug this should not hide. Observable in the envelope, so this is a
    // divergence rather than the internal difference preflight.ts's header files it as.
    expectEnvelope(
      await runCli(["agent", "preflight", "--issue", "EXC-1", "--base", ""], checkout),
      "preflight.proceed-base-empty",
      { container, checkout },
    );
  });
});

describe("preflight — a detached HEAD", () => {
  test("reports null, never the literal HEAD", async () => {
    const { container, checkout } = makeContainer();
    fixtureGit(["checkout", "-q", "--detach"], checkout);
    // DIVERGENCE 2 (EXC-997): Python reports the literal "HEAD", which is not a branch a caller
    // can act on. `--base` is what makes the difference observable at all: it skips the sync, so
    // the detached HEAD survives to be reported. On the syncing path the switch lands first and
    // the envelope names the default branch, which is why that case cannot pin this one.
    expectEnvelope(
      await runCli(["agent", "preflight", "--issue", "EXC-1", "--base", "EXC-0/parent"], checkout),
      "preflight.proceed-base-detached",
      { container, checkout },
    );
  });
});

describe("preflight — EXC-997's internal differences are behaviour-preserving", () => {
  test("the post-sync branch, assigned rather than re-read, matches what a re-read gives", async () => {
    const { container, checkout } = makeContainer();
    fixtureGit(["checkout", "-q", "--detach"], checkout);
    expectEnvelope(
      await runCli(["agent", "preflight", "--issue", "EXC-1"], checkout),
      "preflight.proceed-detached",
      { container, checkout },
    );
    // Re-read from git rather than taken from the envelope. `preflight` reports the branch it
    // *assigned* instead of one it read back, so comparing the envelope against itself would pass
    // whether or not the switch ever happened — this line is the only thing that observes it.
    expect(fixtureGit(["branch", "--show-current"], checkout)).toBe("main");
  });

  test("the switch decision, passed in rather than re-read, actually switches", async () => {
    const { container, checkout } = makeContainer();
    fixtureGit(["checkout", "-q", "-b", "side"], checkout);
    // Starting parked on another branch takes the branch of the switch decision that the
    // already-on-it case does not. The envelope must be indistinguishable from `proceed`.
    expectEnvelope(
      await runCli(["agent", "preflight", "--issue", "EXC-1"], checkout),
      "preflight.proceed",
      { container, checkout },
    );
    // Same reason as above, and it matters more here: a `preflight` that skipped the switch would
    // leave the checkout on `side` while telling the caller it is on `main`, and the caller would
    // then seed a worktree from the wrong branch. The envelope alone cannot catch that.
    expect(fixtureGit(["branch", "--show-current"], checkout)).toBe("main");
  });
});

describe("create", () => {
  test("the envelope carries worktree_path and branch, in that order", async () => {
    const { container, checkout } = makeContainer();
    expectEnvelope(
      await runCli(["agent", "create", "--branch", "EXC-1/thing"], checkout),
      "create.envelope",
      { worktree: join(container, "EXC-1+thing") },
    );
  });

  test("--hook prints the bare path and no JSON, because its consumer is a cd", async () => {
    const { container, checkout } = makeContainer();
    const result = await runCli(["agent", "create", "--branch", "EXC-1/thing", "--hook"], checkout);

    expect(result.code).toBe(0);
    // Exactly the path and a newline. The editor enters whatever the last non-empty stdout line
    // names, so an envelope here would be a directory that cannot be entered rather than a
    // stricter answer — and this equality is what rules one out.
    expect(result.stdout).toBe(`${join(container, "EXC-1+thing")}\n`);
  });

  test("--hook writes nothing to stdout when it fails, so the cd has nothing to enter", async () => {
    const clone = makeUnconverted();
    const result = await runCli(["agent", "create", "--branch", "EXC-1/thing", "--hook"], clone);
    expectRefusal(result, "not a bare-repo container");
  });

  test("an unconverted repository is a refusal, not a verdict", async () => {
    const clone = makeUnconverted();
    expectRefusal(
      await runCli(["agent", "create", "--branch", "EXC-1/thing"], clone),
      "not a bare-repo container",
    );
  });
});

describe("repo convert", () => {
  test("the recipe names the preflight that refused, not the Python script", async () => {
    const clone = makeUnconverted();
    const result = await runCli(["repo", "convert", "--json"], clone);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as { recipe: string };
    expect(Object.keys(payload)).toEqual(["container", "remoteUrl", "defaultBranch", "recipe"]);
    // DIVERGENCE 3 (EXC-1002): the recipe points the reader back at whichever preflight sent them
    // here rather than hardcoding the Python script's name, because two agent trees spell that
    // invocation differently. Asserted by substring rather than as a golden: the recipe is a
    // multi-kilobyte shell script for a human, and pinning it whole would be the byte-for-byte
    // comparison this suite's constraint rules out.
    expect(payload.recipe).toContain("re-run the preflight that refused");
    expect(payload.recipe).not.toContain("agent_exec_worktree");
  });
});

describe("the exit rules", () => {
  test("a failed subprocess exits with that command's own status, not a flattened 1", async () => {
    // The third and least obvious of output.ts's rules. A cwd in no repository at all is git's own
    // 128 travelling out through CommandFailed — a caller error rather than a verdict, so no
    // envelope is written and the status is the child's.
    const result = await runCli(["agent", "preflight", "--issue", "EXC-1"], tempDir());
    expect(result.code).toBe(128);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toMatch(/^\s+at /m);
  });

  test("a verdict writes nothing to stderr, so the human channel stays empty on success", async () => {
    const { checkout } = makeContainer();
    // The other half of the split: expectEnvelope proves the answer reached stdout, and this
    // proves nothing leaked the other way. `create` is excluded on purpose — provisioning writes
    // its progress to stderr legitimately.
    expect((await runCli(["agent", "preflight", "--issue", "EXC-1"], checkout)).stderr).toBe("");
  });
});

describe("repo-setup — both refusals", () => {
  test("inside a repository, which is checked first because it is the applicable advice", async () => {
    const { checkout } = makeContainer();
    expectRefusal(
      await runCli(["agent", "repo-setup", "https://example.invalid/x.git"], checkout),
      `${checkout} is already inside a git repository`,
    );
  });

  test("a non-empty directory", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "occupied.txt"), "something\n");
    expectRefusal(
      await runCli(["agent", "repo-setup", "https://example.invalid/x.git"], dir),
      `${dir} is not empty`,
    );
  });
});
