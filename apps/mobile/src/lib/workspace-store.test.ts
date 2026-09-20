import type { SubTarget } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceStore,
  listChatNames,
  parseTerminalPanes,
  resolveChatUrl,
  resolvePane,
  safeExternalUrl,
} from "./workspace-store";
import type { ClientState, RpcClient, RpcResult } from "./rpc-client";

type StateHandler = (state: ClientState, detail: { closeCode?: number }) => void;
type PushHandler = (payload: unknown, dropped: number | undefined) => void;

/** The same minimal fake RpcClient dashboard-store.test.ts uses: `call`
 * resolves from a queue the test fills in (or stays pending until
 * `resolvePending`), `subscribe`/`unsubscribe` just record what was asked
 * for, and pushes are driven directly — no fake transport, no real
 * network. */
function createFakeClient() {
  const subscribeCalls: SubTarget[] = [];
  const unsubscribeCalls: SubTarget[] = [];
  const subscriptionCounts = new Map<SubTarget, number>();
  const callLog: {
    channel: string;
    args: unknown[];
    options?: { whenNotOpen?: "queue" | "reject" };
  }[] = [];
  const pushHandlers = new Map<string, Set<PushHandler>>();
  const stateHandlers = new Set<StateHandler>();
  let state: ClientState = "open";
  const callResults: RpcResult[] = [];
  const pendingCalls: ((result: RpcResult) => void)[] = [];

  const client: RpcClient = {
    connect: () => {},
    disconnect: () => {},
    call: (channel, args, options) => {
      callLog.push({ channel, args, ...(options === undefined ? {} : { options }) });
      if (state !== "open" && options?.whenNotOpen === "reject") {
        return Promise.resolve({ ok: false, error: { kind: "offline" } });
      }
      const queued = callResults.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => {
        pendingCalls.push(resolve);
      });
    },
    upload: async () => ({ ok: false, error: { kind: "offline" } }),
    subscribe: (target) => {
      subscribeCalls.push(target);
      subscriptionCounts.set(target, (subscriptionCounts.get(target) ?? 0) + 1);
      return { ok: true, value: undefined };
    },
    unsubscribe: (target) => {
      unsubscribeCalls.push(target);
      const count = subscriptionCounts.get(target) ?? 0;
      if (count <= 1) subscriptionCounts.delete(target);
      else subscriptionCounts.set(target, count - 1);
    },
    onPush: (channel, handler) => {
      let set = pushHandlers.get(channel);
      if (set === undefined) {
        set = new Set();
        pushHandlers.set(channel, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
    onState: (handler) => {
      stateHandlers.add(handler);
      return () => {
        stateHandlers.delete(handler);
      };
    },
    state: () => state,
    capabilities: () => [],
    subscriptions: () => [],
    lastFrameAt: () => undefined,
    setAppActive: () => {},
  };

  return {
    client,
    subscribeCalls,
    unsubscribeCalls,
    subscriptions() {
      return new Map(subscriptionCounts);
    },
    callLog,
    queueResult(result: RpcResult) {
      callResults.push(result);
    },
    push(channel: string, payload: unknown) {
      for (const handler of pushHandlers.get(channel) ?? []) handler(payload, undefined);
    },
    setState(next: ClientState) {
      state = next;
      for (const handler of [...stateHandlers]) handler(next, {});
    },
    pendingCallCount() {
      return pendingCalls.length;
    },
    resolvePending(index: number, result: RpcResult) {
      const resolve = pendingCalls[index];
      if (resolve === undefined) throw new Error(`no pending call at index ${index}`);
      resolve(result);
    },
  };
}

const TAB = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "tab-1",
  project: "acme",
  url: "https://acme.internal",
  kind: "terminal",
  title: "acme — Terminal",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  hasPlayingVideo: false,
  pageFullscreen: false,
  suspended: false,
  ...overrides,
});

