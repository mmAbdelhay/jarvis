import { describe, expect, it } from "vitest";
import type { ApiAction } from "./api-store";
import {
  API_ACTION_BUSY,
  API_CAPABILITY_MISSING,
  createApiStore,
  parseApiSendResult,
  parseApiTree,
} from "./api-store";
import type { ClientState, RpcClient, RpcError, RpcResult } from "./rpc-client";

type Call = { channel: string; args: unknown[] };

function createHarness() {
  const calls: Call[] = [];
  const pending: Array<(result: RpcResult) => void> = [];
  let stateValue: ClientState = "open";
  const stateHandlers = new Set<(s: ClientState, detail: Record<string, unknown>) => void>();

  const client: RpcClient = {
    connect: () => {},
    disconnect: () => {},
    call: (channel, args) => {
      calls.push({ channel, args });
      return new Promise<RpcResult>((resolve) => {
        pending.push(resolve);
      });
    },
    upload: async () => ({ ok: false, error: { kind: "offline" } }),
    subscribe: () => ({ ok: true, value: undefined }),
    unsubscribe: () => {},
    onPush: () => () => {},
    onState: (fn) => {
      stateHandlers.add(fn);
      return () => stateHandlers.delete(fn);
    },
    state: () => stateValue,
    capabilities: () => [],
    subscriptions: () => [],
    lastFrameAt: () => undefined,
    setAppActive: () => {},
  };

  return {
    client,
    calls,
    /** Resolves the call at `index` (0-based, in call order) with `result`. */
    respondAt(index: number, result: RpcResult): void {
      const resolve = pending[index];
      if (resolve === undefined) throw new Error(`no pending call at index ${index}`);
      resolve(result);
    },
    /** Resolves the most recently issued still-pending call. */
    respondLast(result: RpcResult): void {
      const index = calls.length - 1;
      this.respondAt(index, result);
    },
    setClientState(next: ClientState): void {
      stateValue = next;
      for (const handler of [...stateHandlers]) handler(next, {});
    },
  };
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

function err(error: RpcError): RpcResult {
  return { ok: false, error };
}

function okView<T>(value: T) {
  return ok({ ok: true, value });
}

function failView(text: string, language: "ar" | "en" = "en") {
  return ok({ ok: false, text, language });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createApiStore: open/readTree/readRequest", () => {
  it("open() reads api:collections and sets the collections list", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    expect(h.calls).toEqual([{ channel: "api:collections", args: ["proj"] }]);

    h.respondLast(okView([{ name: "Acme", path: "/acme" }]));
    await settle();
    expect(store.get().phase).toBe("ready");
    expect(store.get().collections).toEqual([{ name: "Acme", path: "/acme" }]);
  });

  it("a remote failure on open() shows the server text verbatim", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(failView("no such project"));
    await settle();
    expect(store.get().phase).toBe("failed");
    expect(store.get().notice).toBe("no such project");
  });

  it("readTree() reads api:tree with [project, path] and sets the parsed tree", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();

    store.readTree("/acme");
    expect(h.calls.at(-1)).toEqual({ channel: "api:tree", args: ["proj", "/acme"] });
    const tree = {
      collection: { name: "Acme", path: "/acme" },
      root: { name: "Acme", path: "/acme", requests: [], folders: [] },
      environments: [],
    };
    h.respondLast(okView(tree));
    await settle();
    expect(store.get().tree).toEqual(tree);
    expect(store.get().treeLoading).toBe(false);
  });

  it("Tests: a stale tree reply (superseded by a newer readTree) is dropped, never overwriting the newer selection", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();

    store.readTree("/a"); // call index 1
    store.readTree("/b"); // call index 2 (supersedes /a)
    expect(store.get().selectedCollectionPath).toBe("/b");

    const staleTree = {
      collection: { name: "A", path: "/a" },
      root: { name: "A", path: "/a", requests: [], folders: [] },
      environments: [],
    };
    // The /a reply arrives late, after /b was already requested.
    h.respondAt(1, okView(staleTree));
    await settle();
    expect(store.get().tree).toBeUndefined(); // dropped, not applied

    const freshTree = {
      collection: { name: "B", path: "/b" },
      root: { name: "B", path: "/b", requests: [], folders: [] },
      environments: [],
    };
    h.respondAt(2, okView(freshTree));
    await settle();
    expect(store.get().tree).toEqual(freshTree);
  });

  it("readRequest() reads api:request with [project, path] and seeds request/draft, dirty false", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();

    store.readRequest("/acme/get.bru");
    expect(h.calls.at(-1)).toEqual({ channel: "api:request", args: ["proj", "/acme/get.bru"] });
    h.respondLast(okView({ http: { method: "get", url: "https://x" } }));
    await settle();
    expect(store.get().request).toEqual({ http: { method: "get", url: "https://x" } });
    expect(store.get().draft).toEqual({ http: { method: "get", url: "https://x" } });
    expect(store.get().dirty).toBe(false);
  });

  it("Tests: an edited (dirty) draft survives a stale readRequest reply for a request the user has since navigated away from", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();

    store.readRequest("/a.bru"); // call index 1
    h.respondAt(1, okView({ http: { method: "get", url: "https://a" } }));
    await settle();

    store.setDraft({ http: { method: "post", url: "https://a/edited" } });
    expect(store.get().dirty).toBe(true);

    // User navigates to a different request; that read is still in flight
    // when a *third*, unrelated background call (a stale reply for the
    // very first readRequest, reissued) would otherwise land.
    store.readRequest("/b.bru"); // call index 2
    // Simulate a duplicate/late reply for the now-superseded /a.bru read
    // landing after the draft was edited and after navigation moved on —
    // it must never overwrite the dirty draft for /b.
    h.respondAt(1, okView({ http: { method: "get", url: "https://a/late-duplicate" } }));
    await settle();
    expect(store.get().draft).toEqual({ http: { method: "post", url: "https://a/edited" } });
  });

  it("setVariables() replaces the variables map without touching draft/dirty", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();

    store.setVariables({ base: "https://api.acme.test" });
    expect(store.get().variables).toEqual({ base: "https://api.acme.test" });
    expect(store.get().dirty).toBe(false);
  });
});

