import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDocReader } from "./docs.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jarvis-docs-"));
}

describe("DocReader.list", () => {
  it("finds markdown files at the root", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "README.md"), "# hi");

    const outcome = await createDocReader().list(root);

    expect(outcome).toEqual({ ok: true, value: [{ path: "README.md", name: "README.md" }] });
  });

  it("finds markdown in subdirectories, with root-relative paths", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "plan.md"), "x");

    const outcome = await createDocReader().list(root);

    expect(outcome).toEqual({ ok: true, value: [{ path: "docs/plan.md", name: "plan.md" }] });
  });

  it("ignores files that are not markdown", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "a.md"), "x");
    await writeFile(join(root, "b.ts"), "x");
    await writeFile(join(root, "c.png"), "x");

    const outcome = await createDocReader().list(root);

    expect(outcome.ok && outcome.value.map((entry) => entry.path)).toEqual(["a.md"]);
  });

  it("accepts .markdown as well as .md", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "a.markdown"), "x");

    const outcome = await createDocReader().list(root);

    expect(outcome.ok && outcome.value.map((entry) => entry.path)).toEqual(["a.markdown"]);
  });

  // A project's node_modules holds tens of thousands of READMEs. Walking it
  // would make the doc tree useless and the listing slow enough to feel
  // broken.
  it("skips node_modules, .git and build output", async () => {
    const root = await tempRoot();
    for (const dir of ["node_modules", ".git", "dist"]) {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, "README.md"), "x");
    }
    await writeFile(join(root, "keep.md"), "x");

    const outcome = await createDocReader().list(root);

    expect(outcome.ok && outcome.value.map((entry) => entry.path)).toEqual(["keep.md"]);
  });

  it("stops descending past the depth limit", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "a", "b", "c", "d"), { recursive: true });
    await writeFile(join(root, "a", "b", "c", "d", "deep.md"), "x");
    await writeFile(join(root, "a", "shallow.md"), "x");

    const outcome = await createDocReader({ maxDepth: 2 }).list(root);

    expect(outcome.ok && outcome.value.map((entry) => entry.path)).toEqual(["a/shallow.md"]);
  });

  it("sorts entries by path so the tree does not reshuffle between reads", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "b.md"), "x");
    await writeFile(join(root, "a.md"), "x");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "c.md"), "x");

    const outcome = await createDocReader().list(root);

    expect(outcome.ok && outcome.value.map((entry) => entry.path)).toEqual([
      "a.md",
      "b.md",
      "docs/c.md",
    ]);
  });

  it("returns not-found for a root that does not exist", async () => {
    const outcome = await createDocReader().list("/no/such/project");

    expect(outcome).toEqual({
      ok: false,
      error: { code: "not-found", detail: "/no/such/project" },
    });
  });

  it("returns an empty list for a project with no markdown", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "main.ts"), "x");

    expect(await createDocReader().list(root)).toEqual({ ok: true, value: [] });
  });
});

describe("DocReader.read", () => {
  it("reads a file's contents", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "a.md"), "# heading\n");

    expect(await createDocReader().read(root, "a.md")).toEqual({ ok: true, value: "# heading\n" });
  });

  it("reads a file in a subdirectory", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "a.md"), "x");

    expect(await createDocReader().read(root, "docs/a.md")).toEqual({ ok: true, value: "x" });
  });

  it("refuses a path that climbs out of the root", async () => {
    const root = await tempRoot();

    const outcome = await createDocReader().read(root, "../../../etc/passwd");

    expect(outcome).toEqual({
      ok: false,
      error: { code: "outside-root", detail: "../../../etc/passwd" },
    });
  });

  it("refuses an absolute path", async () => {
    const root = await tempRoot();

    const outcome = await createDocReader().read(root, "/etc/passwd");

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe("outside-root");
  });

  // Ruling P17, the case that matters: the file exists and is readable, and
  // must still be refused because of where it points.
  it("refuses a symlink pointing outside the root", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeFile(join(outside, "id_rsa"), "PRIVATE KEY");
    await symlink(join(outside, "id_rsa"), join(root, "notes.md"));

    const outcome = await createDocReader().read(root, "notes.md");

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe("outside-root");
  });

  it("refuses a file larger than the limit", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "big.md"), "x".repeat(200));

    const outcome = await createDocReader({ maxBytes: 100 }).read(root, "big.md");

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe("too-large");
  });

  it("returns not-found for a missing file", async () => {
    const root = await tempRoot();

    const outcome = await createDocReader().read(root, "missing.md");

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe("not-found");
  });

  it("refuses a file that is not markdown", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "secrets.env"), "TOKEN=1");

    const outcome = await createDocReader().read(root, "secrets.env");

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe("unreadable");
  });
});
