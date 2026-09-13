import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A site that had no icon last week may have one now, and a week is long
 *  enough that retrying costs nothing noticeable. */
export const MISS_RETRY_DAYS = 7;

export type FaviconOutcome<T> = { ok: true; value: T } | { ok: false; detail: string };

/** What the renderer needs to draw one. A data uri rather than a file path
 *  because the renderer is a file:// document and cannot read arbitrary
 *  cache paths without widening its access. */
export type CachedIcon = { dataUri: string };

export type FaviconStore = {
  /** The cached icon for this url's origin. `undefined` covers both "never
   *  seen" and "known to have none" — only shouldFetch tells them apart. */
  get(url: string): Promise<FaviconOutcome<CachedIcon | undefined>>;
  put(url: string, bytes: Uint8Array, contentType: string): Promise<FaviconOutcome<void>>;
  /** Records that this origin has no icon, so it is not refetched on every
   *  render. */
  putMiss(url: string): Promise<FaviconOutcome<void>>;
  /** Whether this origin is worth a network request. */
  shouldFetch(url: string): Promise<FaviconOutcome<boolean>>;
};

type Entry = { dataUri?: string; missedAt?: number };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One icon per origin: every page on a host shares it, and keying by full
 *  url would fetch and store the same bytes once per bookmark. */
function originOf(url: string): string {
  return new URL(url).origin;
}

/** The filename is a hash of the origin, never the origin itself, so no
 *  part of a url ever becomes a path component. */
function fileFor(directory: string, origin: string): string {
  return join(directory, `${createHash("sha256").update(origin).digest("hex").slice(0, 32)}.json`);
}

export function createFaviconStore(directory: string, now: () => number = Date.now): FaviconStore {
  async function read(url: string): Promise<Entry | undefined> {
    const path = fileFor(directory, originOf(url));
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      return typeof parsed === "object" && parsed !== null ? (parsed as Entry) : undefined;
    } catch {
      // No entry yet, or one written by a future version we cannot read.
      // Either way the caller should treat this origin as uncached.
      return undefined;
    }
  }

  async function write(url: string, entry: Entry): Promise<void> {
    await mkdir(directory, { recursive: true });
    await writeFile(fileFor(directory, originOf(url)), JSON.stringify(entry), "utf8");
  }

  return {
    async get(url) {
      try {
        const entry = await read(url);
        return {
          ok: true,
          value: entry?.dataUri === undefined ? undefined : { dataUri: entry.dataUri },
        };
      } catch (error) {
        return { ok: false, detail: errorMessage(error) };
      }
    },

    async put(url, bytes, contentType) {
      try {
        const dataUri = `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
        await write(url, { dataUri });
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, detail: errorMessage(error) };
      }
    },

    async putMiss(url) {
      try {
        await write(url, { missedAt: now() });
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, detail: errorMessage(error) };
      }
    },

    async shouldFetch(url) {
      try {
        const entry = await read(url);
        if (entry?.dataUri !== undefined) return { ok: true, value: false };
        if (entry?.missedAt === undefined) return { ok: true, value: true };
        const age = now() - entry.missedAt;
        return { ok: true, value: age > MISS_RETRY_DAYS * 24 * 60 * 60 * 1000 };
      } catch (error) {
        return { ok: false, detail: errorMessage(error) };
      }
    },
  };
}
