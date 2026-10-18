import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  PrKey,
  QueuedComment,
  ReviewComment,
  ReviewsStore,
} from "@jarvis/core";

type Cursor = { etag?: string; since: number };

type FileShape = {
  v: 1;
  cursors: Record<PrKey, Cursor>;
  seeded: Record<string, number>;
  comments: Record<string, QueuedComment>;
  manualLinks: Record<PrKey, string | null>;
  paused: string[];
  notified: string[];
};

function emptyFile(): FileShape {
  return {
    v: 1,
    cursors: {},
    seeded: {},
    comments: {},
    manualLinks: {},
    paused: [],
    notified: [],
  };
}

// TODO(controller): switch to `reviewCommentKey` from @jarvis/core once it
// lands in reviews/types.ts — same format, `${prKey}|${kind}|${id}`.
function reviewCommentKey(
  prKey: PrKey,
  kind: ReviewComment["kind"],
  id: string,
): string {
  return `${prKey}|${kind}|${id}`;
}

/** Higher rank wins on upsert, so an existing entry is never downgraded:
 *  `history` may be promoted to `queued` (a requeue), but `queued` is never
 *  pushed back to `history`, and `delivered` / `own` are never touched. */
const RANK: Record<QueuedComment["state"], number> = {
  history: 0,
  queued: 1,
  delivered: 2,
  own: 3,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isCursor(value: unknown): value is Cursor {
  return (
    isRecord(value) &&
    typeof value.since === "number" &&
    (value.etag === undefined || typeof value.etag === "string")
  );
}

const KINDS = new Set(["issue", "review-inline", "review-body"]);
const STATES = new Set(["queued", "delivered", "own", "history"]);

function isComment(value: unknown): value is ReviewComment {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.kind === "string" &&
    KINDS.has(value.kind) &&
    typeof value.author === "string" &&
    typeof value.isBot === "boolean" &&
    typeof value.body === "string" &&
    typeof value.createdAt === "number"
  );
}

function isQueuedComment(value: unknown): value is QueuedComment {
  return (
    isRecord(value) &&
    typeof value.prKey === "string" &&
    typeof value.state === "string" &&
    STATES.has(value.state) &&
    isComment(value.comment) &&
    (value.deliveredTo === undefined ||
      typeof value.deliveredTo === "string") &&
    (value.deliveredAt === undefined || typeof value.deliveredAt === "number")
  );
}

// Every entry is checked, not just the wrapper: one malformed entry is
// treated as the whole file being corrupt (moved aside, start empty).
function isFileShape(value: unknown): value is FileShape {
  if (!isRecord(value) || value.v !== 1) return false;
  return (
    isRecord(value.cursors) &&
    Object.values(value.cursors).every(isCursor) &&
    isRecord(value.seeded) &&
    Object.values(value.seeded).every((at) => typeof at === "number") &&
    isRecord(value.comments) &&
    Object.values(value.comments).every(isQueuedComment) &&
    isRecord(value.manualLinks) &&
    Object.values(value.manualLinks).every(
      (link) => link === null || typeof link === "string",
    ) &&
    isStringArray(value.paused) &&
    isStringArray(value.notified)
  );
}

function byCreatedAt(a: QueuedComment, b: QueuedComment): number {
  return a.comment.createdAt - b.comment.createdAt;
}

/**
 * One JSON file holding the Reviews feature's delivery state, following
 * `createPlanCommentStore`: every call (read or write) runs on a tail queue
 * so concurrent calls read-modify-write the whole file in order, and writes
 * are atomic (temp file in the same directory, then renamed into place).
 *
 * An unreadable or corrupt file is renamed `<file>.bad-<now()>` and the
 * store starts empty, so its bytes are preserved. A missing file (ENOENT)
 * is simply empty, with nothing renamed.
 */