describe("createWorkspaceStore: open/refresh", () => {
  it("subscribes to workspace:update and calls projects:list + workspace:snapshot, grouping tabs by project", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: ["acme", "storefront"] });
    fake.queueResult({ ok: true, value: { tabs: [TAB()], activeTabId: "tab-1" } });
    const store = createWorkspaceStore({ client: fake.client });

    store.open();
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.subscribeCalls).toEqual(["workspace:update"]);
    expect(fake.callLog).toEqual([
      { channel: "projects:list", args: [] },
      { channel: "workspace:snapshot", args: [] },
    ]);
    const view = store.get();
    expect(view.loading).toBe(false);
    expect(view.projects).toEqual([
      { name: "acme", tabs: [expect.objectContaining({ id: "tab-1" })] },
      { name: "storefront", tabs: [] },
    ]);
  });

  it("adds a project that only exists because of an open tab (not in projects:list)", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: [] });
    fake.queueResult({
      ok: true,
      value: { tabs: [TAB({ project: "orphan" })], activeTabId: undefined },
    });
    const store = createWorkspaceStore({ client: fake.client });

    store.open();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.get().projects.map((p) => p.name)).toEqual(["orphan"]);
  });

  // Tab removal: a later workspace:update with a shorter tab list drops the
  // removed tab from its project's row.
  it("removes a tab from its project on the next workspace:update push", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: ["acme"] });
    fake.queueResult({ ok: true, value: { tabs: [TAB()], activeTabId: "tab-1" } });
    const store = createWorkspaceStore({ client: fake.client });
    store.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get().projects[0]?.tabs).toHaveLength(1);

    fake.push("workspace:update", { tabs: [], activeTabId: undefined });

    expect(store.get().projects[0]?.tabs).toEqual([]);
  });

  // Push wins over a stale list answer (task-7-review.md Important 2, fix
  // round 1 — workspace-store.ts's own header comment has the full
  // rationale): a refresh() already in flight must not clobber what a
  // workspace:update push set after it.
  it("drops a stale refresh() answer that arrives after a workspace:update push", async () => {
    const fake = createFakeClient();
    const store = createWorkspaceStore({ client: fake.client });
    store.open();
    await Promise.resolve();
    // Two calls are now pending: projects:list, workspace:snapshot.
    expect(fake.pendingCallCount()).toBe(2);

    fake.push("workspace:update", { tabs: [TAB({ id: "pushed" })], activeTabId: "pushed" });
    expect(store.get().projects[0]?.tabs[0]?.id).toBe("pushed");

    fake.resolvePending(0, { ok: true, value: ["acme"] });
    fake.resolvePending(1, {
      ok: true,
      value: { tabs: [TAB({ id: "stale" })], activeTabId: "stale" },
    });
    await Promise.resolve();
    await Promise.resolve();

    // The push's tab is still there — the stale pull never overwrote it.
    expect(store.get().projects[0]?.tabs[0]?.id).toBe("pushed");
  });

  // Fix round 1, Important 2, dropped-answer case (a): the old single
  // generation counter dropped the whole refresh() answer — including its
  // projects:list half, which the push never touched — and left `loading`
  // stuck at true forever, once the push had moved the one counter on.
  it("keeps refresh()'s projects:list answer and clears loading when a push supersedes only its snapshot half", async () => {
    const fake = createFakeClient();
    const store = createWorkspaceStore({ client: fake.client });
    store.open();
    await Promise.resolve();
    expect(fake.pendingCallCount()).toBe(2);

    fake.push("workspace:update", { tabs: [TAB({ id: "pushed" })], activeTabId: "pushed" });

    fake.resolvePending(0, { ok: true, value: ["acme", "storefront"] });
    fake.resolvePending(1, {
      ok: true,
      value: { tabs: [TAB({ id: "stale" })], activeTabId: "stale" },
    });
    await Promise.resolve();
    await Promise.resolve();

    const view = store.get();
    expect(view.loading).toBe(false); // never stuck, even though the snapshot half was superseded
    expect(view.projects.map((p) => p.name)).toEqual(["acme", "storefront"]); // kept
    expect(view.projects[0]?.tabs[0]?.id).toBe("pushed"); // the push's snapshot wins, not the stale pull
  });

  // Fix round 1, Important 2, dropped-answer case (b): a workspace:update
  // push must never cancel an in-flight readPanes() — it only carries a
  // snapshot, never a pane inventory, and used to drop the whole pane list
  // by bumping the one shared counter.
  it("keeps an in-flight readPanes() answer even though a workspace:update push landed first", async () => {
    const fake = createFakeClient();
    const store = createWorkspaceStore({ client: fake.client });

    store.readPanes("tab-1");
    expect(fake.pendingCallCount()).toBe(1);

    fake.push("workspace:update", { tabs: [], activeTabId: undefined });

    fake.resolvePending(0, { ok: true, value: [{ paneKey: "tab-1", exited: false }] });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.get().panes).toEqual([{ paneKey: "tab-1", exited: false }]);
    expect(store.get().panesTabId).toBe("tab-1");
  });

  // Fix round 1, Important 2: readPanes() and refresh() no longer cancel
  // each other — calling one while the other is in flight must not drop
  // either's own answer.
  it("readPanes() while refresh() is in flight does not drop refresh()'s projects/snapshot answer", async () => {
    const fake = createFakeClient();
    const store = createWorkspaceStore({ client: fake.client });
    store.open();
    await Promise.resolve();
    expect(fake.pendingCallCount()).toBe(2);

    store.readPanes("tab-1"); // used to bump the single shared generation and drop refresh()'s answer
    expect(fake.pendingCallCount()).toBe(3);

    fake.resolvePending(0, { ok: true, value: ["acme"] });
    fake.resolvePending(1, { ok: true, value: { tabs: [TAB()], activeTabId: "tab-1" } });
    fake.resolvePending(2, { ok: true, value: [{ paneKey: "tab-1", exited: false }] });
    await Promise.resolve();
    await Promise.resolve();

    const view = store.get();
    expect(view.projects[0]?.tabs).toHaveLength(1); // refresh()'s snapshot answer applied, not dropped
    expect(view.panes).toEqual([{ paneKey: "tab-1", exited: false }]); // readPanes()'s own answer applied too
    expect(view.panesTabId).toBe("tab-1");
  });

  // Fix round 2 (re-review Important): refresh() captures `panesTabId` and
  // `panesGeneration` at issue time, but readPanes()'s own bump happened
  // *before* refresh() was ever called — so a later readPanes() for a
  // *different* tab, still in flight when refresh() starts, leaves
  // panesGeneration unchanged between refresh()'s own capture and its
  // answer landing. Without also checking that `view.panesTabId` is still
  // what refresh() captured, refresh()'s stale piggybacked answer (issued
  // for the tab that was showing *before* the tap) can land after the tap
  // resolved and silently undo it.
  it("readPanes(B) then refresh() — refresh's answer for A does not overwrite B", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: [{ paneKey: "A-pane", exited: false }] });
    const store = createWorkspaceStore({ client: fake.client });
    store.readPanes("A");
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get().panesTabId).toBe("A");

    store.readPanes("B"); // in flight — the user's own next tap
    expect(fake.pendingCallCount()).toBe(1);

    // A pull-to-refresh starts before B's answer lands: it still sees "A"
    // as the current panesTabId and piggybacks a stale terminal:panes read
    // for it.
    store.refresh();
    expect(fake.pendingCallCount()).toBe(4); // B's still-pending read + refresh's 3 calls

    // B's answer lands first — the explicit tap wins, as always.
    fake.resolvePending(0, { ok: true, value: [{ paneKey: "B-pane", exited: false }] });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get().panesTabId).toBe("B");

    // refresh()'s three answers land after, including its piggybacked read
    // for A — issued before the tap to B had resolved.
    fake.resolvePending(1, { ok: true, value: ["acme"] });
    fake.resolvePending(2, { ok: true, value: { tabs: [], activeTabId: undefined } });
    fake.resolvePending(3, { ok: true, value: [{ paneKey: "A-pane", exited: false }] });
    await Promise.resolve();
    await Promise.resolve();

    // The tap to B must still be showing.
    expect(store.get().panesTabId).toBe("B");
    expect(store.get().panes).toEqual([{ paneKey: "B-pane", exited: false }]);
  });

  // Fix round 2 (deferred minor): `loading` used to clear unconditionally
  // on every refresh() call's own resolution — right for the push-races-
  // refresh() case (round 1), wrong for two overlapping refresh() calls:
  // an older one landing while a newer one is still in flight must not
  // flip the spinner off early.
  it("an older refresh() landing while a newer one is in flight does not clear loading early", async () => {
    const fake = createFakeClient();
    const store = createWorkspaceStore({ client: fake.client });

    store.refresh(); // refreshGeneration 1
    expect(fake.pendingCallCount()).toBe(2);
    store.refresh(); // refreshGeneration 2
    expect(fake.pendingCallCount()).toBe(4);
    expect(store.get().loading).toBe(true);

    // The older call's answers land first.
    fake.resolvePending(0, { ok: true, value: ["acme"] });
    fake.resolvePending(1, { ok: true, value: { tabs: [], activeTabId: undefined } });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.get().loading).toBe(true); // a newer refresh() is still in flight

    // The newer call's answers land.
    fake.resolvePending(2, { ok: true, value: ["acme"] });
    fake.resolvePending(3, { ok: true, value: { tabs: [], activeTabId: undefined } });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.get().loading).toBe(false);
  });

  it("re-pulls on reconnect and reflects the connection in `stale`", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: [] });
    fake.queueResult({ ok: true, value: { tabs: [], activeTabId: undefined } });
    const store = createWorkspaceStore({ client: fake.client });
    store.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get().stale).toBe(false);

    fake.setState("reconnecting");
    expect(store.get().stale).toBe(true);

    fake.queueResult({ ok: true, value: [] });
    fake.queueResult({ ok: true, value: { tabs: [], activeTabId: undefined } });
    fake.setState("open");
    await Promise.resolve();
    await Promise.resolve();

    expect(store.get().stale).toBe(false);
    expect(fake.callLog).toHaveLength(4);
  });
});

