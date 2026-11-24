// Tabs shown in a window of their own.
//
// The state is the desktop host's, not the core's: a Map of tab id to window.
// The core never learns a tab is popped — its tab state, its shells and its
// phone protocol are untouched — which is also why a renderer reload of the
// main window cannot lose a pop-out: the main renderer asks `popout:list`
// again when it starts.
//
// Two shapes of tab:
//   - a hosted page (web, editor, database, cluster, chat): its existing
//     WebContentsView is moved into the window (view-reconciler.ts's popOut),
//     sized to the window's content box, and moved back before the window
//     goes. The view is never destroyed by a move.
//   - a terminal: the window loads renderer/popout.html, which draws only
//     that tab. The main window's panes for it are disposed while it is
//     popped (disposing kills no shell) and rebuilt from the backlog on
//     return. The split layout and any unsent command-editor text are
//     renderer-only state, so they are handed over explicitly in both
//     directions — asked for, and waited on, before anything moves. If the
//     renderer being asked does not answer in time, nothing moves (opening)
//     or the last reported state is used (returning): text typed in a pane
//     is never dropped by a move that could have waited for it.
//
// No electron import here (the windows and views are injected), so the state
// machine is tested with fakes.
import type { TabId, TabKind, WorkspaceState, WorkspaceTab } from "@jarvis/core";
import type { Rect, ViewTarget } from "./browser-host.js";
import { parsePopoutState, plainTerminalState, type PopoutTerminalState } from "./popout-state.js";

/** Hosted pages, which move their view, and the terminal, which has a
 *  renderer of its own in the window. The API client keeps its whole
 *  request in one renderer-global editor and Docker its poll and log
 *  follower: neither has a safe way to move yet, so neither is offered. */
const PAGE_KINDS: ReadonlySet<string> = new Set(["web", "editor", "database", "cluster", "chat"]);

export function canPopOut(kind: string): kind is TabKind {
  return PAGE_KINDS.has(kind) || kind === "terminal";
}

/** How long a renderer has to hand its tab's state over. */
export const POPOUT_HANDOVER_MS = 2000;
/** How long a suspended tab has to wake before the pop-out is given up. */
export const POPOUT_RESUME_MS = 15_000;

const DEFAULT_SIZE = { width: 1000, height: 700 };
const MIN_SIZE = { width: 320, height: 240 };

/** A window size that fits the display's work area, defaulting when there is
 *  none to remember. */
export function clampPopoutSize(
  size: { width: number; height: number } | undefined,
  area: { width: number; height: number },
): { width: number; height: number } {
  const pick = (value: number | undefined, fallback: number, max: number, min: number): number => {
    const wanted = typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return Math.max(Math.min(min, max), Math.min(Math.round(wanted), max));
  };
  return {
    width: pick(size?.width, DEFAULT_SIZE.width, area.width, MIN_SIZE.width),
    height: pick(size?.height, DEFAULT_SIZE.height, area.height, MIN_SIZE.height),
  };
}

export type PopoutSpec = {
  tabId: TabId;
  kind: TabKind;
  title: string;
  size: { width: number; height: number } | undefined;
};

export type PopoutHandlers = {
  onResize(size: { width: number; height: number }): void;
  /** The user closed the window. Nothing is closed until the host says so. */
  onCloseRequested(): void;
  /** The window is gone (destroyed from outside). */
  onClosed(): void;
  /** The window's own renderer died. */
  onCrashed(): void;
  onFocusChanged(): void;
};

export type PopoutWindow = {
  /** The window's own webContents id — whose IPC call it is. */
  readonly contentsId: number;
  /** What views are moved into. */
  readonly target: ViewTarget;
  focus(): void;
  isFocused(): boolean;
  /** Visible and not minimised. */
  isAwake(): boolean;
  setTitle(title: string): void;
  contentSize(): { width: number; height: number };
  /** To this window's renderer, through the broadcaster's sink. */
  send(channel: string, payload: unknown): void;
  destroy(): void;
};