describe("createApiStore: invoke() — send", () => {
  it("sends the draft (falling back to the last loaded request) and variables; a successful send updates lastResponse/history/cookies", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();
    store.setDraft({ http: { method: "get", url: "https://x" } });
    store.setVariables({ base: "https://x" });

    const pending = store.invoke({ kind: "send" });
    expect(h.calls.at(-1)).toEqual({
      channel: "api:send",
      args: ["proj", { http: { method: "get", url: "https://x" } }, { base: "https://x" }],
    });

    const sendResult = {
      response: {
        status: 200,
        statusText: "OK",
        headers: {},
        body: "{}",
        timeMs: 12,
        bytes: 2,
        unresolved: [],
      },
      assertions: [],
      history: [
        {
          at: 1,
          name: "get",
          method: "GET",
          url: "https://x",
          status: 200,
          timeMs: 12,
          bytes: 2,
          bodyPreview: "{}",
        },
      ],
      cookies: [],
    };
    h.respondLast(okView(sendResult));
    await pending;
    expect(store.get().lastResponse).toEqual(sendResult);
    expect(store.get().history).toEqual(sendResult.history);
    expect(store.get().busy).toBe(false);
  });

  it("Tests: request errors (an ApiFailure response) are distinct from transport errors — the response still lands in lastResponse, not as a notice", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();

    const pending = store.invoke({ kind: "send" });
    const sendResult = {
      response: { failed: true, detail: "getaddrinfo ENOTFOUND", timeMs: 5 },
      assertions: [],
      history: [],
      cookies: [],
    };
    h.respondLast(okView(sendResult));
    await pending;
    expect(store.get().lastResponse?.response).toEqual({
      failed: true,
      detail: "getaddrinfo ENOTFOUND",
      timeMs: 5,
    });
    expect(store.get().notice).toBeUndefined();
    expect(store.get().uncertain).toBe(false);
  });

  it("Tests: a transport-level offline/timeout on send is uncertain (never shown as a response) and refreshes history", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();

    const pending = store.invoke({ kind: "send" });
    h.respondLast(err({ kind: "timeout" }));
    await pending;
    expect(store.get().uncertain).toBe(true);
    expect(store.get().lastResponse).toBeUndefined();
    // Behaviour rule 5: authoritative data (history) is refreshed so the
    // user can tell whether the request actually landed before acting again.
    expect(h.calls.at(-1)).toEqual({ channel: "api:history", args: ["proj"] });
    h.respondLast(okView([]));
    await settle();
  });

  it("Tests: capability missing (unsupported) shows an explicit refusal, never optimistic success", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();

    const pending = store.invoke({ kind: "send" });
    h.respondLast(err({ kind: "unsupported" }));
    await pending;
    expect(store.get().notice).toBe(API_CAPABILITY_MISSING);
    expect(store.get().lastResponse).toBeUndefined();
  });
});