describe("createWorkspaceStore: readPanes", () => {
  it("reads a tab's pane inventory, including split pane ids and an exited pane", async () => {
    const fake = createFakeClient();
    fake.queueResult({
      ok: true,
      value: [
        { paneKey: "tab-1", exited: false },
        { paneKey: "tab-1:p1", exited: true },
      ],
    });
    const store = createWorkspaceStore({ client: fake.client });

    store.readPanes("tab-1");
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.callLog).toEqual([{ channel: "terminal:panes", args: ["tab-1"] }]);
    expect(store.get().panes).toEqual([
      { paneKey: "tab-1", exited: false },
      { paneKey: "tab-1:p1", exited: true },
    ]);
    expect(store.get().panesTabId).toBe("tab-1");
  });

  // A tab with no panes (never opened, or already closed on the laptop):
  // an empty inventory, not an error.
  it("reads an empty inventory for a missing/closed tab", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: [] });
    const store = createWorkspaceStore({ client: fake.client });

    store.readPanes("gone");
    await Promise.resolve();
    await Promise.resolve();

    expect(store.get().panes).toEqual([]);
    expect(store.get().panesTabId).toBe("gone");
  });

  // Fix round 1, Important 1: refresh() (pull-to-refresh, and the
  // onState("open") reconnect handler) re-reads the currently shown tab's
  // pane inventory too — not just projects:list/workspace:snapshot — so an
  // exited/new pane is reflected without the user having to reopen the
  // terminal tab row.
  it("refresh() re-reads the current panesTabId's panes alongside projects:list/workspace:snapshot", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: [{ paneKey: "tab-1", exited: false }] });
    const store = createWorkspaceStore({ client: fake.client });
    store.readPanes("tab-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get().panes).toEqual([{ paneKey: "tab-1", exited: false }]);

    fake.queueResult({ ok: true, value: ["acme"] });
    fake.queueResult({ ok: true, value: { tabs: [TAB()], activeTabId: "tab-1" } });
    fake.queueResult({ ok: true, value: [{ paneKey: "tab-1", exited: true }] });
    store.refresh();
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.callLog.at(-1)).toEqual({ channel: "terminal:panes", args: ["tab-1"] });
    expect(store.get().panes).toEqual([{ paneKey: "tab-1", exited: true }]);
  });

  // refresh() must never re-read a pane inventory nobody asked for — no
  // terminal tab has ever been opened on this screen.
  it("refresh() calls no terminal:panes when no tab's panes have been read", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: [] });
    fake.queueResult({ ok: true, value: { tabs: [], activeTabId: undefined } });
    const store = createWorkspaceStore({ client: fake.client });

    store.refresh();
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.callLog.some((entry) => entry.channel === "terminal:panes")).toBe(false);
  });

  // Project change stale result: selectProject() (a fresh project view)
  // must discard a readPanes() answer for the tab that was open before it.
  it("drops a readPanes() answer superseded by selectProject()", async () => {
    const fake = createFakeClient();
    const store = createWorkspaceStore({ client: fake.client });

    store.readPanes("old-tab");
    expect(fake.pendingCallCount()).toBe(1);
    store.selectProject("storefront");
    fake.resolvePending(0, { ok: true, value: [{ paneKey: "old-tab", exited: false }] });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.get().panes).toEqual([]);
    expect(store.get().panesTabId).toBeUndefined();
    expect(store.get().selectedProject).toBe("storefront");
  });
});