export type PopoutDeps = {
  workspace: {
    state(): WorkspaceState;
    onChange(listener: (state: WorkspaceState) => void): () => void;
  };
  views: {
    popOut(id: TabId, target: ViewTarget, bounds: Rect): boolean;
    popIn(id: TabId): void;
    setPoppedBounds(id: TabId, bounds: Rect): void;
    isPopped(id: TabId): boolean;
  };
  createWindow(spec: PopoutSpec, handlers: PopoutHandlers): PopoutWindow;
  /** Wakes a suspended tab (activating it). */
  resume(id: TabId): Promise<void>;
  /** A push to the main window's renderer. */
  mainSend(channel: string, payload: unknown): void;
  schedule(fn: () => void, ms: number): () => void;
  /** A category token, never content. */
  log(token: string): void;
  /** The focus or the set of windows changed. */
  onFocusChanged?(): void;
  /** False once the main window is destroyed: nothing is moved into it or
   *  pushed to it then. Absent means alive. */
  mainAlive?(): boolean;
};

export type OpenResult =
  | { ok: true; already: boolean }
  | { ok: false; reason: "invalid" | "unsupported" | "busy" | "failed" };

type PopoutRecord = {
  tabId: TabId;
  kind: TabKind;
  window: PopoutWindow;
  /** The last layout and drafts known: handed over at open, reported since. */
  state: PopoutTerminalState | undefined;
  returning: boolean;
};

export type Popouts = {
  open(tabId: unknown): Promise<OpenResult>;
  returnTab(tabId: unknown, askRenderer?: boolean): Promise<boolean>;
  focus(tabId: unknown, paneKey?: unknown): boolean;
  /** Popped tab ids, in the order they were popped. */
  list(): string[];
  onChanged(listener: (ids: string[]) => void): () => void;
  /** The tab behind a pop-out's webContents, or undefined for anything else. */
  tabOf(contentsId: number): string | undefined;
  isPopped(tabId: string): boolean;
  canPopOut(tabId: string): boolean;
  /** `popout:ready`: what a terminal pop-out starts from. */
  ready(contentsId: number): { tabId: string; state?: PopoutTerminalState } | undefined;
  /** `popout:state`: the pop-out's latest layout and drafts. */
  reportState(contentsId: number, state: unknown): void;
  /** `popout:handedOver`: the answer to a `popout:handover` push, from the
   *  main window ("main") or a pop-out (its contents id). */
  provideState(from: "main" | number, tabId: unknown, state: unknown): void;
  /** What a returned terminal tab carried back; handed over once. */
  takeReturned(tabId: string): PopoutTerminalState | undefined;
  /** Quit, a mode switch, the main window going: every page back in the main
   *  window, every terminal's last state kept, the windows destroyed, one
   *  announcement. Synchronous; asks no renderer. */
  closeAll(): void;
  /** Returns every pop-out, asking each terminal's renderer for its state
   *  first (a mode switch, before the main renderer reloads). */
  returnAll(): Promise<void>;
  anyFocused(): boolean;
  anyAwake(): boolean;
  focusedContentsId(): number | undefined;
  /** Every pop-out's webContents id. */
  contentsIds(): number[];
};

const tabLabel = (tab: WorkspaceTab): string =>
  (tab.customTitle ?? (tab.title === "" ? tab.url : tab.title)).slice(0, 200);