describe("createApiStore: invoke() — save", () => {
  it("saves [project, path, draft]; success re-reads and adopts the laptop's on-disk request", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();
    store.readRequest("/a.bru");
    h.respondLast(okView({ http: { method: "get" } }));
    await settle();
    store.setDraft({ http: { method: "post" } });

    const pending = store.invoke({ kind: "save" });
    expect(h.calls.at(-1)).toEqual({
      channel: "api:save",
      args: ["proj", "/a.bru", { http: { method: "post" } }],
    });
    h.respondLast(okView(undefined));
    await settle();
    expect(h.calls.at(-1)).toEqual({ channel: "api:request", args: ["proj", "/a.bru"] });
    const laptopRequest = { http: { method: "post" }, meta: { seq: 7 } };
    h.respondLast(okView(laptopRequest));
    await pending;
    expect(store.get().dirty).toBe(false);
    expect(store.get().request).toEqual(laptopRequest);
  });

  it("does nothing (and never calls the client) when there is no selected request", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();
    const callsBefore = h.calls.length;
    await store.invoke({ kind: "save" });
    expect(h.calls).toHaveLength(callsBefore);
    expect(store.get().busy).toBe(false);
  });

  it("navigating to a different request while a save is in flight drops that save's re-read [bite-proof: drop the path/generation check]", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();

    store.readRequest("/a.bru");
    h.respondLast(okView({ http: { method: "get" } }));
    await settle();
    store.setDraft({ http: { method: "post" } });

    const pending = store.invoke({ kind: "save" });
    const saveCallIndex = h.calls.length - 1;
    expect(h.calls[saveCallIndex]).toEqual({
      channel: "api:save",
      args: ["proj", "/a.bru", { http: { method: "post" } }],
    });

    // The user navigates to a different request while /a's save is still
    // in flight.
    store.readRequest("/b.bru");
    const bReadIndex = h.calls.length - 1;
    h.respondAt(bReadIndex, okView({ http: { method: "get", url: "https://b" } }));
    await settle();
    expect(store.get().selectedRequestPath).toBe("/b.bru");
    expect(store.get().request).toEqual({ http: { method: "get", url: "https://b" } });

    const callsBeforeSaveLands = h.calls.length;
    h.respondAt(saveCallIndex, okView(undefined));
    await pending;
    await settle();

    // /a's save answer never triggers a re-read (it would land under /b).
    expect(h.calls).toHaveLength(callsBeforeSaveLands);
    expect(store.get().selectedRequestPath).toBe("/b.bru");
    expect(store.get().request).toEqual({ http: { method: "get", url: "https://b" } });
    expect(store.get().draft).toEqual({ http: { method: "get", url: "https://b" } });
    expect(store.get().busy).toBe(false);
  });

  it("keystrokes typed while a save's re-read is in flight are never clobbered [bite-proof: always overwrite draft]", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();

    store.readRequest("/a.bru");
    h.respondLast(okView({ http: { method: "get" } }));
    await settle();
    store.setDraft({ http: { method: "post" } });

    const pending = store.invoke({ kind: "save" });
    const saveIndex = h.calls.length - 1;
    h.respondAt(saveIndex, okView(undefined));
    await settle();
    const readIndex = h.calls.length - 1;
    expect(h.calls[readIndex]).toEqual({ channel: "api:request", args: ["proj", "/a.bru"] });

    // The user keeps typing while the post-save re-read is still in flight.
    store.setDraft({ http: { method: "put" } });

    h.respondAt(readIndex, okView({ http: { method: "post" }, meta: { seq: 9 } }));
    await pending;

    expect(store.get().draft).toEqual({ http: { method: "put" } });
    expect(store.get().dirty).toBe(true);
    expect(store.get().request).toEqual({ http: { method: "post" }, meta: { seq: 9 } });
    expect(store.get().busy).toBe(false);
  });

  it("a failed re-read after a successful save keeps dirty:true and shows the stale notice", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();

    store.readRequest("/a.bru");
    h.respondLast(okView({ http: { method: "get" } }));
    await settle();
    store.setDraft({ http: { method: "post" } });

    const pending = store.invoke({ kind: "save" });
    h.respondLast(okView(undefined));
    await settle();
    expect(h.calls.at(-1)).toEqual({ channel: "api:request", args: ["proj", "/a.bru"] });
    h.respondLast(
      err({ kind: "remote", code: "internal", text: "laptop offline", language: "en" }),
    );
    await pending;

    expect(store.get().dirty).toBe(true);
    expect(store.get().stale).toBe(true);
    expect(store.get().notice).toBe("laptop offline");
    expect(store.get().busy).toBe(false);
  });

  it("busy clears via finally when the api:save call itself fails outright", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();

    store.readRequest("/a.bru");
    h.respondLast(okView({ http: { method: "get" } }));
    await settle();
    store.setDraft({ http: { method: "post" } });

    const callsBeforeSave = h.calls.length;
    const pending = store.invoke({ kind: "save" });
    h.respondLast(err({ kind: "offline" }));
    await pending;

    expect(store.get().busy).toBe(false);
    expect(store.get().uncertain).toBe(true);
    // The failed save's own api:save call is the only new call — no re-read.
    expect(h.calls).toHaveLength(callsBeforeSave + 1);
    expect(h.calls.at(-1)?.channel).toBe("api:save");
  });
});

