/**
 * Invariants of the workspace scaffold itself.
 *
 * Every other issue in the epic builds on the shape asserted here — two scoped
 * packages inside a private Bun workspace, linked by the `workspace:` protocol,
 * type-checked under a strict compiler. These are cheap to break silently while
 * editing a manifest for some other reason, and nothing else notices.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

/** The subset of a `package.json` these tests read. */
interface Manifest {
  name?: string;
  private?: boolean;
  workspaces?: string[];
  dependencies?: Record<string, string>;
}

async function readManifest(...segments: string[]): Promise<Manifest> {
  return (await Bun.file(join(repoRoot, ...segments, "package.json")).json()) as Manifest;
}

describe("workspace layout", () => {
  test("the root manifest is private and declares the packages glob", async () => {
    const root = await readManifest();

    expect(root.private).toBe(true);
    expect(root.workspaces).toContain("packages/*");
  });

  test("both published packages are scoped, since the bare name `wrk` is taken", async () => {
    const cli = await readManifest("packages", "wrk");
    const picker = await readManifest("packages", "picker");

    expect(cli.name).toBe("@macintacos/wrk");
    expect(picker.name).toBe("@macintacos/wrk-picker");
  });

  test("the CLI depends on the picker through the workspace protocol", async () => {
    const cli = await readManifest("packages", "wrk");

    // `bun publish` substitutes this specifier for a real version at pack time.
    // `npm publish` does not, which is why the epic forbids it — a tarball
    // carrying the literal `workspace:*` fails every install with
    // EUNSUPPORTEDPROTOCOL while the publish itself reports success.
    expect(cli.dependencies?.["@macintacos/wrk-picker"]).toStartWith("workspace:");
  });
});

describe("typescript configuration", () => {
  test("the effective compiler options are strict, and compile JSX", () => {
    // tsconfig.json carries comments, which `Bun.file().json()` rejects outright.
    // `tsc --showConfig` is the parser that already understands the format, and it
    // resolves any `extends` chain a later build config introduces.
    const shown = spawnSync(join(repoRoot, "node_modules", ".bin", "tsc"), [
      "--showConfig",
      "-p",
      join(repoRoot, "tsconfig.json"),
    ]);

    expect(shown.status).toBe(0);

    const { compilerOptions } = JSON.parse(shown.stdout.toString()) as {
      compilerOptions: {
        strict?: boolean;
        noUncheckedIndexedAccess?: boolean;
        verbatimModuleSyntax?: boolean;
        jsx?: string;
      };
    };

    expect(compilerOptions.strict).toBe(true);
    expect(compilerOptions.noUncheckedIndexedAccess).toBe(true);
    expect(compilerOptions.verbatimModuleSyntax).toBe(true);

    // The `.tsx` files in `packages/picker` are Ink components carrying no
    // `import React` line. Drop this option and every one of them fails to
    // compile — which is easy to do while editing the compiler options for an
    // unrelated reason, since no `.ts` file in the workspace notices.
    expect(compilerOptions.jsx).toBe("react-jsx");
  });
});
