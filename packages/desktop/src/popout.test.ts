import type { WorkspaceState, WorkspaceTab } from "@jarvis/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Rect, ViewTarget } from "./browser-host.js";
import {
  canPopOut,
  createPopouts,
  clampPopoutSize,
  createViewingAggregate,
  popoutPushAllowed,
  POPOUT_HANDOVER_MS,
  type PopoutHandlers,
  type PopoutSpec,
  type PopoutWindow,
  type Popouts,
} from "./popout.js";
import { plainTerminalState, type PopoutTerminalState } from "./popout-state.js";

function tab(id: string, overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id,
    project: "acme",
    url: `https://${id}.example/`,
    kind: "web",
    title: `Title ${id}`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: undefined,
    hasPlayingVideo: false,
    pageFullscreen: false,
    suspended: false,
    ...overrides,
  };
}

class FakeWindow implements PopoutWindow {
  readonly target: ViewTarget = { name: "window" };
  title = "";
  focused = false;
  awake = true;
  destroyed = false;
  focusCalls = 0;
  sent: [string, unknown][] = [];
  size = { width: 800, height: 600 };
  constructor(
    readonly contentsId: number,
    readonly spec: PopoutSpec,
    readonly handlers: PopoutHandlers,
    private readonly log: string[],
  ) {}
  focus(): void {
    this.focusCalls += 1;
  }
  isFocused(): boolean {
    return this.focused;
  }
  isAwake(): boolean {
    return this.awake && !this.destroyed;
  }
  setTitle(title: string): void {
    this.title = title;
  }
  contentSize(): { width: number; height: number } {
    return this.size;
  }
  send(channel: string, payload: unknown): void {
    this.sent.push([channel, payload]);
  }
  destroy(): void {
    this.destroyed = true;
    this.log.push(`destroy ${this.spec.tabId}`);
  }
}