export function createPopouts(deps: PopoutDeps): Popouts {
  const records = new Map<TabId, PopoutRecord>();
  const opening = new Set<TabId>();
  const returned = new Map<TabId, PopoutTerminalState>();
  const listeners = new Set<(ids: string[]) => void>();
  const pending = new Map<
    TabId,
    { from: "main" | number; resolve(state: PopoutTerminalState | undefined): void; cancel(): void }
  >();
  let lastSize: { width: number; height: number } | undefined;
  /** Bumped by closeAll: an open that began before it must not finish. */
  let generation = 0;

  const log = (token: string): void => {
    try {
      deps.log(`popout: ${token}`);
    } catch {
      // A failing logger changes nothing.
    }
  };
  const mainAlive = (): boolean => deps.mainAlive?.() ?? true;
  const ids = (): string[] => [...records.keys()];
  const announce = (): void => {
    const list = ids();
    try {
      if (mainAlive()) deps.mainSend("popout:changed", list);
    } catch {
      // The main window is going; nothing there to tell.
    }
    for (const listener of [...listeners]) listener(list);
    deps.onFocusChanged?.();
  };
  const tabOfId = (id: string): WorkspaceTab | undefined =>
    deps.workspace.state().tabs.find((tab) => tab.id === id);
  const bounds = (size: { width: number; height: number }): Rect => ({
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
  });

  /** Asks a renderer for a terminal tab's state and waits for it. */
  function requestState(
    tabId: TabId,
    from: "main" | number,
  ): Promise<PopoutTerminalState | undefined> {
    return new Promise((resolve) => {
      const done = (state: PopoutTerminalState | undefined): void => {
        pending.delete(tabId);
        cancel();
        resolve(state);
      };
      const cancel = deps.schedule(() => done(undefined), POPOUT_HANDOVER_MS);
      pending.set(tabId, { from, resolve: done, cancel });
      if (from === "main") deps.mainSend("popout:handover", tabId);
      else records.get(tabId)?.window.send("popout:handover", tabId);
    });
  }

  function waitForWake(tabId: TabId): Promise<boolean> {
    return new Promise((resolve) => {
      let stop = (): void => {};
      let cancel = (): void => {};
      const settle = (ok: boolean): void => {
        stop();
        cancel();
        resolve(ok);
      };
      stop = deps.workspace.onChange((state) => {
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        if (tab === undefined) settle(false);
        else if (!tab.suspended) settle(true);
      });
      cancel = deps.schedule(() => settle(false), POPOUT_RESUME_MS);
      deps.resume(tabId).catch(() => settle(false));
    });
  }

  function safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // A window or view already gone.
    }
  }

  function dropRecord(record: PopoutRecord): void {
    records.delete(record.tabId);
    const waiting = pending.get(record.tabId);
    if (waiting !== undefined && waiting.from !== "main") waiting.resolve(undefined);
  }

  async function open(tabId: unknown): Promise<OpenResult> {
    if (typeof tabId !== "string") return { ok: false, reason: "invalid" };
    const tab = tabOfId(tabId);
    if (tab === undefined) return { ok: false, reason: "invalid" };
    if (!canPopOut(tab.kind)) return { ok: false, reason: "unsupported" };
    const existing = records.get(tabId);
    if (existing !== undefined) {
      existing.window.focus();
      return { ok: true, already: true };
    }
    if (opening.has(tabId)) return { ok: false, reason: "busy" };
    opening.add(tabId);
    const started = generation;
    const cancelled = (): boolean => started !== generation;
    let created: PopoutWindow | undefined;
    try {
      const isTerminal = tab.kind === "terminal";
      let state: PopoutTerminalState | undefined;
      if (isTerminal) {
        // Before anything moves: the layout and the unsent text live in the
        // main renderer, which disposes its panes only once the pop-out is
        // announced. No answer means no move.
        state = await requestState(tabId, "main");
        if (state === undefined) {
          log("handover-failed");
          return { ok: false, reason: "failed" };
        }
      } else if (tab.suspended) {
        if (!(await waitForWake(tabId))) {
          log("resume-failed");
          return { ok: false, reason: "failed" };
        }
      }
      // Everything was closed while the answer was awaited.
      if (cancelled()) return { ok: false, reason: "failed" };
      // The tab may have closed while the answer was awaited.
      const current = tabOfId(tabId);
      if (current === undefined) return { ok: false, reason: "failed" };

      const handlers: PopoutHandlers = {
        onResize: (size) => {
          lastSize = size;
          if (!isTerminal) deps.views.setPoppedBounds(tabId, bounds(size));
        },
        onCloseRequested: () => void returnTab(tabId),
        onClosed: () => {
          const record = records.get(tabId);
          // A late event of a window that is no longer this tab's.
          if (record === undefined || record.window !== created) return;
          if (!isTerminal) safely(() => deps.views.popIn(tabId));
          else if (record.state !== undefined) returned.set(tabId, record.state);
          dropRecord(record);
          announce();
        },
        onCrashed: () => {
          log("crashed");
          void returnTab(tabId, false);
        },
        onFocusChanged: () => deps.onFocusChanged?.(),
      };
      const window = deps.createWindow(
        { tabId, kind: current.kind, title: tabLabel(current), size: lastSize },
        handlers,
      );
      created = window;
      const record: PopoutRecord = { tabId, kind: current.kind, window, state, returning: false };
      if (!isTerminal && !deps.views.popOut(tabId, window.target, bounds(window.contentSize()))) {
        safely(() => window.destroy());
        log("move-failed");
        return { ok: false, reason: "failed" };
      }
      records.set(tabId, record);
      returned.delete(tabId);
      announce();
      return { ok: true, already: false };
    } catch {
      // createWindow or the view move threw: nothing is left half open.
      if (created !== undefined) {
        const window = created;
        safely(() => window.destroy());
      }
      log("open-threw");
      return { ok: false, reason: "failed" };
    } finally {
      opening.delete(tabId);
    }
  }

  async function returnTab(tabId: unknown, askRenderer = true): Promise<boolean> {
    if (typeof tabId !== "string") return false;
    const record = records.get(tabId);
    if (record === undefined || record.returning) return false;
    record.returning = true;
    if (record.kind === "terminal") {
      let state: PopoutTerminalState | undefined;
      if (askRenderer) state = await requestState(tabId, record.window.contentsId);
      state ??= record.state;
      if (records.get(tabId) !== record) return false;
      if (state !== undefined) returned.set(tabId, state);
    } else {
      safely(() => deps.views.popIn(tabId));
    }
    dropRecord(record);
    // The page is back in the main window by now; only then does the window go.
    record.window.destroy();
    announce();
    return true;
  }

  deps.workspace.onChange((state) => {
    for (const record of [...records.values()]) {
      const tab = state.tabs.find((candidate) => candidate.id === record.tabId);
      if (tab === undefined) {
        // The tab closed: its window goes with it, and there is nothing to
        // return. (A page's view was destroyed by the reconciler.)
        dropRecord(record);
        returned.delete(record.tabId);
        record.window.destroy();
        announce();
      } else {
        record.window.setTitle(tabLabel(tab));
      }
    }
  });

  return {
    open,
    returnTab,
    focus(tabId, paneKey) {
      if (typeof tabId !== "string") return false;
      const record = records.get(tabId);
      if (record === undefined) return false;
      record.window.focus();
      if (typeof paneKey === "string" && record.kind === "terminal") {
        record.window.send("popout:focusPane", paneKey);
      }
      return true;
    },
    list: ids,
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tabOf: (contentsId) =>
      [...records.values()].find((record) => record.window.contentsId === contentsId)?.tabId,
    isPopped: (tabId) => records.has(tabId),
    canPopOut: (tabId) => {
      const tab = tabOfId(tabId);
      return tab !== undefined && canPopOut(tab.kind);
    },
    ready(contentsId) {
      const record = [...records.values()].find((entry) => entry.window.contentsId === contentsId);
      if (record === undefined) return undefined;
      return {
        tabId: record.tabId,
        ...(record.kind === "terminal"
          ? { state: record.state ?? plainTerminalState(record.tabId) }
          : {}),
      };
    },
    reportState(contentsId, value) {
      const record = [...records.values()].find((entry) => entry.window.contentsId === contentsId);
      if (record === undefined || record.kind !== "terminal") return;
      const state = parsePopoutState(value, record.tabId);
      if (state !== undefined) record.state = state;
    },
    provideState(from, tabId, value) {
      if (typeof tabId !== "string") return;
      const waiting = pending.get(tabId);
      if (waiting === undefined || waiting.from !== from) return;
      waiting.resolve(parsePopoutState(value, tabId));
    },
    takeReturned(tabId) {
      const state = returned.get(tabId);
      returned.delete(tabId);
      return state;
    },
    closeAll() {
      generation += 1;
      const alive = mainAlive();
      const closing = [...records.values()];
      for (const record of closing) {
        // The page goes back before its window goes; a terminal keeps what it
        // last reported for the tab's next pane. With the main window gone
        // its views are gone too, and nothing is staged for a renderer
        // that no longer exists.
        if (alive) {
          if (record.kind === "terminal") {
            if (record.state !== undefined) returned.set(record.tabId, record.state);
          } else {
            safely(() => deps.views.popIn(record.tabId));
          }
        }
        records.delete(record.tabId);
        safely(() => record.window.destroy());
      }
      for (const waiting of [...pending.values()]) waiting.resolve(undefined);
      if (closing.length > 0) announce();
    },
    async returnAll() {
      await Promise.all(ids().map((id) => returnTab(id)));
    },
    anyFocused: () => [...records.values()].some((record) => record.window.isFocused()),
    anyAwake: () => [...records.values()].some((record) => record.window.isAwake()),
    focusedContentsId: () =>
      [...records.values()].find((record) => record.window.isFocused())?.window.contentsId,
    contentsIds: () => [...records.values()].map((record) => record.window.contentsId),
  };
}

