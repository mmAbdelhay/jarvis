import { describe, expect, it, vi } from "vitest";
import type { WebManifest } from "@jarvis/remote";
import { createWebManifestLoader, webExportDir, type WebExportFs } from "./web-export.js";

function enoent(): Error {
  return Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
}

/** An in-memory export directory: `files` maps "/"-relative paths to text. */
function fakeFs(files: Record<string, string> | undefined): WebExportFs & {
  listCalls: string[];
} {
  const listCalls: string[] = [];
  return {
    listCalls,
    async listFiles(dir) {
      listCalls.push(dir);
      if (files === undefined) throw enoent();
      return Object.keys(files);
    },
    async readFile(path) {
      const key = Object.keys(files ?? {}).find((name) => path === `/export/${name}`);
      if (key === undefined) throw enoent();
      return Buffer.from(files?.[key] ?? "");
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

function loader(fs: WebExportFs, build = fakeBuild()) {
  return {
    build,
    load: createWebManifestLoader({ dir: () => "/export", fs, build }),
  };
}

describe("webExportDir", () => {
  it("is resources/web when packaged", () => {
    expect(
      webExportDir({ packaged: true, resourcesPath: "/App/Resources", devDir: "/repo/x" }),
    ).toBe("/App/Resources/web");
  });

  it("is the repo's own export directory in development", () => {
    expect(
      webExportDir({
        packaged: false,
        resourcesPath: "/ignored",
        devDir: "/repo/apps/mobile/dist-web",
      }),
    ).toBe("/repo/apps/mobile/dist-web");
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
});