describe("createWorkspaceStore: no tab mutation calls", () => {
  // [bite-proof] Only the three read-only channels below ever cross the
  // wire from this store — never workspace:open/close/activate/navigate/…
  // or terminal:open/split/closePane, whatever sequence of operations runs.
  it("never calls a tab-mutating channel across open/selectProject/refresh/readPanes/close", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: ["acme"] });
    fake.queueResult({ ok: true, value: { tabs: [TAB()], activeTabId: "tab-1" } });
    const store = createWorkspaceStore({ client: fake.client });

    store.open();
    await Promise.resolve();
    await Promise.resolve();
    store.selectProject("acme");
    fake.queueResult({ ok: true, value: [{ paneKey: "tab-1", exited: false }] });
    store.readPanes("tab-1");
    await Promise.resolve();
    await Promise.resolve();
    fake.queueResult({ ok: true, value: ["acme"] });
    fake.queueResult({ ok: true, value: { tabs: [], activeTabId: undefined } });
    store.refresh();
    await Promise.resolve();
    await Promise.resolve();
    store.close();

    const allowed = new Set(["projects:list", "workspace:snapshot", "terminal:panes"]);
    for (const entry of fake.callLog) {
      expect(allowed.has(entry.channel)).toBe(true);
    }
  });

  it("unsubscribes on close and ignores a late push", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: [] });
    fake.queueResult({ ok: true, value: { tabs: [], activeTabId: undefined } });
    const store = createWorkspaceStore({ client: fake.client });
    store.open();
    await Promise.resolve();
    await Promise.resolve();

    store.close();
    fake.push("workspace:update", { tabs: [TAB()], activeTabId: "tab-1" });

    expect(fake.unsubscribeCalls).toEqual(["workspace:update"]);
    expect(store.get().projects).toEqual([]);
  });
});

