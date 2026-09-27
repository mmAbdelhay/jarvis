// Phase 1: where the browser build's static export lives, and how the
// bridge's `loadWebManifest` turns it into the web listener's manifest.
//
// The directory is read once, on first use, and the manifest is kept for
// the app's lifetime. A missing directory (or one with no index.html) is
// "not built": nothing is cached, so an export built later is found on the
// next bridge apply. Every other failure rejects; the bridge logs it and
// reads "not-built" too.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { WebManifest } from "@jarvis/remote";

export type WebExportFs = {
  /** Every regular file under `dir`, as paths relative to it. Rejects with
   *  ENOENT when `dir` does not exist. */
  listFiles(dir: string): Promise<string[]>;
  readFile(path: string): Promise<Buffer>;
};

/** The node implementation. Symlinks and other non-files are left out, so
 *  the export can never serve something outside its own directory. */
export const nodeWebExportFs: WebExportFs = {
  async listFiles(dir) {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
  },
  readFile: (path) => readFile(path),
};

/**
 * Packaged: `<resources>/web` (Task 14's electron-builder extraResources).
 * Development: the repo's own `apps/mobile/dist-web`, passed in by main.ts.
 * The one place Task 14 changes if the layout moves.
 */
export function webExportDir(options: {
  packaged: boolean;
  resourcesPath: string;
  devDir: string;
}): string {
  return options.packaged ? join(options.resourcesPath, "web") : options.devDir;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

/** "a/b.js" (either separator) → "/a/b.js"; refuses anything that climbs out. */
function urlPath(relativePath: string): string {
  const parts = relativePath.split(sep).join("/").split("/");
  if (parts.some((part) => part === ".." || part === "")) {
    throw new Error("web export: a file path leaves the export directory");
  }
  return `/${parts.join("/")}`;
}

export function createWebManifestLoader(deps: {
  dir(): string;
  fs: WebExportFs;
  build(files: Iterable<{ path: string; bytes: Buffer }>): WebManifest;
}): () => Promise<WebManifest | undefined> {
  let loaded: Promise<WebManifest | undefined> | undefined;

  async function read(): Promise<WebManifest | undefined> {
    const dir = deps.dir();
    let names: string[];
    try {
      names = await deps.fs.listFiles(dir);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const paths = names.map((name) => ({ name, path: urlPath(name) }));
    if (!paths.some((entry) => entry.path === "/index.html")) return undefined;
    const files: { path: string; bytes: Buffer }[] = [];
    for (const entry of paths) {
      files.push({ path: entry.path, bytes: await deps.fs.readFile(join(dir, entry.name)) });
    }
    return deps.build(files);
  }

  return () => {
    if (loaded === undefined) {
      const attempt = read();
      loaded = attempt;
      // Only a built export is kept: "not built" and failures are retried.
      attempt.then(
        (manifest) => {
          if (manifest === undefined && loaded === attempt) loaded = undefined;
        },
        () => {
          if (loaded === attempt) loaded = undefined;
        },
      );
    }
    return loaded;
  };
}