function setup(tabs: WorkspaceTab[], activeTabId?: string) {
  let state: WorkspaceState = { tabs, activeTabId };
  const listeners = new Set<(state: WorkspaceState) => void>();
  const order: string[] = [];
  const windows: FakeWindow[] = [];
  const announced: string[][] = [];
  const mainSent: [string, unknown][] = [];
  const popped = new Map<string, Rect>();
  const resumed: string[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  let now = 0;
  const flags = { mainAlive: true, createThrows: false, popOutThrows: false };
  const viewsFake = {
    popOut: vi.fn((id: string, _target: ViewTarget, bounds: Rect) => {
      if (flags.popOutThrows) throw new Error("boom");
      if (!state.tabs.some((candidate) => candidate.id === id)) return false;
      popped.set(id, bounds);
      order.push(`popOut ${id}`);
      return true;
    }),
    popIn: vi.fn((id: string) => {
      popped.delete(id);
      order.push(`popIn ${id}`);
    }),
    setPoppedBounds: vi.fn((id: string, bounds: Rect) => popped.set(id, bounds)),
    isPopped: (id: string) => popped.has(id),
  };
  const popouts: Popouts = createPopouts({
    workspace: {
      state: () => state,
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    views: viewsFake,
    mainAlive: () => flags.mainAlive,
    createWindow: (spec, handlers) => {
      if (flags.createThrows) throw new Error("boom");
      const window = new FakeWindow(100 + windows.length, spec, handlers, order);
      windows.push(window);
      order.push(`create ${spec.tabId}`);
      return window;
    },
    resume: async (id) => {
      resumed.push(id);
    },
    mainSend: (channel, payload) => mainSent.push([channel, payload]),
    schedule: (fn, ms) => {
      const entry = { at: now + ms, fn };
      timers.push(entry);
      return () => {
        const at = timers.indexOf(entry);
        if (at !== -1) timers.splice(at, 1);
      };
    },
    log: () => {},
  });
  popouts.onChanged((ids) => announced.push(ids));
  const setState = (next: WorkspaceState) => {
    state = next;
    for (const listener of [...listeners]) listener(next);
  };
  const advance = (ms: number) => {
    now += ms;
    for (const entry of timers.filter((candidate) => candidate.at <= now)) {
      timers.splice(timers.indexOf(entry), 1);
      entry.fn();
    }
  };
  return {
    popouts,
    windows,
    order,
    announced,
    mainSent,
    popped,
    resumed,
    setState,
    advance,
    viewsFake,
    flags,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("what can be popped out", () => {
  it("is every hosted page kind and the terminal, not the API client or Docker", () => {
    for (const kind of ["web", "editor", "database", "cluster", "chat", "terminal"] as const) {
      expect(canPopOut(kind)).toBe(true);
    }
    expect(canPopOut("api")).toBe(false);
    expect(canPopOut("docker")).toBe(false);
    expect(canPopOut("nope")).toBe(false);
  });
});

describe("popping out a page tab", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup([tab("a"), tab("b")], "a");
  });

  it("opens a window titled by the tab, moves the page into it and announces it", async () => {
    expect(await h.popouts.open("a")).toEqual({ ok: true, already: false });
    expect(h.windows).toHaveLength(1);
    expect(h.windows[0]?.spec).toMatchObject({ tabId: "a", kind: "web", title: "Title a" });
    expect(h.viewsFake.popOut).toHaveBeenCalledWith("a", h.windows[0]?.target, {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    expect(h.popouts.list()).toEqual(["a"]);
    expect(h.announced).toEqual([["a"]]);
  });

  it("focuses the window of a tab that is already popped instead of opening another", async () => {
    await h.popouts.open("a");
    expect(await h.popouts.open("a")).toEqual({ ok: true, already: true });
    expect(h.windows).toHaveLength(1);
    expect(h.windows[0]?.focusCalls).toBe(1);
    expect(h.announced).toHaveLength(1);
  });

  it("refuses what is not a tab, not a string, or not a kind that can go", async () => {
    const x = setup([tab("api1", { kind: "api", url: "" }), tab("d", { kind: "docker", url: "" })]);
    expect(await x.popouts.open("nope")).toEqual({ ok: false, reason: "invalid" });
    expect(await x.popouts.open(7)).toEqual({ ok: false, reason: "invalid" });
    expect(await x.popouts.open({ id: "api1" })).toEqual({ ok: false, reason: "invalid" });
    expect(await x.popouts.open("api1")).toEqual({ ok: false, reason: "unsupported" });
    expect(await x.popouts.open("d")).toEqual({ ok: false, reason: "unsupported" });
    expect(x.windows).toEqual([]);
    expect(x.announced).toEqual([]);
  });

  it("destroys the window and fails when the view cannot move", async () => {
    h.viewsFake.popOut.mockReturnValueOnce(false);
    expect(await h.popouts.open("a")).toEqual({ ok: false, reason: "failed" });
    expect(h.windows[0]?.destroyed).toBe(true);
    expect(h.popouts.list()).toEqual([]);
  });

  it("follows the window's size and the tab's label", async () => {
    await h.popouts.open("a");
    h.windows[0]?.handlers.onResize({ width: 900, height: 700 });
    expect(h.viewsFake.setPoppedBounds).toHaveBeenCalledWith("a", {
      x: 0,
      y: 0,
      width: 900,
      height: 700,
    });
    h.setState({ tabs: [tab("a", { customTitle: "Docs" }), tab("b")], activeTabId: "a" });
    expect(h.windows[0]?.title).toBe("Docs");
  });

  it("returns the tab: the view goes back to the main window BEFORE the window is destroyed", async () => {
    await h.popouts.open("a");
    h.order.length = 0;
    expect(await h.popouts.returnTab("a")).toBe(true);
    expect(h.order).toEqual(["popIn a", "destroy a"]);
    expect(h.popouts.list()).toEqual([]);
    expect(h.announced.at(-1)).toEqual([]);
    expect(await h.popouts.returnTab("a")).toBe(false);
  });

  it("returns the tab when the user closes the window, without closing the tab", async () => {
    await h.popouts.open("a");
    h.order.length = 0;
    h.windows[0]?.handlers.onCloseRequested();
    await flush();
    expect(h.order).toEqual(["popIn a", "destroy a"]);
    expect(h.popouts.list()).toEqual([]);
  });

  it("destroys the window when its tab closes, and never returns anything", async () => {
    await h.popouts.open("a");
    h.order.length = 0;
    h.setState({ tabs: [tab("b")], activeTabId: "b" });
    expect(h.windows[0]?.destroyed).toBe(true);
    expect(h.order).toEqual(["destroy a"]);
    expect(h.popouts.list()).toEqual([]);
    expect(h.announced.at(-1)).toEqual([]);
  });

  it("closes every window on quit, each page back in the main window first, announced once", async () => {
    await h.popouts.open("a");
    await h.popouts.open("b");
    h.order.length = 0;
    h.announced.length = 0;
    h.popouts.closeAll();
    expect(h.windows.every((window) => window.destroyed)).toBe(true);
    expect(h.order).toEqual(["popIn a", "destroy a", "popIn b", "destroy b"]);
    expect(h.popouts.list()).toEqual([]);
    expect(h.announced).toEqual([[]]);
  });

  it("closeAll with the main window gone touches no view and sends nothing, and does not throw", async () => {
    await h.popouts.open("a");
    h.order.length = 0;
    h.mainSent.length = 0;
    h.flags.mainAlive = false;
    expect(() => h.popouts.closeAll()).not.toThrow();
    expect(h.order).toEqual(["destroy a"]);
    expect(h.mainSent).toEqual([]);
  });

  it("closeAll keeps a terminal's last state as returned, once", async () => {
    const t = setup([tab("t1", { kind: "terminal" })], "t1");
    const open = t.popouts.open("t1");
    t.popouts.provideState("main", "t1", plainTerminalState("t1"));
    await open;
    const split: PopoutTerminalState = {
      shape: { direction: "row", first: { key: "t1" }, second: { key: "t1:p1" } },
      drafts: { "t1:p1": "ls" },
    };
    t.popouts.reportState(100, split);
    t.popouts.closeAll();
    expect(t.popouts.takeReturned("t1")).toEqual(split);
    expect(t.popouts.takeReturned("t1")).toBeUndefined();
  });

  it("closeAll during an open that is awaiting the handover opens no window afterwards", async () => {
    const t = setup([tab("t1", { kind: "terminal" })], "t1");
    const open = t.popouts.open("t1");
    t.popouts.closeAll();
    expect(await open).toEqual({ ok: false, reason: "failed" });
    expect(t.windows).toEqual([]);
  });

  it("closeAll during a wake does not open a window afterwards", async () => {
    const t = setup([tab("a", { suspended: true })], "b");
    const open = t.popouts.open("a");
    t.popouts.closeAll();
    t.setState({ tabs: [tab("a")], activeTabId: "a" });
    expect(await open).toEqual({ ok: false, reason: "failed" });
    expect(t.windows).toEqual([]);
  });

  it("a window creation that throws is a failed result, never a rejection", async () => {
    h.flags.createThrows = true;
    await expect(h.popouts.open("a")).resolves.toEqual({ ok: false, reason: "failed" });
    expect(h.popouts.list()).toEqual([]);
    h.flags.createThrows = false;
    expect(await h.popouts.open("a")).toEqual({ ok: true, already: false });
  });

  it("a view move that throws destroys the window and fails, never rejects", async () => {
    h.flags.popOutThrows = true;
    await expect(h.popouts.open("a")).resolves.toEqual({ ok: false, reason: "failed" });
    expect(h.windows[0]?.destroyed).toBe(true);
    expect(h.popouts.list()).toEqual([]);
  });

  it("a late close event of an old window does not drop the tab's new window", async () => {
    await h.popouts.open("a");
    const first = h.windows[0];
    await h.popouts.returnTab("a");
    await h.popouts.open("a");
    first?.handlers.onClosed();
    expect(h.popouts.list()).toEqual(["a"]);
  });

  it("returnAll asks every terminal renderer and returns every page before a reload", async () => {
    const t = setup([tab("t1", { kind: "terminal" }), tab("a")], "a");
    const open = t.popouts.open("t1");
    t.popouts.provideState("main", "t1", plainTerminalState("t1"));
    await open;
    await t.popouts.open("a");
    const done = t.popouts.returnAll();
    t.popouts.provideState(100, "t1", plainTerminalState("t1"));
    await done;
    expect(t.popouts.list()).toEqual([]);
    expect(t.order).toContain("popIn a");
  });

  it("forgets a window that was destroyed from outside, handing the page back first", async () => {
    await h.popouts.open("a");
    h.order.length = 0;
    h.windows[0]?.handlers.onClosed();
    expect(h.order).toEqual(["popIn a"]);
    expect(h.popouts.list()).toEqual([]);
  });

  it("resumes a suspended tab first and waits until the state says it is awake", async () => {
    const x = setup([tab("a", { suspended: true })], "b");
    const opening = x.popouts.open("a");
    await flush();
    expect(x.resumed).toEqual(["a"]);
    expect(x.windows).toEqual([]);
    x.setState({ tabs: [tab("a")], activeTabId: "a" });
    expect(await opening).toEqual({ ok: true, already: false });
    expect(x.windows).toHaveLength(1);
  });

  it("gives up on a tab that never wakes", async () => {
    const x = setup([tab("a", { suspended: true })]);
    const opening = x.popouts.open("a");
    await flush();
    x.advance(20_000);
    expect(await opening).toEqual({ ok: false, reason: "failed" });
    expect(x.windows).toEqual([]);
  });

  it("does not open the same tab twice at once", async () => {
    const x = setup([tab("a", { suspended: true })]);
    const first = x.popouts.open("a");
    await flush();
    expect(await x.popouts.open("a")).toEqual({ ok: false, reason: "busy" });
    x.setState({ tabs: [tab("a")], activeTabId: "a" });
    await first;
  });

  it("answers every window's focus and awake question for the host", async () => {
    await h.popouts.open("a");
    await h.popouts.open("b");
    expect(h.popouts.anyFocused()).toBe(false);
    expect(h.popouts.anyAwake()).toBe(true);
    expect(h.popouts.focusedContentsId()).toBeUndefined();
    (h.windows[1] as FakeWindow).focused = true;
    expect(h.popouts.anyFocused()).toBe(true);
    expect(h.popouts.focusedContentsId()).toBe(101);
    (h.windows[0] as FakeWindow).awake = false;
    (h.windows[1] as FakeWindow).awake = false;
    expect(h.popouts.anyAwake()).toBe(false);
  });
});

describe("popping out a terminal tab", () => {
  const SPLIT: PopoutTerminalState = {
    shape: { direction: "row", first: { key: "t1" }, second: { key: "t1:p1" } },
    drafts: { "t1:p1": "git sta" },
    focused: "t1:p1",
  };
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup([tab("t1", { kind: "terminal", url: "" })], "t1");
  });

  /** The main renderer answers the hand-over request. */
  async function answerMain(state: unknown): Promise<void> {
    await flush();
    const request = h.mainSent.find(([channel]) => channel === "popout:handover");
    expect(request?.[1]).toBe("t1");
    h.popouts.provideState("main", "t1", state);
  }

  it("asks the main window for the tab's layout and drafts first, and opens with them", async () => {
    const opening = h.popouts.open("t1");
    await answerMain(SPLIT);
    expect(await opening).toEqual({ ok: true, already: false });
    expect(h.viewsFake.popOut).not.toHaveBeenCalled();
    const window = h.windows[0] as FakeWindow;
    expect(window.spec).toMatchObject({ tabId: "t1", kind: "terminal" });
    expect(h.popouts.ready(window.contentsId)).toEqual({ tabId: "t1", state: SPLIT });
    expect(h.announced).toEqual([["t1"]]);
  });

  it("does not open, and moves nothing, when the main window does not answer", async () => {
    const opening = h.popouts.open("t1");
    await flush();
    h.advance(POPOUT_HANDOVER_MS + 1);
    expect(await opening).toEqual({ ok: false, reason: "failed" });
    expect(h.windows).toEqual([]);
    expect(h.popouts.list()).toEqual([]);
    expect(h.announced).toEqual([]);
  });

  it("does not open when the main window answers with nonsense", async () => {
    const opening = h.popouts.open("t1");
    await answerMain({ shape: { key: "t9" } });
    expect(await opening).toEqual({ ok: false, reason: "failed" });
    expect(h.windows).toEqual([]);
  });

  it("returns by asking the pop-out for its final layout and drafts, then hands them to the main window once", async () => {
    const opening = h.popouts.open("t1");
    await answerMain(plainTerminalState("t1"));
    await opening;
    const window = h.windows[0] as FakeWindow;
    h.order.length = 0;
    const returning = h.popouts.returnTab("t1");
    await flush();
    expect(window.sent).toContainEqual(["popout:handover", "t1"]);
    h.popouts.provideState(window.contentsId, "t1", SPLIT);
    expect(await returning).toBe(true);
    expect(h.order).toEqual(["destroy t1"]);
    expect(h.popouts.takeReturned("t1")).toEqual(SPLIT);
    expect(h.popouts.takeReturned("t1")).toBeUndefined();
    expect(h.popouts.list()).toEqual([]);
  });

  it("falls back to the last state the pop-out reported when it does not answer", async () => {
    const opening = h.popouts.open("t1");
    await answerMain(plainTerminalState("t1"));
    await opening;
    const window = h.windows[0] as FakeWindow;
    h.popouts.reportState(window.contentsId, SPLIT);
    const returning = h.popouts.returnTab("t1");
    await flush();
    h.advance(POPOUT_HANDOVER_MS + 1);
    expect(await returning).toBe(true);
    expect(h.popouts.takeReturned("t1")).toEqual(SPLIT);
  });

  it("returns the tab at once, with its last state, when the pop-out's renderer crashes", async () => {
    const opening = h.popouts.open("t1");
    await answerMain(SPLIT);
    await opening;
    const window = h.windows[0] as FakeWindow;
    h.windows[0]?.handlers.onCrashed();
    await flush();
    expect(window.destroyed).toBe(true);
    expect(h.popouts.list()).toEqual([]);
    expect(h.popouts.takeReturned("t1")).toEqual(SPLIT);
  });

  it("closing the window asks for the state like a return does", async () => {
    const opening = h.popouts.open("t1");
    await answerMain(plainTerminalState("t1"));
    await opening;
    const window = h.windows[0] as FakeWindow;
    window.handlers.onCloseRequested();
    await flush();
    expect(window.destroyed).toBe(false);
    h.popouts.provideState(window.contentsId, "t1", SPLIT);
    await flush();
    expect(window.destroyed).toBe(true);
    expect(h.popouts.takeReturned("t1")).toEqual(SPLIT);
  });

  it("keeps the window while a close waits, and a second close request changes nothing", async () => {
    const opening = h.popouts.open("t1");
    await answerMain(plainTerminalState("t1"));
    await opening;
    const window = h.windows[0] as FakeWindow;
    window.handlers.onCloseRequested();
    window.handlers.onCloseRequested();
    await flush();
    expect(window.sent.filter(([channel]) => channel === "popout:handover")).toHaveLength(1);
    h.advance(POPOUT_HANDOVER_MS + 1);
    await flush();
    expect(window.destroyed).toBe(true);
  });

  it("only believes an answer from the window it asked, about its own tab", async () => {
    const opening = h.popouts.open("t1");
    await flush();
    h.popouts.provideState(555, "t1", SPLIT);
    h.popouts.provideState("main", "t2", SPLIT);
    h.advance(POPOUT_HANDOVER_MS + 1);
    expect(await opening).toEqual({ ok: false, reason: "failed" });
  });

  it("tells a pop-out only its own tab, and a stranger nothing", async () => {
    const opening = h.popouts.open("t1");
    await answerMain(SPLIT);
    await opening;
    expect(h.popouts.ready(9999)).toBeUndefined();
    expect(h.popouts.tabOf(h.windows[0]?.contentsId ?? 0)).toBe("t1");
    expect(h.popouts.tabOf(9999)).toBeUndefined();
    h.popouts.reportState(9999, plainTerminalState("t1"));
    h.popouts.reportState(h.windows[0]?.contentsId ?? 0, { shape: { key: "t2" } });
    expect(h.popouts.ready(h.windows[0]?.contentsId ?? 0)?.state).toEqual(SPLIT);
  });

  it("focuses the pop-out and passes on the pane to focus", async () => {
    const opening = h.popouts.open("t1");
    await answerMain(SPLIT);
    await opening;
    expect(h.popouts.focus("t1", "t1:p1")).toBe(true);
    const window = h.windows[0] as FakeWindow;
    expect(window.focusCalls).toBe(1);
    expect(window.sent).toContainEqual(["popout:focusPane", "t1:p1"]);
    expect(h.popouts.focus("t1", 5)).toBe(true);
    expect(h.popouts.focus("nope")).toBe(false);
  });
});

describe("viewing across windows", () => {
  it("counts the focused window's tabs only, and follows focus", () => {
    const forwarded: string[][] = [];
    const viewing = createViewingAggregate({ mainId: 1, forward: (keys) => forwarded.push(keys) });
    viewing.report(1, ["t1"]);
    viewing.report(7, ["t2"]);
    viewing.setFocused(1);
    viewing.setFocused(7);
    viewing.setFocused(undefined);
    viewing.forget(7);
    expect(forwarded).toEqual([["t1"], ["t2"], ["t1"]]);
  });

  it("does not repeat an unchanged answer", () => {
    const forwarded: string[][] = [];
    const viewing = createViewingAggregate({ mainId: 1, forward: (keys) => forwarded.push(keys) });
    viewing.setFocused(1);
    viewing.report(1, ["t1"]);
    viewing.report(1, ["t1"]);
    viewing.report(5, ["t9"]);
    expect(forwarded).toEqual([["t1"]]);
  });
});

describe("viewing of pop-out windows", () => {
  it("counts each pop-out's tab while its window is focused, from the host, and forgets it on close", () => {
    const forwarded: string[][] = [];
    const viewing = createViewingAggregate({ mainId: 1, forward: (keys) => forwarded.push(keys) });
    viewing.report(1, ["t1"]);
    viewing.setFocused(1);
    viewing.setPopouts(new Map([[7, ["t2"]]]));
    viewing.setFocused(7);
    viewing.setPopouts(new Map());
    expect(forwarded).toEqual([["t1"], ["t2"], []]);
  });

  it("only the main window's own reports are taken", () => {
    const forwarded: string[][] = [];
    const viewing = createViewingAggregate({ mainId: 1, forward: (keys) => forwarded.push(keys) });
    viewing.setFocused(1);
    viewing.report(9, ["x"]);
    viewing.report(1, ["t1"]);
    expect(forwarded).toEqual([["t1"]]);
  });
});

describe("clampPopoutSize", () => {
  const area = { width: 1440, height: 875 };
  it("keeps a size that fits and shrinks one that does not, never below a usable minimum", () => {
    expect(clampPopoutSize({ width: 900, height: 600 }, area)).toEqual({ width: 900, height: 600 });
    expect(clampPopoutSize({ width: 5000, height: 4000 }, area)).toEqual(area);
    expect(clampPopoutSize({ width: 10, height: 10 }, area)).toEqual({ width: 320, height: 240 });
    expect(clampPopoutSize(undefined, area)).toEqual({ width: 1000, height: 700 });
    expect(clampPopoutSize({ width: Number.NaN, height: 600 }, area)).toEqual({
      width: 1000,
      height: 600,
    });
  });
});

describe("popoutPushAllowed", () => {
  it("gives a pop-out its own tab's terminal output, exits, layout and chat refreshes, and nothing of another tab", () => {
    expect(popoutPushAllowed("t1", "terminal:data", { paneKey: "t1", chunk: "x", offset: 1 })).toBe(
      true,
    );
    expect(popoutPushAllowed("t1", "terminal:data", { paneKey: "t1:p2", chunk: "x" })).toBe(true);
    expect(popoutPushAllowed("t1", "terminal:data", { paneKey: "t10", chunk: "x" })).toBe(false);
    expect(popoutPushAllowed("t1", "terminal:data", { paneKey: "t2:p1", chunk: "x" })).toBe(false);
    expect(popoutPushAllowed("t1", "terminal:exit", { paneKey: "t1:p1", code: 0 })).toBe(true);
    expect(popoutPushAllowed("t1", "terminal:exit", { paneKey: "t2", code: 0 })).toBe(false);
    expect(popoutPushAllowed("t1", "terminal:layout", { tabId: "t1", paneKey: "t1:p1" })).toBe(
      true,
    );
    expect(popoutPushAllowed("t1", "terminal:layout", { tabId: "t2", paneKey: "t2:p1" })).toBe(
      false,
    );
    expect(popoutPushAllowed("t1", "terminal:claudeViewChanged", { paneKey: "t1" })).toBe(true);
    expect(popoutPushAllowed("t1", "terminal:claudeViewChanged", { paneKey: "t3" })).toBe(false);
    expect(popoutPushAllowed("t1", "terminal:data", null)).toBe(false);
    expect(popoutPushAllowed("t1", "terminal:data", { paneKey: 5 })).toBe(false);
  });

  it("gives it the refresh signals the terminal modules listen to, and keeps every main-only push out", () => {
    for (const channel of ["workspace:update", "plans:changed", "reviews:changed"]) {
      expect(popoutPushAllowed("t1", channel, {})).toBe(true);
    }
    for (const channel of [
      "turn:new",
      "voice:speaking",
      "voice:hotkeys",
      "update:state",
      "machine:state",
      "remote:update",
      "awake:changed",
      "metrics:update",
      "sessions:update",
      "providers:update",
      "git:counts",
      "session:output",
      "docker:log",
      "setup:output",
      "office:changed",
      "workspace:tabRename",
      "workspace:tabPlans",
      "workspace:devtoolsClosed",
      "workspace:devtoolsDockChosen",
      "popout:changed",
      "popout:handover",
      "popout:focusPane",
      "daemon:restarting",
      "",
    ]) {
      expect(popoutPushAllowed("t1", channel, {})).toBe(false);
    }
  });
});
