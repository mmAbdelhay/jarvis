// Tests for the per-project Docker store (M9 Task 6) against a real
// RpcClient (Task 3) driven through a fake transport — same infrastructure
// as changes-store.test.ts.

import { PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock";
import type { FakeSocket } from "./fake-transport";
import { createFakeTransport } from "./fake-transport";
import type { Credential, Endpoint } from "./rpc-client";
import { createRpcClient } from "./rpc-client";
import { createDockerStore, parseDockerView } from "./docker-store";

const ENDPOINT: Endpoint = { host: "192.168.1.5", port: 4317, fingerprint: "a".repeat(64) };
const CREDENTIAL: Credential = { deviceId: "d".repeat(32), token: "T".repeat(43) };

const CAPS = [
  "docker:view",
  "docker:start",
  "docker:stop",
  "docker:restart",
  "docker:composeUp",
  "docker:composeDown",
];

function createEnv(capabilities = CAPS) {
  const transport = createFakeTransport();
  const clock = createFakeClock();
  const client = createRpcClient({
    transport,
    clock,
    random: () => 0.5,
    client: "jarvis-mobile-test",
    log: () => {},
  });
  client.connect(ENDPOINT, CREDENTIAL);
  const socket = latestSocket(transport);
  socket.emit({ kind: "open" });
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities }),
  });
  return { client, transport, clock, socket };
}

function latestSocket(transport: ReturnType<typeof createFakeTransport>): FakeSocket {
  const socket = transport.sockets[transport.sockets.length - 1];
  if (!socket) throw new Error("no socket opened");
  return socket;
}

function frames(socket: FakeSocket): Array<{ t: string; id?: number; ch?: string; a?: unknown[] }> {
  return socket.sent.map((text) => JSON.parse(text));
}

function reqs(socket: FakeSocket, ch?: string) {
  return frames(socket).filter(
    (frame) => frame.t === "req" && (ch === undefined || frame.ch === ch),
  );
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function answer(socket: FakeSocket, id: number, value: unknown): Promise<void> {
  socket.emit({ kind: "message", text: encodeMessage({ t: "res", id, v: value }) });
  await flush();
}

async function dropSocket(socket: FakeSocket): Promise<void> {
  socket.emit({ kind: "close", code: 1006, reason: "dropped" });
  await flush();
}

function dockerView(overrides: Record<string, unknown> = {}) {
  return {
    rows: [
      {
        name: "web",
        container: "app_web_1",
        facts: {
          name: "app_web_1",
          id: "c1",
          image: "nginx",
          state: "running",
          status: "Up 2 hours",
          ports: ["80/tcp"],
        },
      },
      { name: "db", container: "app_db_1" },
    ],
    composeProject: undefined,
    composeWorkingDir: undefined,
    ...overrides,
  };
}

describe("createDockerStore: parseDockerView", () => {
  it("parses rows with and without facts, and an optional compose target", () => {
    const parsed = parseDockerView(
      dockerView({ composeProject: "app", composeWorkingDir: "/repo" }),
    );
    expect(parsed?.rows).toHaveLength(2);
    expect(parsed?.rows[0]?.facts?.state).toBe("running");
    expect(parsed?.rows[1]?.facts).toBeUndefined();
    expect(parsed?.composeProject).toBe("app");
  });

  it(
    "rejects a row with an invalid container state " +
      "[bite-proof: drop the CONTAINER_STATES.has check and this fails]",
    () => {
      const view = dockerView();
      (view.rows[0] as { facts: { state: string } }).facts.state = "bogus";
      expect(parseDockerView(view)).toBeUndefined();
    },
  );
});

describe("createDockerStore: open/refresh", () => {
  it("open() calls docker:view with whenNotOpen reject semantics and parses the answer", async () => {
    const { client, socket } = createEnv();
    const store = createDockerStore({ client });
    store.open("jarvis");
    await flush();

    const [req] = reqs(socket, "docker:view");
    expect(req?.a).toEqual(["jarvis"]);

    await answer(socket, req?.id as number, { ok: true, value: dockerView() });
    expect(store.get().phase).toBe("ready");
    expect(store.get().view?.rows).toHaveLength(2);
  });

  it("an app-level docker:view failure surfaces the server's verbatim text", async () => {
    const { client, socket } = createEnv();
    const store = createDockerStore({ client });
    store.open("jarvis");
    await flush();
    const [req] = reqs(socket, "docker:view");
    await answer(socket, req?.id as number, { ok: false, text: "unknown project", language: "en" });
    expect(store.get().phase).toBe("failed");
    expect(store.get().notice).toBe("unknown project");
  });

  it("reconnect (client state -> open) refreshes automatically", async () => {
    const { client, transport, clock, socket } = createEnv();
    const store = createDockerStore({ client });
    store.open("jarvis");
    await flush();
    const [req1] = reqs(socket, "docker:view");
    await answer(socket, req1?.id as number, { ok: true, value: dockerView() });

    await dropSocket(socket);
    clock.advance(1_000);
    const socket2 = latestSocket(transport);
    socket2.emit({ kind: "open" });
    socket2.emit({
      kind: "message",
      text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: CAPS }),
    });
    await flush();

    const req2 = reqs(socket2, "docker:view")[0];
    expect(req2).toBeDefined();
  });

  it("close() stops reacting to a later reconnect", async () => {
    const { client, transport, clock, socket } = createEnv();
    const store = createDockerStore({ client });
    store.open("jarvis");
    await flush();
    const [req1] = reqs(socket, "docker:view");
    await answer(socket, req1?.id as number, { ok: true, value: dockerView() });
    store.close();
    expect(store.get().phase).toBe("idle");

    await dropSocket(socket);
    clock.advance(1_000);
    const socket2 = latestSocket(transport);
    socket2.emit({ kind: "open" });
    socket2.emit({
      kind: "message",
      text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: CAPS }),
    });
    await flush();
    expect(reqs(socket2, "docker:view")).toHaveLength(0);
  });
});