describe("createApiStore: invoke() — every ApiAction maps exact channel and arguments", () => {
  const cases: Array<{
    setup?: (store: ReturnType<typeof createApiStore>) => void;
    action: ApiAction;
    channel: string;
    args: unknown[];
  }> = [
    { action: { kind: "curl" }, channel: "api:curl", args: ["proj", {}, {}] },
    { action: { kind: "history" }, channel: "api:history", args: ["proj"] },
    { action: { kind: "clearHistory" }, channel: "api:clearHistory", args: ["proj"] },
    { action: { kind: "cookies" }, channel: "api:cookies", args: ["proj"] },
    { action: { kind: "clearCookies" }, channel: "api:clearCookies", args: ["proj"] },
    {
      action: { kind: "removeCookie", name: "sid", domain: "x.test", path: "/" },
      channel: "api:removeCookie",
      args: ["proj", "sid", "x.test", "/"],
    },
    { action: { kind: "settings" }, channel: "api:settings", args: ["proj"] },
    {
      action: { kind: "createRequest", folderPath: "/f", name: "New", seq: 3 },
      channel: "api:createRequest",
      args: ["proj", "/f", "New", 3],
    },
    {
      action: { kind: "createFolder", parentPath: "/f", name: "Sub" },
      channel: "api:createFolder",
      args: ["proj", "/f", "Sub"],
    },
    {
      action: { kind: "rename", path: "/f/x.bru", name: "Y", isFolder: false },
      channel: "api:rename",
      args: ["proj", "/f/x.bru", "Y", false],
    },
    {
      action: { kind: "delete", path: "/f/x.bru" },
      channel: "api:delete",
      args: ["proj", "/f/x.bru"],
    },
    {
      action: { kind: "createCollection", name: "New Collection" },
      channel: "api:createCollection",
      args: ["proj", "New Collection"],
    },
    {
      action: {
        kind: "saveEnvironment",
        collectionPath: "/f",
        name: "dev",
        variables: [{ name: "base", value: "x", enabled: true, secret: false }],
      },
      channel: "api:saveEnvironment",
      args: ["proj", "/f", "dev", [{ name: "base", value: "x", enabled: true, secret: false }]],
    },
    {
      action: { kind: "importPostman", name: "Imported", collection: { info: {} } },
      channel: "api:importPostman",
      args: ["proj", "Imported", { info: {} }],
    },
  ];

  for (const testCase of cases) {
    it(`ApiAction "${testCase.action.kind}" -> ${testCase.channel} with exact args`, async () => {
      const h = createHarness();
      const store = createApiStore({ client: h.client });
      store.open("proj");
      h.respondLast(okView([]));
      await settle();

      const pending = store.invoke(testCase.action);
      expect(h.calls.at(-1)).toEqual({ channel: testCase.channel, args: testCase.args });
      // Every one of these resolves a GitViewResult; a bare successful
      // value/void/array all decode fine through the store's own parsers.
      h.respondLast(
        okView(
          testCase.channel === "api:settings"
            ? { proxyUrl: "", verifyCertificate: true, timeoutMs: 1000 }
            : [],
        ),
      );
      await pending;
      expect(store.get().busy).toBe(false);
    });
  }
});