/**
 * Whether a push to the main window also goes to the pop-out of `tabId`. An
 * allow list: only what the terminal modules in that window listen to, and
 * of the per-pane streams only its own tab's — so a pop-out never receives
 * another tab's output, and anything main-only stays main-only. Reaches the
 * window through the broadcaster's sink only.
 */
export function popoutPushAllowed(tabId: string, channel: string, payload: unknown): boolean {
  const own = (key: unknown): boolean =>
    typeof key === "string" && (key === tabId || key.startsWith(`${tabId}:`));
  const field = (name: string): unknown =>
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)[name]
      : undefined;
  switch (channel) {
    case "terminal:data":
    case "terminal:exit":
    case "terminal:claudeViewChanged":
      return own(field("paneKey"));
    case "terminal:layout":
      return field("tabId") === tabId;
    case "workspace:update":
    case "plans:changed":
    case "reviews:changed":
      return true;
    default:
      return false;
  }
}

/**
 * What each window says it shows, reduced to what the Office's notifier
 * needs: the tabs of the window that has the focus. A tab shown in a pop-out
 * counts as viewed only while that window is focused — not merely because it
 * is on screen somewhere — and the main window's tabs only while it is.
 * With no window of ours focused the main window's answer stands (the core
 * ignores it then: the app is not focused).
 */
