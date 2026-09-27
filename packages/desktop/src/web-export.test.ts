import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebManifest } from "@jarvis/remote";
import {
  createWebManifestLoader,
  nodeWebExportFs,
  WEB_EXPORT_FILE_BYTES,
  WEB_EXPORT_TOTAL_BYTES,
  webExportDir,
  type WebExportFs,
} from "./web-export.js";

function enoent(): Error {
  return Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
}

/** An in-memory export directory: `files` maps "/"-relative paths to text. */
function fakeFs(files: Record<string, string> | undefined): WebExportFs & {
  listCalls: string[];
  readCalls: { dir: string; name: string; maxBytes: number }[];
} {
  const listCalls: string[] = [];
  const readCalls: { dir: string; name: string; maxBytes: number }[] = [];
  return {
    listCalls,
    readCalls,
    async listFiles(dir) {
      listCalls.push(dir);
      if (files === undefined) throw enoent();
      return Object.keys(files);
    },
    async readFile(dir, name, maxBytes) {
      readCalls.push({ dir, name, maxBytes });
      const text = files?.[name];
      if (dir !== "/export" || text === undefined) throw enoent();
      const bytes = Buffer.from(text);
      return bytes.length > maxBytes ? undefined : bytes;
    },
  };
}

/** Records what it was given and hands back a manifest keyed the same way. */
function fakeBuild() {
  return vi.fn((entries: Iterable<{ path: string; bytes: Buffer }>): WebManifest => {
    const manifest = new Map<string, { bytes: Buffer; type: string; etag: string }>();
    for (const entry of entries) {
      manifest.set(entry.path, { bytes: entry.bytes, type: "x", etag: '"e"' });
    }
    return manifest;
  });
}

function loader(
  fs: WebExportFs,
  build = fakeBuild(),
  limits?: { fileBytes: number; totalBytes: number },
) {
  return {
    build,
    load: createWebManifestLoader({
      dir: () => "/export",
      fs,
      build,
      ...(limits === undefined ? {} : { limits }),
    }),
  };
}

describe("webExportDir", () => {
  it("is resources/web when packaged", () => {
    expect(
      webExportDir({ packaged: true, resourcesPath: "/App/Resources", devDir: "/repo/x" }),
    ).toBe(join("/App/Resources", "web"));
  });

  it("is the repo's own export directory in development", () => {
    expect(
      webExportDir({
        packaged: false,
        resourcesPath: "/ignored",
        devDir: "/repo/packages/desktop/web",
      }),
    ).toBe("/repo/packages/desktop/web");
  });
});

