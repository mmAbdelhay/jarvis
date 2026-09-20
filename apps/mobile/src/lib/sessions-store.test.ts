// Tests for the session table store (Task 7): a real RpcClient (Task 3)
// driven through a fake transport, per global-constraints.md's testing
// rules (no real network, no fake-client shortcut for wire behaviour).
// See the mobile milestone 7, task 7 plan (docs/superpowers/plans).

import { PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock";
import { createDashboardStore } from "./dashboard-store";
import type { FakeSocket } from "./fake-transport";
import { createFakeTransport } from "./fake-transport";
import type { Credential, Endpoint } from "./rpc-client";
import { createRpcClient } from "./rpc-client";
import type { SessionRowView, SessionsView } from "./sessions-store";
import { createSessionsStore, parseSessionList, sessionLabelOf } from "./sessions-store";

const ENDPOINT: Endpoint = { host: "192.168.1.5", port: 4317, fingerprint: "a".repeat(64) };
const CREDENTIAL: Credential = { deviceId: "d".repeat(32), token: "T".repeat(43) };

function createEnv() {
  const transport = createFakeTransport();
  const clock = createFakeClock();
  const logs: string[] = [];
  const client = createRpcClient({
    transport,
    clock,
    random: () => 0.5,
    client: "jarvis-mobile-test",
    log: (line) => logs.push(line),
  });
  return { transport, clock, logs, client };
}

function latestSocket(transport: ReturnType<typeof createFakeTransport>): FakeSocket {
  const socket = transport.sockets[transport.sockets.length - 1];
  if (!socket) throw new Error("no socket opened");
  return socket;
}

function completeHandshake(
  transport: ReturnType<typeof createFakeTransport>,
  capabilities: string[] = ["sessions:update"],
): FakeSocket {
  const socket = latestSocket(transport);
  socket.emit({ kind: "open" });
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities }),
  });
  return socket;
}

type ParsedFrame = { t: string; [key: string]: unknown };

function parsedFrames(socket: FakeSocket): ParsedFrame[] {
  return socket.sent.map((s) => JSON.parse(s) as ParsedFrame);
}

function reqFrames(socket: FakeSocket): ParsedFrame[] {
  return parsedFrames(socket).filter((f) => f.t === "req");
}