describe("createWorkspaceStore: rule 6 (subscribe unsupported, close clears loading)", () => {
  it(
    "open() sets liveUpdatesUnsupported instead of ignoring an unsupported " +
      "subscribe() result, and refresh()'s own (later, unrelated) success " +
      "never clears it " +
      "[bite-proof: ignore the subscribe() result; liveUpdatesUnsupported stays false]",
    async () => {
      const fake = createFakeClient();
      fake.client.subscribe = () => ({ ok: false, error: { kind: "unsupported" } });
      fake.queueResult({ ok: true, value: [] });
      fake.queueResult({ ok: true, value: { tabs: [], activeTabId: undefined } });
      const store = createWorkspaceStore({ client: fake.client });

      store.open();
      expect(store.get().liveUpdatesUnsupported).toBe(true);

      // review r0 Important 1's own reproduction: open()'s own refresh()
      // (projects:list + workspace:snapshot) answers, ordinary and
      // successful, with nothing to do with live-update support — this
      // must not clear the flag the way it used to clear `error`.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(store.get().liveUpdatesUnsupported).toBe(true);
      expect(store.get().error).toBeUndefined();
      expect(store.get().loading).toBe(false);
    },
  );

  it("does not ref-count a live subscription again on reconnect, and close releases it once", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: [] });
    fake.queueResult({ ok: true, value: { tabs: [], activeTabId: undefined } });
    const store = createWorkspaceStore({ client: fake.client });

    store.open();
    fake.setState("open");
    store.close();

    expect(fake.subscriptions().get("workspace:update")).toBeUndefined();
    expect(fake.unsubscribeCalls).toEqual(["workspace:update"]);
  });

  it(
    "a reconnect 'open' event re-attempts the subscription and clears liveUpdatesUnsupported " +
      "once it succeeds " +
      "[bite-proof: no resubscribe attempt on the onState 'open' branch]",
    async () => {
      const fake = createFakeClient();
      let allow = false;
      let subscribeAttempts = 0;
      fake.client.subscribe = () => {
        subscribeAttempts += 1;
        return allow
          ? { ok: true, value: undefined }
          : { ok: false, error: { kind: "unsupported" } };
      };
      fake.queueResult({ ok: true, value: [] });
      fake.queueResult({ ok: true, value: { tabs: [], activeTabId: undefined } });
      const store = createWorkspaceStore({ client: fake.client });

      store.open();
      expect(store.get().liveUpdatesUnsupported).toBe(true);
      expect(subscribeAttempts).toBe(1);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // A reconnect — the desktop on the other end may now be a different
      // (or upgraded) one that does support it.
      allow = true;
      fake.setState("closed");
      expect(store.get().liveUpdatesUnsupported).toBe(true); // a mere disconnect never touches it
      fake.setState("open");

      expect(store.get().liveUpdatesUnsupported).toBe(false);
      expect(subscribeAttempts).toBe(2);
    },
  );

  it(
    "a reconnect 'open' event re-sets liveUpdatesUnsupported when the retry still fails, " +
      "not just when it first succeeds",
    async () => {
      const fake = createFakeClient();
      fake.client.subscribe = () => ({ ok: false, error: { kind: "unsupported" } });
      fake.queueResult({ ok: true, value: [] });
      fake.queueResult({ ok: true, value: { tabs: [], activeTabId: undefined } });
      const store = createWorkspaceStore({ client: fake.client });

      store.open();
      expect(store.get().liveUpdatesUnsupported).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      fake.setState("closed");
      fake.setState("open"); // still unsupported on this connection too

      expect(store.get().liveUpdatesUnsupported).toBe(true);
    },
  );

  it(
    "close() sets loading: false even while a refresh() is still in flight " +
      "[bite-proof: leave close() as-is; the assertion below fails]",
    async () => {
      const fake = createFakeClient();
      // Both projects:list and workspace:snapshot stay pending (never
      // queued), so open()'s own refresh() never resolves before close().
      const store = createWorkspaceStore({ client: fake.client });

      store.open();
      await Promise.resolve();
      expect(store.get().loading).toBe(true);

      store.close();
      expect(store.get().loading).toBe(false);
    },
  );
});

