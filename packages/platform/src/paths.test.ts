import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvesInside } from "./paths.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jarvis-paths-"));
}

describe("resolvesInside", () => {
  it("accepts a plain file in the root", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "a.md"), "x");

    expect(await resolvesInside(root, "a.md")).toBe(true);
  });

  it("accepts a file in a subdirectory", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "a.md"), "x");

    expect(await resolvesInside(root, "docs/a.md")).toBe(true);
  });

  it("refuses a path that climbs out with ..", async () => {
    const root = await tempRoot();

    expect(await resolvesInside(root, "../escape.md")).toBe(false);
  });

  // The case ruling P17 exists for: an agent creates files as part of its
  // job, so a symlink pointing at the user's private keys is a realistic
  // artefact, not a hypothetical.
  it("refuses a symlink whose target resolves outside the root", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeFile(join(outside, "secret"), "private key");
    await symlink(join(outside, "secret"), join(root, "link.md"));

    expect(await resolvesInside(root, "link.md")).toBe(false);
  });

  it("accepts a symlink whose target stays inside the root", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "real.md"), "x");
    await symlink(join(root, "real.md"), join(root, "alias.md"));

    expect(await resolvesInside(root, "alias.md")).toBe(true);
  });

  // /tmp is itself a symlink on macOS, so resolving only the child would
  // make every legitimate temp-root case above fail.
  it("resolves the root as well as the target", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "a.md"), "x");

    expect(await resolvesInside(join(root, "."), "a.md")).toBe(true);
  });

  it("refuses a path that does not exist", async () => {
    const root = await tempRoot();

    expect(await resolvesInside(root, "missing.md")).toBe(false);
  });
});