/** `RpcClient.call`'s promise resolves synchronously but the store's own
 * `.then` only runs as a microtask — flush it before asserting. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function answerReq(socket: FakeSocket, id: number, value: unknown): Promise<void> {
  socket.emit({ kind: "message", text: encodeMessage({ t: "res", id, v: value }) });
  await flush();
}

function rowPayload(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "s1",
    project: "acme",
    projectPath: "/Users/x/acme",
    agentId: "claude-main",
    state: "running",
    summary: "fixing tests",
    // The real `sessions:list`/`sessions:update` wire payload is a full
    // `Session[]` (packages/desktop/src/ipc.ts) — `startedAt` is a
    // required field there, and session-parse.ts's shared `parseSession`
    // now enforces it here too.
    startedAt: 50,
    lastActivityAt: 100,
    ...overrides,
  };
}

describe("parseSessionList", () => {
  it("parses a well-formed row, deriving label via sessionLabelOf", () => {
    const rows = parseSessionList([rowPayload()]);
    expect(rows).toEqual([
      {
        id: "s1",
        label: "acme",
        summary: "fixing tests",
        state: "running",
        agentId: "claude-main",
        startedAt: 50,
        lastActivityAt: 100,
      },
    ]);
  });

  it("keeps endedAt when present and finite", () => {
    const rows = parseSessionList([rowPayload({ state: "done", endedAt: 500 })]);
    expect(rows[0]?.endedAt).toBe(500);
  });

  it("keeps origin when present", () => {
    const rows = parseSessionList([rowPayload({ id: "ext-1", origin: "external" })]);
    expect(rows[0]?.origin).toBe("external");
  });

  it('omits origin for an ordinary row rather than defaulting it to "jarvis"', () => {
    const rows = parseSessionList([rowPayload()]);
    expect(rows[0]?.origin).toBeUndefined();
  });

  it("skips a row with a bad state, a bad id, or a missing summary; extra fields are not copied", () => {
    const rows = parseSessionList([
      rowPayload({ state: "zombie" }),
      rowPayload({ id: "a b" }),
      rowPayload({ summary: undefined }),
      rowPayload({ id: "s2", extra: "nope", another: 1 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] as object).sort()).toEqual(
      ["agentId", "id", "label", "lastActivityAt", "startedAt", "state", "summary"].sort(),
    );
  });

  it("returns [] for a non-array value", () => {
    expect(parseSessionList(null)).toEqual([]);
    expect(parseSessionList({})).toEqual([]);
  });
});

describe("sessionLabelOf", () => {
  it("falls back through project -> projectPath segment -> empty string", () => {
    expect(sessionLabelOf(null, "/Users/x/proj")).toBe("proj");
    expect(sessionLabelOf(null, "C:\\a\\b\\")).toBe("b");
    expect(sessionLabelOf("acme", "/x")).toBe("acme");
    expect(sessionLabelOf(7, 7)).toBe("");
  });
});

describe("createSessionsStore: focus/blur", () => {
  it("focus subscribes sessions:update and calls sessions:list; the answer fills active/ended", async () => {
    const { client, transport } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const store = createSessionsStore({ client });

    store.focus();

    const frames = parsedFrames(socket);
    expect(frames.filter((f) => f.t === "sub")).toEqual([{ t: "sub", add: ["sessions:update"] }]);
    const reqs = reqFrames(socket);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ t: "req", ch: "sessions:list", a: [] });

    await answerReq(socket, reqs[0]?.id as number, [
      rowPayload({ id: "active-old", state: "running", lastActivityAt: 10 }),
      rowPayload({ id: "active-new", state: "waiting", lastActivityAt: 20 }),
      rowPayload({ id: "ended-old", state: "done", lastActivityAt: 5, endedAt: 30 }),
      rowPayload({ id: "ended-new", state: "dead", lastActivityAt: 5, endedAt: 40 }),
    ]);

    const view: SessionsView = store.get();
    expect(view.active.map((r) => r.id)).toEqual(["active-new", "active-old"]);
    expect(view.ended.map((r) => r.id)).toEqual(["ended-new", "ended-old"]);
    expect(view.loading).toBe(false);
  });

  it("a push before the stale list answer wins [bite-proof: drop the version check; the stale list overwrites]", async () => {
    const { client, transport } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const store = createSessionsStore({ client });

    store.focus();
    const reqs = reqFrames(socket);
    expect(reqs).toHaveLength(1);
    const listId = reqs[0]?.id as number;

    // A sessions:update push arrives first, replacing the rows.
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "sessions:update",
        seq: 1,
        p: [rowPayload({ id: "from-push", state: "running", lastActivityAt: 999 })],
      }),
    });
    expect(store.get().active.map((r) => r.id)).toEqual(["from-push"]);

    // The older sessions:list answer arrives after — it must not clobber
    // the push's rows.
    await answerReq(socket, listId, [
      rowPayload({ id: "from-list", state: "running", lastActivityAt: 1 }),
    ]);

    expect(store.get().active.map((r) => r.id)).toEqual(["from-push"]);
    // Fix round 1 (Important 1 / Minor 4): the superseded answer still
    // clears loading — it only skips the rows.
    expect(store.get().loading).toBe(false);
  });

  it("an older refresh() answer does not overwrite a newer refresh()'s rows [bite-proof: read rowsVersion instead of incrementing it; the stale answer overwrites]", async () => {
    const { client, transport } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const store = createSessionsStore({ client });

    // focus() starts refresh #1's sessions:list request.
    store.focus();
    const firstReqs = reqFrames(socket);
    expect(firstReqs).toHaveLength(1);

    // A second refresh() (e.g. pull-to-refresh) starts while #1 is still
    // in flight.
    void store.refresh();
    const bothReqs = reqFrames(socket);
    expect(bothReqs).toHaveLength(2);

    // The newer request (#2) answers first.
    await answerReq(socket, bothReqs[1]?.id as number, [
      rowPayload({ id: "from-second", state: "running", lastActivityAt: 2 }),
    ]);
    expect(store.get().active.map((r) => r.id)).toEqual(["from-second"]);

    // The older request (#1) answers late — it must not clobber #2's rows.
    await answerReq(socket, bothReqs[0]?.id as number, [
      rowPayload({ id: "from-first", state: "running", lastActivityAt: 1 }),
    ]);

    expect(store.get().active.map((r) => r.id)).toEqual(["from-second"]);
    expect(store.get().loading).toBe(false);
  });

  it(
    "M12 Task 8 (M7 T7): a refresh() superseded by a later refresh() leaves loading " +
      "true until the newest one's own answer lands, even if the superseded one " +
      "answers first " +
      "[bite-proof: one shared counter for rows and loading; the superseded, " +
      "earlier-answering call clears loading on its own]",
    async () => {
      const { client, transport } = createEnv();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport);
      const store = createSessionsStore({ client });

      store.focus(); // refresh #1
      const firstReqs = reqFrames(socket);
      expect(firstReqs).toHaveLength(1);

      void store.refresh(); // refresh #2, supersedes #1
      const bothReqs = reqFrames(socket);
      expect(bothReqs).toHaveLength(2);

      // The *older*, superseded request answers first.
      await answerReq(socket, bothReqs[0]?.id as number, [
        rowPayload({ id: "from-first", state: "running", lastActivityAt: 1 }),
      ]);
      expect(store.get().loading).toBe(true); // still waiting on the newest refresh
      expect(store.get().active.map((r) => r.id)).toEqual([]); // stale rows never applied

      // The newest request answers — only now does loading clear.
      await answerReq(socket, bothReqs[1]?.id as number, [
        rowPayload({ id: "from-second", state: "running", lastActivityAt: 2 }),
      ]);
      expect(store.get().loading).toBe(false);
      expect(store.get().active.map((r) => r.id)).toEqual(["from-second"]);
    },
  );

  it("an ok answer superseded by a push still clears a stale error (rule 3: ok-stale clears error)", async () => {
    const { client, transport } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const store = createSessionsStore({ client });

    store.focus();
    const reqs = reqFrames(socket);
    // The first answer fails, setting an error.
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "err",
        id: reqs[0]?.id as number,
        code: "internal",
        text: "boom",
        language: "en",
      }),
    });
    await flush();
    expect(store.get().error).toBeDefined();

    // A manual refresh starts...
    void store.refresh();
    const secondReqs = reqFrames(socket);
    const refreshReqId = secondReqs[secondReqs.length - 1]?.id as number;

    // ...but a push supersedes its rows before it answers.
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "sessions:update",
        seq: 1,
        p: [rowPayload({ id: "from-push", state: "running", lastActivityAt: 5 })],
      }),
    });
    await flush();

    // The superseded refresh's own answer is still ok — it clears the
    // stale error even though its rows are never applied.
    await answerReq(socket, refreshReqId, [
      rowPayload({ id: "from-refresh", state: "running", lastActivityAt: 1 }),
    ]);

    expect(store.get().error).toBeUndefined();
    expect(store.get().active.map((r) => r.id)).toEqual(["from-push"]);
  });

  it("blur: no sub drop while the Dashboard store still holds sessions:update; drop once both blur", async () => {
    const { client, transport } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);

    // Fix round 1 (Minor 3): the Dashboard store's own hold on the same
    // channel (Task 3 ref-counting, ruling 16), via a real dashboard store
    // rather than a raw client.subscribe call.
    const dashboardStore = createDashboardStore({ client });
    dashboardStore.focus();

    const store = createSessionsStore({ client });
    store.focus();
    await flush();

    store.blur();
    expect(parsedFrames(socket).some((f) => f.t === "sub" && "drop" in f)).toBe(false);

    dashboardStore.blur(); // the Dashboard store's own blur()
    const dropFrames = parsedFrames(socket).filter(
      (f) =>
        f.t === "sub" && "drop" in f && Array.isArray(f.drop) && f.drop.includes("sessions:update"),
    );
    expect(dropFrames).toHaveLength(1);
  });

  it("reconnect (state back to open) calls sessions:list again", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket1 = completeHandshake(transport);
    const store = createSessionsStore({ client });

    store.focus();
    const firstReqs = reqFrames(socket1);
    expect(firstReqs).toHaveLength(1);
    await answerReq(socket1, firstReqs[0]?.id as number, []);

    socket1.emit({ kind: "close", code: 1006, reason: "dropped" });
    clock.advance(1_000);
    const socket2 = completeHandshake(transport);
    await flush();

    const secondReqs = reqFrames(socket2);
    expect(secondReqs).toHaveLength(1);
    expect(secondReqs[0]).toMatchObject({ t: "req", ch: "sessions:list", a: [] });
  });

  it("an err result populates error with the server text unchanged", async () => {
    const { client, transport } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const store = createSessionsStore({ client });

    store.focus();
    const reqs = reqFrames(socket);
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "err",
        id: reqs[0]?.id as number,
        code: "internal",
        text: "القرص ممتلئ",
        language: "ar",
      }),
    });
    await flush();

    const view = store.get();
    expect(view.error).toEqual({
      kind: "remote",
      code: "internal",
      text: "القرص ممتلئ",
      language: "ar",
    });
    expect(view.loading).toBe(false);
  });
});

describe("createSessionsStore: pullToRefresh", () => {
  it("calls sessions:refresh, then re-lists via sessions:list", async () => {
    const { client, transport } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const store = createSessionsStore({ client });

    store.focus();
    const focusReqs = reqFrames(socket);
    await answerReq(socket, focusReqs[0]?.id as number, []);

    const pulled = store.pullToRefresh();
    const refreshReqs = reqFrames(socket).filter((f) => f.ch === "sessions:refresh");
    expect(refreshReqs).toHaveLength(1);

    await answerReq(socket, refreshReqs[0]?.id as number, {
      jarvis: 0,
      external: 1,
      importedTranscripts: 0,
    });

    const listReqs = reqFrames(socket).filter((f) => f.ch === "sessions:list");
    // The focus() call already issued one; pullToRefresh's own re-list is
    // the second.
    expect(listReqs).toHaveLength(2);
    await answerReq(socket, listReqs[1]?.id as number, [
      rowPayload({ id: "ext-1", origin: "external", state: "running" }),
    ]);
    await pulled;

    expect(store.get().active.map((r) => r.id)).toEqual(["ext-1"]);
    expect(store.get().active[0]?.origin).toBe("external");
  });

  it("surfaces a failed sessions:refresh as an error without re-listing", async () => {
    const { client, transport } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const store = createSessionsStore({ client });

    store.focus();
    const focusReqs = reqFrames(socket);
    await answerReq(socket, focusReqs[0]?.id as number, []);

    const pulled = store.pullToRefresh();
    const refreshReqs = reqFrames(socket).filter((f) => f.ch === "sessions:refresh");
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "err",
        id: refreshReqs[0]?.id as number,
        code: "internal",
        text: "boom",
        language: "en",
      }),
    });
    await flush();
    await pulled;

    expect(store.get().error).toBeDefined();
    const listReqs = reqFrames(socket).filter((f) => f.ch === "sessions:list");
    // Only focus()'s own request — the failed refresh call must not have
    // triggered a second sessions:list.
    expect(listReqs).toHaveLength(1);
  });
});

describe("createSessionsStore: find", () => {
  it("finds a row by id from the last applied rows", async () => {
    const { client, transport } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const store = createSessionsStore({ client });

    store.focus();
    const reqs = reqFrames(socket);
    await answerReq(socket, reqs[0]?.id as number, [rowPayload({ id: "s7" })]);

    const found: SessionRowView | undefined = store.find("s7");
    expect(found?.id).toBe("s7");
    expect(store.find("missing")).toBeUndefined();
  });
});