describe("createWebManifestLoader", () => {
  it("builds the manifest from every file, keyed by its URL path", async () => {
    const fs = fakeFs({ "index.html": "<html>", "_expo/static/js/web/app-1a2b.js": "js" });
    const { load, build } = loader(fs);

    const manifest = await load();

    expect([...(manifest?.keys() ?? [])].sort()).toEqual([
      "/_expo/static/js/web/app-1a2b.js",
      "/index.html",
    ]);
    expect(manifest?.get("/index.html")?.bytes.toString()).toBe("<html>");
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("reads the directory once, and every later call gets the same manifest", async () => {
    const fs = fakeFs({ "index.html": "<html>" });
    const { load, build } = loader(fs);

    const [first, second] = await Promise.all([load(), load()]);
    const third = await load();

    expect(first).toBe(second);
    expect(third).toBe(first);
    expect(fs.listCalls).toEqual(["/export"]);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("a missing export directory is undefined (not built), and is looked for again next time", async () => {
    const fs = fakeFs(undefined);
    const { load } = loader(fs);

    expect(await load()).toBeUndefined();
    expect(await load()).toBeUndefined();
    expect(fs.listCalls).toHaveLength(2);
  });

  it("an export with no index.html is not a build", async () => {
    const { load } = loader(fakeFs({ "favicon.ico": "x" }));
    expect(await load()).toBeUndefined();
  });

  it("any other read failure rejects (the bridge logs it and reads not-built), and is not cached", async () => {
    const fs = fakeFs({ "index.html": "<html>" });
    const failing: WebExportFs = {
      listFiles: fs.listFiles,
      readFile: vi
        .fn<WebExportFs["readFile"]>()
        .mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }))
        .mockImplementation(fs.readFile),
    };
    const { load } = loader(failing);

    await expect(load()).rejects.toThrow("EACCES");
    expect((await load())?.has("/index.html")).toBe(true);
  });

  it("refuses a listed path that climbs out of the directory", async () => {
    const { load } = loader(fakeFs({ "index.html": "<html>", "../secret": "x" }));
    await expect(load()).rejects.toThrow("web export");
  });

  it("caps each file at 16 MiB and the whole export at 64 MiB by default", async () => {
    expect(WEB_EXPORT_FILE_BYTES).toBe(16 * 1024 * 1024);
    expect(WEB_EXPORT_TOTAL_BYTES).toBe(64 * 1024 * 1024);
    const fs = fakeFs({ "index.html": "<html>" });
    await loader(fs).load();
    expect(fs.readCalls).toEqual([
      { dir: "/export", name: "index.html", maxBytes: WEB_EXPORT_FILE_BYTES },
    ]);
  });

  it("refuses a file over the per-file cap (not built, logged), and is not cached", async () => {
    const fs = fakeFs({ "index.html": "<html>", "big.js": "0123456789" });
    const { load, build } = loader(fs, fakeBuild(), { fileBytes: 9, totalBytes: 100 });

    await expect(load()).rejects.toThrow("web export: big.js is over the 9-byte file limit");
    await expect(load()).rejects.toThrow("file limit");
    expect(build).not.toHaveBeenCalled();
    expect(fs.listCalls).toHaveLength(2);
  });

  it("refuses an export whose files together pass the total cap", async () => {
    const fs = fakeFs({ "index.html": "123456", "a.js": "123456", "b.js": "123456" });
    const { load, build } = loader(fs, fakeBuild(), { fileBytes: 10, totalBytes: 15 });

    await expect(load()).rejects.toThrow("web export: over the 15-byte total limit");
    expect(build).not.toHaveBeenCalled();
    // Each read asks for no more than what is left of the total.
    expect(fs.readCalls.map((call) => call.maxBytes)).toEqual([10, 9, 3]);
  });

  it("an export exactly at both caps is built", async () => {
    const fs = fakeFs({ "index.html": "12345", "a.js": "12345" });
    const { load } = loader(fs, fakeBuild(), { fileBytes: 5, totalBytes: 10 });
    expect((await load())?.size).toBe(2);
  });

  it("a file the fs hands back larger than asked is still refused", async () => {
    const lying: WebExportFs = {
      listFiles: async () => ["index.html"],
      readFile: async () => Buffer.alloc(20),
    };
    const { load } = loader(lying, fakeBuild(), { fileBytes: 10, totalBytes: 100 });
    await expect(load()).rejects.toThrow("file limit");
  });
});

// The real filesystem implementation, against a throwaway directory.
describe("nodeWebExportFs", () => {
  let base: string;
  let root: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "jarvis-web-export-"));
    root = join(base, "web");
    await mkdir(join(root, "_expo", "static", "js"), { recursive: true });
    await writeFile(join(root, "index.html"), "<html>");
    await writeFile(join(root, "_expo", "static", "js", "entry-1a2b.js"), "js");
    await writeFile(join(base, "outside.txt"), "secret");
    await mkdir(join(base, "outside-dir"));
    await writeFile(join(base, "outside-dir", "x.js"), "secret");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /** Symlinks need a privilege Windows does not grant by default. */
  async function trySymlink(target: string, path: string, type?: "dir" | "file") {
    try {
      await symlink(target, path, type);
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === "EPERM") return false;
      throw error;
    }
  }

  it("lists every regular file, relative to the export root", async () => {
    expect((await nodeWebExportFs.listFiles(root)).sort()).toEqual(
      [join("_expo", "static", "js", "entry-1a2b.js"), "index.html"].sort(),
    );
  });

  it("rejects ENOENT for a missing directory", async () => {
    await expect(nodeWebExportFs.listFiles(join(base, "nope"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("leaves out symlinked files and directories, and never follows them", async () => {
    if (!(await trySymlink(join(base, "outside.txt"), join(root, "link.txt"), "file"))) return;
    await trySymlink(join(base, "outside-dir"), join(root, "linkdir"), "dir");
    expect((await nodeWebExportFs.listFiles(root)).sort()).toEqual(
      [join("_expo", "static", "js", "entry-1a2b.js"), "index.html"].sort(),
    );
  });

  it("refuses an export root that is itself a symlink", async () => {
    if (!(await trySymlink(root, join(base, "web-link"), "dir"))) return;
    await expect(nodeWebExportFs.listFiles(join(base, "web-link"))).rejects.toThrow(
      "not a directory",
    );
  });

  it("reads a regular file", async () => {
    const bytes = await nodeWebExportFs.readFile(root, "index.html", 1024);
    expect(bytes?.toString()).toBe("<html>");
    const nested = await nodeWebExportFs.readFile(
      root,
      join("_expo", "static", "js", "entry-1a2b.js"),
      1024,
    );
    expect(nested?.toString()).toBe("js");
  });

  it("is undefined for a file over maxBytes, and reads one exactly at it", async () => {
    expect(await nodeWebExportFs.readFile(root, "index.html", 5)).toBeUndefined();
    expect((await nodeWebExportFs.readFile(root, "index.html", 6))?.toString()).toBe("<html>");
  });

  it("refuses a symlink swapped in after listing", async () => {
    if (!(await trySymlink(join(base, "outside.txt"), join(root, "late.txt"), "file"))) return;
    await expect(nodeWebExportFs.readFile(root, "late.txt", 1024)).rejects.toThrow(
      "not a regular file",
    );
  });

  it("refuses a path through a symlinked directory", async () => {
    if (!(await trySymlink(join(base, "outside-dir"), join(root, "linkdir"), "dir"))) return;
    await expect(nodeWebExportFs.readFile(root, join("linkdir", "x.js"), 1024)).rejects.toThrow(
      "not a directory",
    );
  });

  it("refuses a directory, and anything else that is not a regular file", async () => {
    await expect(nodeWebExportFs.readFile(root, "_expo", 1024)).rejects.toThrow(
      "not a regular file",
    );
  });

  it.each([
    ["a parent path", join("..", "outside.txt")],
    ["a nested parent path", join("_expo", "..", "..", "outside.txt")],
    ["an empty path", ""],
  ])("refuses %s", async (_label, name) => {
    await expect(nodeWebExportFs.readFile(root, name, 1024)).rejects.toThrow("web export");
  });

  it("refuses an absolute path", async () => {
    await expect(nodeWebExportFs.readFile(root, join(base, "outside.txt"), 1024)).rejects.toThrow(
      "web export",
    );
  });
});