describe("safeExternalUrl (ruling 12: allow-list over a hand-checked hostname)", () => {
  it("accepts an absolute https URL", () => {
    expect(safeExternalUrl("https://chat.example.test/room/1")).toBe(
      "https://chat.example.test/room/1",
    );
  });

  it("accepts an absolute http URL", () => {
    expect(safeExternalUrl("http://sub.example.test")).toBe("http://sub.example.test");
  });

  it("refuses a non-string value", () => {
    expect(safeExternalUrl(42)).toBeUndefined();
    expect(safeExternalUrl(undefined)).toBeUndefined();
    expect(safeExternalUrl({ url: "https://example.test" })).toBeUndefined();
  });

  it("refuses a scheme-relative or relative string", () => {
    expect(safeExternalUrl("//example.test/x")).toBeUndefined();
    expect(safeExternalUrl("/local/path")).toBeUndefined();
    expect(safeExternalUrl("not a url")).toBeUndefined();
  });

  describe("red rows", () => {
    const RED_ROWS = [
      "http://2130706433/", // decimal-encoded IPv4 (127.0.0.1)
      "http://0x7f.1/", // hex/numeric labels
      "http://0177.0.0.1/", // octal-looking (still purely numeric) IPv4
      "http://[::ffff:127.0.0.1]/", // IPv4-mapped IPv6
      "http://[::]/", // unspecified IPv6
      "http://0.0.0.0/", // unspecified IPv4
      "http://app.localhost/", // *.localhost
      "http://localhost/",
      "http://exa mple.com/", // space
      "http://user@example.com/", // userinfo
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,hi",
      "ftp://example.test/file",
      "https://user:pass@example.test",
      // every previously red row (task-7-review.md Minor: loopback/link-local/control):
      "https://127.0.0.1:9000/api",
      "http://127.5.5.5/x",
      "https://[::1]:8443/",
      "https://[::1]/",
      "http://localhost:3000",
      "http://LOCALHOST",
      "http://169.254.169.254/latest/meta-data",
      "https://[fe80::1]/",
      "https://[FE80::1]/",
      "https://exa mple.test",
      "https://example.test\t.evil.test",
      "https://example.test\u0000.evil.test",
      // review r0 Important 2: hasControlOrSpace let anything >= 0x7f
      // through — a space in the path (not just the authority), two
      // zero-width/invisible non-ASCII characters, a soft hyphen, and an
      // IDN host all used to slip past.
      "https://example.com/a b", // space in the path
      "https://example.com/﻿", // U+FEFF zero-width no-break space (BOM)
      "https://example.com/​", // U+200B zero-width space
      "https://example.com/­", // U+00AD soft hyphen
      "https://müncheñ.example.com/", // IDN host (non-ASCII)
    ];

    it.each(RED_ROWS)("refuses %s", (row) => {
      expect(safeExternalUrl(row)).toBeUndefined();
    });
  });

  describe("green rows", () => {
    const GREEN_ROWS = [
      "https://example.com/path?q=1",
      "http://sub.example.co.uk/",
      "https://x-y.example.com:8443/",
      "https://chat.example.test:8443/room",
      // M12 Task 12 minor: percent-encoding in a query string is ordinary,
      // valid URL syntax — the raw string carries no literal space or
      // control character (hasControlOrSpace never sees one), so it must
      // not be refused just because the query happens to encode one.
      "https://example.com/search?q=hello%20world&redirect=%2Fhome",
    ];

    it.each(GREEN_ROWS)("accepts %s", (row) => {
      expect(safeExternalUrl(row)).toBe(row);
    });

    it(
      "allows a numeric-looking TLD-bearing host but refuses a purely numeric/hex " +
        "label anywhere in it " +
        "[bite-proof: allow numeric labels; 0x7f.1 goes green]",
      () => {
        expect(safeExternalUrl("http://0x7f.1/")).toBeUndefined();
        expect(safeExternalUrl("https://sub1.example.com/")).toBe("https://sub1.example.com/");
      },
    );
  });
});