export function createViewingAggregate(deps: { mainId: number; forward(keys: string[]): void }): {
  report(windowId: number, keys: string[]): void;
  setFocused(windowId: number | undefined): void;
  forget(windowId: number): void;
  /** The host's own knowledge of the pop-out windows and what each shows:
   *  replaces every window but the main one. */
  setPopouts(windows: ReadonlyMap<number, string[]>): void;
} {
  const reported = new Map<number, string[]>();
  let focusedId: number | undefined;
  let sent = "[]";
  const effective = (): string[] => reported.get(focusedId ?? deps.mainId) ?? [];
  const flush = (): void => {
    const keys = effective();
    const text = JSON.stringify(keys);
    if (text === sent) return;
    sent = text;
    deps.forward(keys);
  };
  return {
    report(windowId, keys) {
      reported.set(windowId, keys);
      flush();
    },
    setFocused(windowId) {
      focusedId = windowId;
      flush();
    },
    forget(windowId) {
      reported.delete(windowId);
      flush();
    },
    setPopouts(windows) {
      for (const id of [...reported.keys()]) {
        if (id !== deps.mainId && !windows.has(id)) reported.delete(id);
      }
      for (const [id, keys] of windows) if (id !== deps.mainId) reported.set(id, keys);
      flush();
    },
  };
}
