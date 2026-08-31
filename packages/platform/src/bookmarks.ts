import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Bookmark = { url: string; title: string };

export type BookmarkOutcome<T> = { ok: true; value: T } | { ok: false; detail: string };

export type BookmarkStore = {
  list(project: string): Promise<BookmarkOutcome<Bookmark[]>>;
  /** Adding a URL that is already bookmarked for `project` updates its
   *  title in place rather than creating a second row. Returns the
   *  project's full list after the change, so a caller never needs a
   *  second list() round trip just to redraw. */
  add(project: string, bookmark: Bookmark): Promise<BookmarkOutcome<Bookmark[]>>;
  /** Removing a URL that was never bookmarked is a no-op, not a failure. */
  remove(project: string, url: string): Promise<BookmarkOutcome<Bookmark[]>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One JSON file, keyed by project name, holding each project's bookmark
 * list. Every call is enqueued onto the same tail promise so two calls in
 * flight (a fast double-click on the star) read-modify-write the whole
 * file in order instead of one silently clobbering the other's write.
 */
export function createBookmarkStore(filePath: string): BookmarkStore {
  let tail: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  }

  async function readAll(): Promise<Record<string, Bookmark[]>> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      // No file yet — every project starts with an empty list.
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) ? (parsed as Record<string, Bookmark[]>) : {};
    } catch {
      // A corrupt file is treated as empty rather than crashing the caller;
      // the next successful write replaces it with valid JSON again.
      return {};
    }
  }

  async function writeAll(data: Record<string, Bookmark[]>): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  }

  return {
    list(project) {
      return enqueue(async () => ({ ok: true, value: (await readAll())[project] ?? [] }));
    },

    add(project, bookmark) {
      return enqueue(async () => {
        const all = await readAll();
        const existing = all[project] ?? [];
        const index = existing.findIndex((b) => b.url === bookmark.url);
        const next =
          index === -1
            ? [...existing, bookmark]
            : existing.map((b, i) => (i === index ? bookmark : b));
        all[project] = next;
        try {
          await writeAll(all);
        } catch (error) {
          return { ok: false, detail: errorMessage(error) };
        }
        return { ok: true, value: next };
      });
    },

    remove(project, url) {
      return enqueue(async () => {
        const all = await readAll();
        const next = (all[project] ?? []).filter((b) => b.url !== url);
        all[project] = next;
        try {
          await writeAll(all);
        } catch (error) {
          return { ok: false, detail: errorMessage(error) };
        }
        return { ok: true, value: next };
      });
    },
  };
}