describe("parseTerminalPanes", () => {
  it("drops a malformed entry rather than the whole list", () => {
    expect(
      parseTerminalPanes([
        { paneKey: "tab-1", exited: false },
        { paneKey: 5, exited: false },
        { exited: true },
        "nope",
        { paneKey: "tab-1:p1", exited: true },
      ]),
    ).toEqual([
      { paneKey: "tab-1", exited: false },
      { paneKey: "tab-1:p1", exited: true },
    ]);
  });

  it("returns an empty list for a non-array reply", () => {
    expect(parseTerminalPanes(undefined)).toEqual([]);
    expect(parseTerminalPanes({ paneKey: "tab-1" })).toEqual([]);
  });
});

// [bite-proof] the terminal screen's own route-param guard: a paneKey a
// deep link (or a stale in-app route) names must resolve against the
// current inventory, never fall back to "the first pane" or any other
// guess.
//
// Honest relabel (task-7-review.md Important 4): this is a helper-level
// test only — app/terminal/[paneKey].tsx's own "pane not found in
// inventory -> phase stays notFound, nothing subscribes" branch has no
// screen-level test of its own, because apps/mobile/vitest.config.mts's
// `test.include` is `src/**/*.test.ts` only; nothing under app/ is
// collected, so there is no practical way to render that screen here.
// What this test proves is the one thing the screen's guard is built on —
// resolvePane(panes, paneKey) really does return undefined for a pane the
// inventory doesn't contain — and the screen (see its own "checking"/
// "notFound" phase handling and the comment beside its validation
// useFocusEffect) is read code, not tested code, for the "never subscribe"
// half of that branch.
describe("resolvePane", () => {
  const PANES = [
    { paneKey: "tab-1", exited: false },
    { paneKey: "tab-1:p1", exited: true },
  ];

  it("finds an exact paneKey match, including a split pane's id", () => {
    expect(resolvePane(PANES, "tab-1:p1")).toEqual({ paneKey: "tab-1:p1", exited: true });
  });

  it("returns undefined for a pane not in the inventory", () => {
    expect(resolvePane(PANES, "tab-1:p2")).toBeUndefined();
  });

  it("returns undefined for an empty inventory", () => {
    expect(resolvePane([], "tab-1")).toBeUndefined();
  });
});

