import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Cookie } from "./cookies.js";

// Everything the API tab keeps between runs, per project: request history,
// the cookie jar's contents, and the network settings.
//
// One JSON file for all three, keyed by project, and written through the same
// single-tail queue bookmarks.ts uses — two sends finishing at once must not
// clobber each other's history.

export type HistoryEntry = {
  /** Milliseconds since the epoch, and the entry's identity. */
  at: number;
  name: string;
  method: string;
  url: string;
  status: number;
  timeMs: number;
  bytes: number;
  /** Truncated: history is for finding a call again, not for archiving it. */
  bodyPreview: string;
};

export type ApiSettings = {
  proxyUrl: string;
  verifyCertificate: boolean;
  timeoutMs: number;
};

export type ProjectApiState = {
  history: HistoryEntry[];
  cookies: Cookie[];
  settings: ApiSettings;
};

export type ApiStore = {
  read(project: string): Promise<ProjectApiState>;
  addHistory(project: string, entry: HistoryEntry): Promise<HistoryEntry[]>;
  clearHistory(project: string): Promise<void>;
  saveCookies(project: string, cookies: readonly Cookie[]): Promise<void>;
  saveSettings(project: string, settings: ApiSettings): Promise<ApiSettings>;
};

export const DEFAULT_API_SETTINGS: ApiSettings = {
  proxyUrl: "",
  // Never relaxed by default: switching it off has to be someone's decision.
  verifyCertificate: true,
  timeoutMs: 30_000,
};

/** How many calls to remember per project. Enough to find this morning's
 *  request again; not so many that the file becomes a log. */
const HISTORY_LIMIT = 200;

const BODY_PREVIEW_LIMIT = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyState(): ProjectApiState {
  return { history: [], cookies: [], settings: { ...DEFAULT_API_SETTINGS } };
}

export function truncateBody(body: string): string {
  return body.length <= BODY_PREVIEW_LIMIT ? body : `${body.slice(0, BODY_PREVIEW_LIMIT)}…`;
}

export function createApiStore(filePath: string): ApiStore {
  let tail: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  }

  async function readAll(): Promise<Record<string, ProjectApiState>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
      return isRecord(parsed) ? (parsed as Record<string, ProjectApiState>) : {};
    } catch {
      // No file yet, or a file that is no longer JSON. Either way the right
      // answer is an empty history rather than a failed API tab.
      return {};
    }
  }

  async function writeAll(all: Record<string, ProjectApiState>): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  }

  function stateOf(all: Record<string, ProjectApiState>, project: string): ProjectApiState {
    const existing = all[project];
    if (existing === undefined) return emptyState();
    return {
      history: Array.isArray(existing.history) ? existing.history : [],
      cookies: Array.isArray(existing.cookies) ? existing.cookies : [],
      settings: { ...DEFAULT_API_SETTINGS, ...(isRecord(existing.settings) ? existing.settings : {}) },
    };
  }

  return {
    read: (project) => enqueue(async () => stateOf(await readAll(), project)),

    addHistory: (project, entry) =>
      enqueue(async () => {
        const all = await readAll();
        const state = stateOf(all, project);
        // Newest first: the list is read from the top.
        state.history = [entry, ...state.history].slice(0, HISTORY_LIMIT);
        all[project] = state;
        await writeAll(all);
        return state.history;
      }),

    clearHistory: (project) =>
      enqueue(async () => {
        const all = await readAll();
        const state = stateOf(all, project);
        state.history = [];
        all[project] = state;
        await writeAll(all);
      }),

    saveCookies: (project, cookies) =>
      enqueue(async () => {
        const all = await readAll();
        const state = stateOf(all, project);
        state.cookies = [...cookies];
        all[project] = state;
        await writeAll(all);
      }),

    saveSettings: (project, settings) =>
      enqueue(async () => {
        const all = await readAll();
        const state = stateOf(all, project);
        state.settings = { ...DEFAULT_API_SETTINGS, ...settings };
        all[project] = state;
        await writeAll(all);
        return state.settings;
      }),
  };
}
