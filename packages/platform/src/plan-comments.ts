import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { PlanComment } from "@jarvis/core";

const MAX_BODY = 4000;
const MAX_QUOTE = 500;

export type PlanCommentStore = {
  list(path: string): Promise<PlanComment[]>;
  add(input: { path: string; blockId: string; quote: string; body: string }): Promise<PlanComment>;
  update(id: string, body: string): Promise<PlanComment | undefined>;
  remove(id: string): Promise<boolean>;
  markSent(ids: readonly string[]): Promise<void>;
};

type FileShape = { v: 1; comments: PlanComment[] };

function isFileShape(value: unknown): value is FileShape {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.v === 1 && Array.isArray(record.comments);
}

/** Empty or whitespace-only after trimming is refused rather than stored as
 *  a blank comment; over 4000 characters is refused too, so a caller can't
 *  grow the file unboundedly with one add(). */
function normalizeBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_BODY) {
    throw new Error(`comment body must be 1-${MAX_BODY} characters`);
  }
  return trimmed;
}

/** Unlike the body, an over-long quote is truncated rather than rejected —
 *  the quote is copied from the plan text by the caller, not typed, so
 *  there is nothing for a user to fix. */
function normalizeQuote(quote: string): string {
  const trimmed = quote.trim();
  return trimmed.length > MAX_QUOTE ? trimmed.slice(0, MAX_QUOTE) : trimmed;
}

/**
 * One JSON file holding every plan's comments (Task 2's `PlanComment`),
 * following `createBookmarkStore`'s shape: a tail-queued read-modify-write
 * per call (so two calls in flight read/write the whole file in order
 * instead of one clobbering the other), and an atomic write (temp file in
 * the same directory, then renamed into place) so a crash mid-save cannot
 * truncate the file.
 *
 * A corrupt or unrecognised file is never silently discarded: it is
 * renamed `<file>.corrupt-<now()>` beside the fresh empty store that
 * replaces it, so nothing already on disk is lost even once it can no
 * longer be parsed. A genuinely missing file (nothing written yet) is not
 * renamed — there is nothing to preserve.
 */
export function createPlanCommentStore(
  filePath: string,
  now: () => number = Date.now,
  newId: () => string = randomUUID,
): PlanCommentStore {
  let tail: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  }

  async function readAll(): Promise<PlanComment[]> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      // No file yet — every path starts with an empty list.
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isFileShape(parsed)) throw new Error("unrecognised plan-comments file shape");
      return parsed.comments;
    } catch {
      try {
        await rename(filePath, `${filePath}.corrupt-${now()}`);
      } catch {
        // Best effort — proceed with an empty store even if the rename
        // itself fails (e.g. the file vanished between read and rename).
      }
      return [];
    }
  }

  async function writeAll(comments: PlanComment[]): Promise<void> {
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });
    const tempPath = join(dir, `.${basename(filePath)}.tmp-${randomBytes(8).toString("hex")}`);
    const body: FileShape = { v: 1, comments };
    try {
      await writeFile(tempPath, JSON.stringify(body, null, 2), "utf8");
      await rename(tempPath, filePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  return {
    list(path) {
      return enqueue(async () => (await readAll()).filter((comment) => comment.path === path));
    },

    add(input) {
      return enqueue(async () => {
        const body = normalizeBody(input.body);
        const quote = normalizeQuote(input.quote);
        const comment: PlanComment = {
          id: newId(),
          path: input.path,
          blockId: input.blockId,
          quote,
          body,
          createdAt: now(),
        };
        const all = await readAll();
        await writeAll([...all, comment]);
        return comment;
      });
    },

    update(id, body) {
      return enqueue(async () => {
        const normalized = normalizeBody(body);
        const all = await readAll();
        const existing = all.find((comment) => comment.id === id);
        if (existing === undefined) return undefined;
        const updated: PlanComment = { ...existing, body: normalized };
        await writeAll(all.map((comment) => (comment.id === id ? updated : comment)));
        return updated;
      });
    },

    remove(id) {
      return enqueue(async () => {
        const all = await readAll();
        const next = all.filter((comment) => comment.id !== id);
        if (next.length === all.length) return false;
        await writeAll(next);
        return true;
      });
    },

    markSent(ids) {
      return enqueue(async () => {
        const wanted = new Set(ids);
        if (wanted.size === 0) return;
        const all = await readAll();
        const sentAt = now();
        await writeAll(
          all.map((comment) => (wanted.has(comment.id) ? { ...comment, sentAt } : comment)),
        );
      });
    },
  };
}