describe("createDockerStore: action", () => {
  async function openReady(overrides: Record<string, unknown> = {}) {
    const env = createEnv();
    const store = createDockerStore({ client: env.client });
    store.open("jarvis");
    await flush();
    const [req] = reqs(env.socket, "docker:view");
    await answer(env.socket, req?.id as number, { ok: true, value: dockerView(overrides) });
    return { ...env, store };
  }

  it("start on a known container dispatches docker:start [project, container]", async () => {
    const { socket, store } = await openReady();
    void store.action("start", "app_web_1");
    await flush();
    expect(store.get().busy).toBe(true);
    const [req] = reqs(socket, "docker:start");
    expect(req?.a).toEqual(["jarvis", "app_web_1"]);
    await answer(socket, req?.id as number, { ok: true, value: undefined });
    expect(store.get().busy).toBe(false);
    // A refresh always follows a mutation attempt.
    expect(reqs(socket, "docker:view")).toHaveLength(2);
  });

  it(
    "an unknown container cannot dispatch " +
      '[bite-proof: drop the "known" membership check and this fails]',
    async () => {
      const { socket, store } = await openReady();
      await store.action("start", "not-declared");
      await flush();
      expect(reqs(socket, "docker:start")).toHaveLength(0);
      expect(store.get().busy).toBe(false);
    },
  );

  it(
    "an ambiguous compose target (no single composeProject) cannot dispatch " +
      "[bite-proof: drop the composeProject undefined check and this fails]",
    async () => {
      const { socket, store } = await openReady({ composeProject: undefined });
      await store.action("composeUp");
      await flush();
      expect(reqs(socket, "docker:composeUp")).toHaveLength(0);
    },
  );

  it("composeDown with an unambiguous compose target dispatches [project] only", async () => {
    const { socket, store } = await openReady({
      composeProject: "app",
      composeWorkingDir: "/repo",
    });
    void store.action("composeDown");
    await flush();
    const [req] = reqs(socket, "docker:composeDown");
    expect(req?.a).toEqual(["jarvis"]);
  });

  it("a timeout marks the state uncertain and stale, without retrying automatically", async () => {
    const { client, socket, clock, store } = await openReady();
    void store.action("stop", "app_web_1");
    await flush();
    const [req] = reqs(socket, "docker:stop");
    expect(req).toBeDefined();
    clock.advance(30_000); // RpcClient's own request timeout
    await flush();
    expect(store.get().uncertain).toBe(true);
    expect(store.get().busy).toBe(false);
    // A refresh always follows a mutation attempt (same as changes-store.ts's
    // runMutation) — it starts immediately, which is why `stale` is already
    // false again here rather than staying true: the follow-up docker:view
    // request is in flight, not stalled.
    expect(store.get().stale).toBe(false);
    expect(reqs(socket, "docker:view")).toHaveLength(2);
    // No automatic re-send of the same mutation.
    expect(reqs(socket, "docker:stop")).toHaveLength(1);
    expect(client.state()).toBe("open");
  });

  it(
    "fix round 1, Important 1: an app-level action refusal (nested GitViewResult) surfaces " +
      "the server's verbatim text, never silent success " +
      "[bite-proof: skip the parseGitViewResult unwrap on the wire-level `ok:true` branch and this fails]",
    async () => {
      const { socket, store } = await openReady();
      void store.action("stop", "app_web_1");
      await flush();
      const [req] = reqs(socket, "docker:stop");
      // The wire-level `res` carries `ok:true` (the transport round trip
      // succeeded) while the nested app-level GitViewResult it wraps is a
      // refusal — exactly the shape packages/desktop/src/ipc.ts's `act`
      // returns for a daemon error (`fail(outcome.detail)`).
      await answer(socket, req?.id as number, {
        ok: false,
        text: "Error response from daemon: no such container",
        language: "en",
      });
      expect(store.get().busy).toBe(false);
      expect(store.get().notice).toBe("Error response from daemon: no such container");
      expect(store.get().uncertain).toBe(false);
    },
  );

  it("fix round 1, Minor 7: OK pressed while busy gives feedback instead of a silent drop", async () => {
    const { socket, store } = await openReady();
    void store.action("start", "app_web_1");
    await flush();
    expect(store.get().busy).toBe(true);

    // A second confirmed action while the first is still in flight.
    await store.action("stop", "app_web_1");
    expect(store.get().notice).toBe("docker.busy");
    // The second tap never dispatched its own request.
    expect(reqs(socket, "docker:stop")).toHaveLength(0);

    const [req] = reqs(socket, "docker:start");
    await answer(socket, req?.id as number, { ok: true, value: undefined });
    expect(store.get().busy).toBe(false);
  });
});