describe("listChatNames / resolveChatUrl", () => {
  it("lists configured chat names for a project", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: ["Team", "Support"] });

    const names = await listChatNames(fake.client, "acme");

    expect(fake.callLog).toEqual([
      { channel: "chat:names", args: ["acme"], options: { whenNotOpen: "reject" } },
    ]);
    expect(names).toEqual(["Team", "Support"]);
  });

  it("returns no names on an RPC failure rather than throwing", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: false, error: { kind: "offline" } });

    expect(await listChatNames(fake.client, "acme")).toEqual([]);
  });

  it("resolves a chat name to a validated URL", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: { ok: true, value: "https://chat.example.test/team" } });

    const url = await resolveChatUrl(fake.client, "acme", "Team");

    expect(fake.callLog).toEqual([
      { channel: "chat:open", args: ["acme", "Team"], options: { whenNotOpen: "reject" } },
    ]);
    expect(url).toBe("https://chat.example.test/team");
  });

  it("refuses a chat URL that fails safeExternalUrl instead of opening it", async () => {
    const fake = createFakeClient();
    fake.queueResult({
      ok: true,
      value: { ok: true, value: "https://user:pass@chat.example.test" },
    });

    expect(await resolveChatUrl(fake.client, "acme", "Team")).toBeUndefined();
  });

  it("resolves to undefined on the handler's own refusal", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: { ok: false, text: "no such chat" } });

    expect(await resolveChatUrl(fake.client, "acme", "Team")).toBeUndefined();
  });

  it("resolves to undefined on an RPC failure", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: false, error: { kind: "timeout" } });

    expect(await resolveChatUrl(fake.client, "acme", "Team")).toBeUndefined();
  });

  it("rejects an offline tap without queueing or opening after reconnect", async () => {
    const fake = createFakeClient();
    fake.setState("closed");

    await expect(resolveChatUrl(fake.client, "acme", "Team")).resolves.toBeUndefined();
    expect(fake.callLog).toEqual([
      { channel: "chat:open", args: ["acme", "Team"], options: { whenNotOpen: "reject" } },
    ]);
    expect(fake.pendingCallCount()).toBe(0);

    fake.setState("open");
    expect(fake.callLog).toHaveLength(1);
  });
});
