import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** The essentials grid is a fixed twelve tiles. The cap lives here rather
 *  than only in the renderer so a hand-edited bookmarks.json cannot
 *  produce more essentials than the grid can show. */
export const MAX_PINNED = 12;

export type Bookmark = {
  url: string;
  title: string;
  /** Pinned into the essentials grid. Absent means listed below it. */
  pinned?: boolean;
  /** Position within its group — pinned or listed. Absent sorts last, so
   *  a file written before this change keeps the order it already had. */
  order?: number;
};

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
  /** Pins or unpins one bookmark. Refuses a thirteenth pin with detail
   *  "pin-limit" — a stable token the IPC layer maps to bilingual text,
   *  rather than English prose crossing the platform boundary. Pinning a
   *  url the project does not have is a no-op, like remove. */
  setPinned(project: string, url: string, pinned: boolean): Promise<BookmarkOutcome<Bookmark[]>>;
  /** Rewrites `order` across one group from the url list given, which is
   *  the whole group in its new order. A url the project does not have is
   *  ignored: the renderer's list and the file can disagree if a bookmark
   *  was removed mid-drag. */
  reorder(project: string, urls: string[]): Promise<BookmarkOutcome<Bookmark[]>>;
  /** Retitles one bookmark, keeping its url, pin and order — the whole
   *  point is that a renamed essential does not move out of its tile. The
   *  title is trimmed; an empty or whitespace-only one is refused with
   *  detail "blank-title", because the chip falls back to showing the raw
   *  url when the title is empty and a rename that silently blanks the
   *  label looks like the bookmark broke. Renaming a url the project does
   *  not have is a no-op, like remove. */
  rename(project: string, url: string, title: string): Promise<BookmarkOutcome<Bookmark[]>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Pinned first, then each group by `order`. A bookmark with no `order`
 *  sorts after every bookmark that has one, and ties keep their file
 *  position because Array.prototype.sort is stable — which is what lets a
 *  file written before this change come back in the order it was written. */
function sorted(bookmarks: Bookmark[]): Bookmark[] {
  const rank = (b: Bookmark): number => b.order ?? Number.MAX_SAFE_INTEGER;
  return [...bookmarks].sort((a, b) => {
    if ((a.pinned === true) !== (b.pinned === true)) return a.pinned === true ? -1 : 1;
    return rank(a) - rank(b);
  });
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
      return enqueue(async () => ({ ok: true, value: sorted((await readAll())[project] ?? []) }));
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
        return { ok: true, value: sorted(next) };
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
        return { ok: true, value: sorted(next) };
      });
    },

    setPinned(project, url, pinned) {
      return enqueue(async () => {
        const all = await readAll();
        const existing = all[project] ?? [];
        // Pinning an unknown url is a no-op, like remove — check membership first.
        if (!existing.some((b) => b.url === url)) {
          return { ok: true, value: sorted(existing) };
        }
        if (
          pinned &&
          existing.filter((b) => b.pinned === true && b.url !== url).length >= MAX_PINNED
        ) {
          return { ok: false, detail: "pin-limit" };
        }
        const next = existing.map((b) => (b.url === url ? { ...b, pinned } : b));
        all[project] = next;
        try {
          await writeAll(all);
        } catch (error) {
          return { ok: false, detail: errorMessage(error) };
        }
        return { ok: true, value: sorted(next) };
      });
    },

    rename(project, url, title) {
      return enqueue(async () => {
        const wanted = title.trim();
        if (wanted === "") return { ok: false, detail: "blank-title" };
        const all = await readAll();
        const existing = all[project] ?? [];
        if (!existing.some((b) => b.url === url)) {
          return { ok: true, value: sorted(existing) };
        }
        const next = existing.map((b) => (b.url === url ? { ...b, title: wanted } : b));
        all[project] = next;
        try {
          await writeAll(all);
        } catch (error) {
          return { ok: false, detail: errorMessage(error) };
        }
        return { ok: true, value: sorted(next) };
      });
    },

    reorder(project, urls) {
      return enqueue(async () => {
        const all = await readAll();
        const existing = all[project] ?? [];
        const position = new Map(urls.map((url, index) => [url, index]));
        const next = existing.map((b) =>
          position.has(b.url) ? { ...b, order: position.get(b.url) } : b,
        );
        all[project] = next;
        try {
          await writeAll(all);
        } catch (error) {
          return { ok: false, detail: errorMessage(error) };
        }
        return { ok: true, value: sorted(next) };
      });
    },
  };
}