export function createReviewStore(
  filePath: string,
  now: () => number = Date.now,
): ReviewsStore {
  let tail: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  }

  async function moveAside(): Promise<void> {
    try {
      await rename(filePath, `${filePath}.bad-${now()}`);
    } catch {
      // Best effort — start empty even if the rename itself fails.
    }
  }

  async function readAll(): Promise<FileShape> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptyFile();
      await moveAside();
      return emptyFile();
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isFileShape(parsed))
        throw new Error("unrecognised reviews file shape");
      return parsed;
    } catch {
      await moveAside();
      return emptyFile();
    }
  }

  async function writeAll(data: FileShape): Promise<void> {
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });
    const tempPath = join(
      dir,
      `.${basename(filePath)}.tmp-${randomBytes(8).toString("hex")}`,
    );
    try {
      await writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
      await rename(tempPath, filePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  function read<T>(pick: (data: FileShape) => T): Promise<T> {
    return enqueue(async () => pick(await readAll()));
  }

  /** `change` returns false when nothing changed, so no write happens. */
  function modify(change: (data: FileShape) => boolean | void): Promise<void> {
    return enqueue(async () => {
      const data = await readAll();
      if (change(data) === false) return;
      await writeAll(data);
    });
  }

  return {
    cursor(prKey) {
      return read((data) => {
        const cursor = data.cursors[prKey];
        return cursor === undefined ? undefined : { ...cursor };
      });
    },

    setCursor(prKey, cursor) {
      return modify((data) => {
        data.cursors[prKey] =
          cursor.etag === undefined
            ? { since: cursor.since }
            : { etag: cursor.etag, since: cursor.since };
      });
    },

    isFirstRun(repo) {
      return read((data) => data.seeded[repo] === undefined);
    },

    markSeeded(repo, at) {
      return modify((data) => {
        data.seeded[repo] = at;
      });
    },

    upsertComments(prKey, comments, state) {
      return modify((data) => {
        if (comments.length === 0) return false;
        for (const comment of comments) {
          const key = reviewCommentKey(prKey, comment.kind, comment.id);
          const existing = data.comments[key];
          if (existing === undefined || RANK[state] > RANK[existing.state]) {
            data.comments[key] = { prKey, comment, state };
          } else {
            // Keep the state (and delivery fields); refresh the content so an
            // edited comment shows its latest body.
            data.comments[key] = { ...existing, comment };
          }
        }
      });
    },

    markDelivered(ids, paneKey, at) {
      return modify((data) => {
        let changed = false;
        for (const id of ids) {
          const existing = data.comments[id];
          if (existing === undefined || existing.state === "own") continue;
          data.comments[id] = {
            ...existing,
            state: "delivered",
            deliveredTo: paneKey,
            deliveredAt: at,
          };
          changed = true;
        }
        return changed;
      });
    },

    markOwn(prKey, comment) {
      return modify((data) => {
        data.comments[reviewCommentKey(prKey, comment.kind, comment.id)] = {
          prKey,
          comment,
          state: "own",
        };
      });
    },

    listQueued(prKey) {
      return read((data) =>
        Object.values(data.comments)
          .filter(
            (entry) =>
              entry.state === "queued" &&
              (prKey === undefined || entry.prKey === prKey),
          )
          .sort(byCreatedAt),
      );
    },

    thread(prKey) {
      return read((data) =>
        Object.values(data.comments)
          .filter((entry) => entry.prKey === prKey)
          .sort(byCreatedAt),
      );
    },

    manualLinks() {
      return read((data) => new Map(Object.entries(data.manualLinks)));
    },

    setManualLink(prKey, paneKey) {
      return modify((data) => {
        data.manualLinks[prKey] = paneKey;
      });
    },

    paused() {
      return read((data) => new Set(data.paused));
    },

    setPaused(paneKey, paused) {
      return modify((data) => {
        const has = data.paused.includes(paneKey);
        if (has === paused) return false;
        data.paused = paused
          ? [...data.paused, paneKey]
          : data.paused.filter((key) => key !== paneKey);
      });
    },

    wasNotified(key) {
      return read((data) => data.notified.includes(key));
    },

    markNotified(key) {
      return modify((data) => {
        if (data.notified.includes(key)) return false;
        data.notified.push(key);
      });
    },
  };
}
