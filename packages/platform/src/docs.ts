import { readFile, readdir, stat } from "node:fs/promises";
import { join, posix, sep } from "node:path";
import type { DocEntry } from "@jarvis/core";
import { resolvesInside } from "./paths.js";

export type DocFailureCode = "not-found" | "outside-root" | "too-large" | "unreadable";

export type DocOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: DocFailureCode; detail: string } };

export type DocReader = {
  list(root: string): Promise<DocOutcome<DocEntry[]>>;
  read(root: string, relativePath: string): Promise<DocOutcome<string>>;
};

/** Two megabytes of markdown is roughly a 600-page book. Past that the
 *  document model and the DOM it becomes cost more than the document is
 *  worth, and the window stops responding while both are built. */
export const MAX_DOC_BYTES = 2_000_000;

/** Deep enough for docs/superpowers/plans/x.md; shallow enough that a large
 *  monorepo does not turn the listing into a full-tree walk. */
export const MAX_DOC_DEPTH = 4;

const EXTENSIONS = [".md", ".markdown"];

// Directories that are always machine-generated or vendored. A project's
// node_modules alone holds tens of thousands of READMEs.
const SKIPPED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".cache",
  "vendor",
  "target",
]);

function isMarkdown(name: string): boolean {
  const lower = name.toLowerCase();
  return EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function failure(code: DocFailureCode, detail: string): DocOutcome<never> {
  return { ok: false, error: { code, detail } };
}

/**
 * The Workspace's only filesystem access. Two rules make it safe to reach
 * from the renderer: it is given a project *root* by the main process (the
 * renderer names a project, never a path), and every read is contained by
 * resolvesInside — see ruling P17 and paths.ts.
 */
export function createDocReader(options?: { maxBytes?: number; maxDepth?: number }): DocReader {
  const maxBytes = options?.maxBytes ?? MAX_DOC_BYTES;
  const maxDepth = options?.maxDepth ?? MAX_DOC_DEPTH;

  async function walk(root: string, relativePath: string, depth: number): Promise<DocEntry[]> {
    if (depth > maxDepth) return [];

    let dirents;
    try {
      dirents = await readdir(join(root, relativePath), { withFileTypes: true });
    } catch {
      // An unreadable subdirectory is a fact about that directory, not about
      // the project: the rest of the tree is still worth listing.
      return [];
    }

    const found: DocEntry[] = [];
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) continue;
      // posix.join keeps the separator stable: this path travels over IPC
      // and comes back as a lookup key.
      const childPath = relativePath === "" ? dirent.name : posix.join(relativePath, dirent.name);
      if (dirent.isDirectory()) {
        if (SKIPPED.has(dirent.name)) continue;
        found.push(...(await walk(root, childPath, depth + 1)));
        continue;
      }
      // isFile() is false for a symlink, so a link is never listed. Reading
      // one is refused separately by read(); not listing it keeps the tree
      // honest about what it will actually open.
      if (dirent.isFile() && isMarkdown(dirent.name)) {
        found.push({ path: childPath, name: dirent.name });
      }
    }
    return found;
  }

  return {
    async list(root) {
      try {
        const rootStat = await stat(root);
        if (!rootStat.isDirectory()) return failure("not-found", root);
      } catch {
        return failure("not-found", root);
      }

      const entries = await walk(root, "", 1);
      entries.sort((a, b) => a.path.localeCompare(b.path));
      return { ok: true, value: entries };
    },

    async read(root, relativePath) {
      // Order matters here, and each step answers a different question.
      //
      // The lexical escape check comes first so that a refusal is reported
      // as what it is: "/etc/passwd" is not a markdown file either, and
      // answering "unreadable" would describe the least important thing
      // wrong with it.
      if (
        relativePath.startsWith("/") ||
        relativePath.includes(`..${sep}`) ||
        relativePath.includes("../")
      ) {
        return failure("outside-root", relativePath);
      }
      if (!isMarkdown(relativePath)) return failure("unreadable", relativePath);

      // Existence before containment, because resolvesInside cannot tell the
      // two apart: realpath throws for a file that is missing exactly as it
      // does for one that is not there to resolve, so a missing file checked
      // the other way round would be reported as an escape attempt.
      const full = join(root, relativePath);
      let size: number;
      try {
        const fileStat = await stat(full);
        if (!fileStat.isFile()) return failure("unreadable", relativePath);
        size = fileStat.size;
      } catch {
        return failure("not-found", relativePath);
      }
      if (size > maxBytes) return failure("too-large", relativePath);

      // The real check, and the last thing before any content is read: the
      // file exists and is readable, and must still be refused if it is a
      // symlink whose target lives outside the project (ruling P17).
      if (!(await resolvesInside(root, relativePath))) return failure("outside-root", relativePath);

      try {
        return { ok: true, value: await readFile(full, "utf8") };
      } catch {
        return failure("unreadable", relativePath);
      }
    },
  };
}