describe("createApiStore: busy guard and reconnect", () => {
  it("Tests: invoke() while an action is already in flight shows API_ACTION_BUSY and issues no second call", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();

    const first = store.invoke({ kind: "history" });
    const callsAfterFirst = h.calls.length;
    await store.invoke({ kind: "cookies" });
    expect(h.calls).toHaveLength(callsAfterFirst); // no second api:cookies call
    expect(store.get().notice).toBe(API_ACTION_BUSY);

    h.respondLast(okView([]));
    await first;
  });

  it("Tests: reconnect (client.onState -> open) refreshes only the collections list, never sends", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();

    h.setClientState("reconnecting");
    h.setClientState("open");
    expect(h.calls.at(-1)).toEqual({ channel: "api:collections", args: ["proj"] });
    expect(h.calls.some((c) => c.channel === "api:send")).toBe(false);
    h.respondLast(okView([]));
    await settle();
  });

  it("close() unsubscribes from reconnect refreshes", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();
    store.close();

    const callsBefore = h.calls.length;
    h.setClientState("reconnecting");
    h.setClientState("open");
    expect(h.calls).toHaveLength(callsBefore);
  });

  it("Tests (I3): a dirty draft and the current selection survive close() then open() of the same project [bite-proof: drop the same-project check in open(); draft/selection reset instead]", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([]));
    await settle();

    store.readRequest("/a.bru");
    h.respondLast(okView({ http: { method: "get", url: "https://a" } }));
    await settle();
    store.setDraft({ http: { method: "post", url: "https://a/edited" } });
    store.readTree("/collection");
    const tree = {
      collection: { name: "Acme", path: "/collection" },
      root: { name: "Acme", path: "/collection", requests: [], folders: [] },
      environments: [],
    };
    h.respondLast(okView(tree));
    await settle();

    // Blur (the screen's useFocusEffect cleanup) then refocus the same
    // project — neither the dirty draft, the selection nor the tree is
    // discarded.
    store.close();
    store.open("proj");
    expect(store.get().draft).toEqual({ http: { method: "post", url: "https://a/edited" } });
    expect(store.get().dirty).toBe(true);
    expect(store.get().selectedRequestPath).toBe("/a.bru");
    expect(store.get().selectedCollectionPath).toBe("/collection");
    expect(store.get().tree).toEqual(tree);

    // open() still refreshes the collections list in the background.
    expect(h.calls.at(-1)).toEqual({ channel: "api:collections", args: ["proj"] });
  });

  it("Tests (I3): open() for a *different* project still resets the view (draft, selection, tree)", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj-a");
    h.respondLast(okView([]));
    await settle();
    store.readRequest("/a.bru");
    h.respondLast(okView({ http: { method: "get" } }));
    await settle();
    store.setDraft({ http: { method: "post" } });

    store.close();
    store.open("proj-b");
    expect(store.get().draft).toBeUndefined();
    expect(store.get().dirty).toBe(false);
    expect(store.get().selectedRequestPath).toBeUndefined();
    expect(store.get().phase).toBe("loading");
  });

  it("Tests (I3): refresh() re-reads collections (and the selected tree) without resetting the draft/selection", async () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.open("proj");
    h.respondLast(okView([{ name: "Old", path: "/old" }]));
    await settle();
    store.readTree("/old");
    h.respondLast(
      okView({
        collection: { name: "Old", path: "/old" },
        root: { name: "Old", path: "/old", requests: [], folders: [] },
        environments: [],
      }),
    );
    await settle();
    store.readRequest("/old/get.bru");
    h.respondLast(okView({ http: { method: "get" } }));
    await settle();
    store.setDraft({ http: { method: "post" } });

    store.refresh();
    // Two calls: a fresh api:collections and a fresh api:tree for the
    // still-selected collection — never api:request (the draft is never
    // silently reloaded out from under the user).
    const refreshCalls = h.calls.slice(-2).map((c) => c.channel);
    expect(refreshCalls.sort()).toEqual(["api:collections", "api:tree"]);
    expect(store.get().draft).toEqual({ http: { method: "post" } });
    expect(store.get().dirty).toBe(true);
    expect(store.get().selectedRequestPath).toBe("/old/get.bru");

    h.respondAt(h.calls.length - 2, okView([{ name: "New", path: "/new" }]));
    h.respondAt(
      h.calls.length - 1,
      okView({
        collection: { name: "Old", path: "/old" },
        root: { name: "Old", path: "/old", requests: [], folders: [] },
        environments: [],
      }),
    );
    await settle();
    expect(store.get().collections).toEqual([{ name: "New", path: "/new" }]);
  });

  it("refresh() before any open() is a no-op", () => {
    const h = createHarness();
    const store = createApiStore({ client: h.client });
    store.refresh();
    expect(h.calls).toEqual([]);
  });
});

describe("api-store parsers", () => {
  it("parseApiTree rejects a malformed root folder", () => {
    expect(
      parseApiTree({ collection: { name: "A", path: "/a" }, root: {}, environments: [] }),
    ).toBeUndefined();
  });

  it("parseApiSendResult accepts an ApiFailure response and rejects a malformed one", () => {
    expect(
      parseApiSendResult({
        response: { failed: true, detail: "x", timeMs: 1 },
        assertions: [],
        history: [],
        cookies: [],
      }),
    ).toBeDefined();
    expect(
      parseApiSendResult({ response: { failed: true }, assertions: [], history: [], cookies: [] }),
    ).toBeUndefined();
  });
});
