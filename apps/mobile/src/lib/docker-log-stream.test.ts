// Tests for the Docker log stream (M9 Task 6) against a real RpcClient
// (Task 3) driven through a fake transport and fake clock — same
// infrastructure as session-stream.test.ts.

import { PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock";
import type { FakeSocket } from "./fake-transport";
import { createFakeTransport } from "./fake-transport";
import {
  DOCKER_LOG_GAP_MARKER,
  DOCKER_LOG_TEXT_CAP,
  createDockerLogStream,
} from "./docker-log-stream";
import type { Credential, Endpoint } from "./rpc-client";
import { createRpcClient } from "./rpc-client";

const ENDPOINT: Endpoint = { host: "192.168.1.5", port: 4317, fingerprint: "a".repeat(64) };
const CREDENTIAL: Credential = { deviceId: "d".repeat(32), token: "T".repeat(43) };
const CAPS = ["docker:log", "docker:follow", "docker:unfollow"];

function createEnv() {
  const transport = createFakeTransport();
  const clock = createFakeClock();
  const client = createRpcClient({
    transport,
    clock,
    random: () => 0.5,
    client: "jarvis-mobile-test",
    log: () => {},
  });
  return { transport, clock, client };
}

function latestSocket(transport: ReturnType<typeof createFakeTransport>): FakeSocket {
  const socket = transport.sockets[transport.sockets.length - 1];
  if (!socket) throw new Error("no socket opened");
  return socket;
}

function completeHandshake(
  transport: ReturnType<typeof createFakeTransport>,
  capabilities: string[] = CAPS,
): FakeSocket {
  const socket = latestSocket(transport);
  socket.emit({ kind: "open" });
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities }),
  });
  return socket;
}

type ParsedFrame = {
  t: string;
  id?: number;
  ch?: string;
  a?: unknown[];
  add?: unknown[];
  drop?: unknown[];
};

function parsedFrames(socket: FakeSocket): ParsedFrame[] {
  return socket.sent.map((s) => JSON.parse(s) as ParsedFrame);
}

function reqFrames(socket: FakeSocket, ch?: string): ParsedFrame[] {
  return parsedFrames(socket).filter((f) => f.t === "req" && (ch === undefined || f.ch === ch));
}

function subFrames(socket: FakeSocket): ParsedFrame[] {
  return parsedFrames(socket).filter((f) => f.t === "sub");
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

function pushLog(
  socket: FakeSocket,
  tabId: string,
  chunk: string,
  seq = 1,
  dropped?: number,
): void {
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "psh", ch: "docker:log", p: { tabId, chunk }, seq, dropped }),
  });
}

/** A deterministic id generator distinct from the production `newFollowId`
 * (which is derived from `random()` and would repeat under this suite's
 * fixed `random: () => 0.5`) — each call returns a fresh, ordered
 * `remote-…` id, so "fresh id per segment"/"reconnect recreated id" are
 * actually exercised. */
function makeRandomId(): () => string {
  let n = 0;
  return () => `remote-${(n++).toString(16).padStart(32, "0")}`;
}

describe("createDockerLogStream: follow", () => {
  it("awaits a successful docker:follow before sending the keyed docker:log subscription", async () => {
    const { transport, client } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createDockerLogStream({ client, randomId: makeRandomId() });

    void stream.follow("jarvis", "app_web_1");
    await flush();

    const [followReq] = reqFrames(socket, "docker:follow");
    expect(followReq?.a).toEqual([`remote-${"0".repeat(32)}`, "jarvis", "app_web_1"]);
    expect(subFrames(socket)).toHaveLength(0); // not yet — docker:follow hasn't resolved

    await answer(socket, followReq?.id as number, { ok: true, value: undefined });

    const subs = subFrames(socket);
    expect(subs).toHaveLength(1);
    expect(subs[0]?.add).toEqual([{ ch: "docker:log", key: `remote-${"0".repeat(32)}` }]);
    expect(stream.get().phase).toBe("following");
  });

  it(
    "an owned-elsewhere/limit refusal surfaces the server's verbatim text and never subscribes " +
      '[bite-proof: treat "ok: false" as success and this fails]',
    async () => {
      const { transport, client } = createEnv();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport);
      const stream = createDockerLogStream({ client, randomId: makeRandomId() });

      void stream.follow("jarvis", "app_web_1");
      await flush();
      const [followReq] = reqFrames(socket, "docker:follow");
      await answer(socket, followReq?.id as number, {
        ok: false,
        text: "This device already has the maximum number of Docker logs open at once.",
        language: "en",
      });

      expect(stream.get().phase).toBe("failed");
      expect(stream.get().notice).toBe(
        "This device already has the maximum number of Docker logs open at once.",
      );
      expect(subFrames(socket)).toHaveLength(0);
    },
  );

  it("a docker:log push for another key (or malformed) is ignored", async () => {
    const { transport, client } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createDockerLogStream({ client, randomId: makeRandomId() });
    void stream.follow("jarvis", "app_web_1");
    await flush();
    const [followReq] = reqFrames(socket, "docker:follow");
    await answer(socket, followReq?.id as number, { ok: true, value: undefined });

    pushLog(socket, `remote-${"9".repeat(32)}`, "not for us\n"); // foreign key
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "docker:log",
        p: { tabId: `remote-${"0".repeat(32)}`, chunk: 42 }, // malformed chunk
        seq: 2,
      }),
    });

    expect(stream.get().text).toBe("");
    expect(stream.get().droppedBytes).toBe(0);
  });

  it("live pushes for this stream's own key append to text", async () => {
    const { transport, client } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createDockerLogStream({ client, randomId: makeRandomId() });
    void stream.follow("jarvis", "app_web_1");
    await flush();
    const [followReq] = reqFrames(socket, "docker:follow");
    await answer(socket, followReq?.id as number, { ok: true, value: undefined });

    pushLog(socket, `remote-${"0".repeat(32)}`, "line one\n");
    pushLog(socket, `remote-${"0".repeat(32)}`, "line two\n", 2);

    expect(stream.get().text).toBe("line one\nline two\n");
  });

  it(
    "retention: text over the cap is trimmed from the front and droppedBytes counts it " +
      "[bite-proof: drop the DOCKER_LOG_TEXT_CAP trim and this fails]",
    async () => {
      const { transport, client } = createEnv();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport);
      const stream = createDockerLogStream({ client, randomId: makeRandomId() });
      void stream.follow("jarvis", "app_web_1");
      await flush();
      const [followReq] = reqFrames(socket, "docker:follow");
      await answer(socket, followReq?.id as number, { ok: true, value: undefined });

      const chunk = "x".repeat(DOCKER_LOG_TEXT_CAP - 10);
      pushLog(socket, `remote-${"0".repeat(32)}`, chunk);
      pushLog(socket, `remote-${"0".repeat(32)}`, "y".repeat(50), 2);

      expect(stream.get().text.length).toBe(DOCKER_LOG_TEXT_CAP);
      expect(stream.get().droppedBytes).toBe(40);
    },
  );

  it(
    "fix round 1, Important 2: a server-side STREAM_MAX_BYTES `dropped` count inserts a gap " +
      "marker and is added to droppedBytes " +
      "[bite-proof: ignore the push's `dropped` argument and this fails]",
    async () => {
      const { transport, client } = createEnv();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport);
      const stream = createDockerLogStream({ client, randomId: makeRandomId() });
      void stream.follow("jarvis", "app_web_1");
      await flush();
      const [followReq] = reqFrames(socket, "docker:follow");
      await answer(socket, followReq?.id as number, { ok: true, value: undefined });

      pushLog(socket, `remote-${"0".repeat(32)}`, "after the gap\n", 1, 100);

      expect(stream.get().droppedBytes).toBe(100);
      expect(stream.get().text).toBe(`${DOCKER_LOG_GAP_MARKER}after the gap\n`);
    },
  );

  it(
    "M12 Task 8 rule 9: a bare (non-enveloped) docker:follow reply, e.g. the literal " +
      'string "ok", is a parse failure — never treated as a bare success value ' +
      "[bite-proof: keep parseGitViewResult's old bare-value fallback and this fails]",
    async () => {
      const { transport, client } = createEnv();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport);
      const stream = createDockerLogStream({ client, randomId: makeRandomId() });

      void stream.follow("jarvis", "app_web_1");
      await flush();
      const [followReq] = reqFrames(socket, "docker:follow");
      await answer(socket, followReq?.id as number, "ok");

      expect(stream.get().phase).toBe("failed");
      expect(subFrames(socket)).toHaveLength(0);
    },
  );

  it('fix round 1, Minor 1: never optimistically "following" before docker:follow resolves', async () => {
    const { transport, client } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createDockerLogStream({ client, randomId: makeRandomId() });

    void stream.follow("jarvis", "app_web_1");
    // Still awaiting the docker:follow reply — must read "waiting", not an
    // optimistic "following" nothing has actually confirmed yet.
    expect(stream.get().phase).toBe("waiting");
    await flush();
    expect(stream.get().phase).toBe("waiting");

    const [followReq] = reqFrames(socket, "docker:follow");
    await answer(socket, followReq?.id as number, { ok: true, value: undefined });
    expect(stream.get().phase).toBe("following");
  });
});

describe("createDockerLogStream: follow failure handling", () => {
  it(
    "fix round 1, Important 3: a docker:follow timeout surfaces a notice and best-effort " +
      "unfollows the id, releasing a slot a lost reply would otherwise strand " +
      "[bite-proof: drop the timeout-kind unfollow call and this fails]",
    async () => {
      const { transport, clock, client } = createEnv();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport);
      const stream = createDockerLogStream({ client, randomId: makeRandomId() });

      void stream.follow("jarvis", "app_web_1");
      await flush();
      const [followReq] = reqFrames(socket, "docker:follow");
      expect(followReq).toBeDefined();

      clock.advance(30_000); // RpcClient's own request timeout
      await flush();

      expect(stream.get().phase).toBe("failed");
      expect(stream.get().notice).toBe("docker.log.followFailed");
      const unfollows = reqFrames(socket, "docker:unfollow");
      expect(unfollows).toHaveLength(1);
      expect(unfollows[0]?.a).toEqual([followReq?.a?.[0]]);
      // The connection itself is untouched — this is a lost reply, not a drop.
      expect(client.state()).toBe("open");
    },
  );

  it(
    'fix round 1, Minor 2: a terminal client state (e.g. unpaired) reads "failed", never ' +
      'stuck on "Reconnecting…" forever',
    async () => {
      const { transport, client } = createEnv();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport);
      const stream = createDockerLogStream({ client, randomId: makeRandomId() });
      void stream.follow("jarvis", "app_web_1");
      await flush();
      const [followReq] = reqFrames(socket, "docker:follow");
      await answer(socket, followReq?.id as number, { ok: true, value: undefined });
      expect(stream.get().phase).toBe("following");

      socket.emit({ kind: "close", code: 4410, reason: "revoked" }); // CLOSE.revoked
      await flush();

      expect(stream.get().phase).toBe("failed");
      expect(stream.get().notice).toBe("docker.log.followFailed");
    },
  );

  it(
    "fix round 1, Minor 3: rapid repeat Follow taps for the same container send only one " +
      "docker:follow while the first is still in flight " +
      "[bite-proof: drop the followInFlight guard and this fails]",
    async () => {
      const { transport, client } = createEnv();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport);
      const stream = createDockerLogStream({ client, randomId: makeRandomId() });

      void stream.follow("jarvis", "app_web_1");
      void stream.follow("jarvis", "app_web_1");
      void stream.follow("jarvis", "app_web_1");
      await flush();

      expect(reqFrames(socket, "docker:follow")).toHaveLength(1);

      const [followReq] = reqFrames(socket, "docker:follow");
      await answer(socket, followReq?.id as number, { ok: true, value: undefined });
      expect(stream.get().phase).toBe("following");

      // Once settled, a fresh tap for the same container is no longer
      // blocked — it is a deliberate reload, not a duplicate.
      void stream.follow("jarvis", "app_web_1");
      await flush();
      expect(reqFrames(socket, "docker:follow")).toHaveLength(2);
    },
  );
});

describe("createDockerLogStream: switching and lifecycle", () => {
  it(
    "a fast container switch drops the old key locally and best-effort unfollows the old id, " +
      "even if its own docker:follow resolves late",
    async () => {
      const { transport, client } = createEnv();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport);
      const stream = createDockerLogStream({ client, randomId: makeRandomId() });

      void stream.follow("jarvis", "app_web_1"); // A: remote-000...0
      await flush();
      void stream.follow("jarvis", "app_db_1"); // B: remote-000...1, before A resolves
      await flush();

      const followReqs = reqFrames(socket, "docker:follow");
      expect(followReqs).toHaveLength(2);
      const [reqA, reqB] = followReqs;

      // A's late success must be cleaned up (never subscribed to).
      await answer(socket, reqA?.id as number, { ok: true, value: undefined });
      const unfollowsAfterA = reqFrames(socket, "docker:unfollow");
      expect(unfollowsAfterA).toHaveLength(1);
      expect(unfollowsAfterA[0]?.a).toEqual([reqA?.a?.[0]]);
      expect(subFrames(socket).some((f) => (f.add as unknown[])?.[0])).toBe(false);

      await answer(socket, reqB?.id as number, { ok: true, value: undefined });
      expect(stream.get().phase).toBe("following");
      const subs = subFrames(socket);
      expect(subs).toHaveLength(1);
      expect(subs[0]?.add).toEqual([{ ch: "docker:log", key: reqB?.a?.[0] }]);
    },
  );

  it("close() while following unsubscribes and best-effort unfollows, then goes idle", async () => {
    const { transport, client } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createDockerLogStream({ client, randomId: makeRandomId() });
    void stream.follow("jarvis", "app_web_1");
    await flush();
    const [followReq] = reqFrames(socket, "docker:follow");
    await answer(socket, followReq?.id as number, { ok: true, value: undefined });
    pushLog(socket, followReq?.a?.[0] as string, "hi\n");
    expect(stream.get().text).toBe("hi\n");

    stream.close();

    const drops = subFrames(socket).filter((f) => f.drop !== undefined);
    expect(drops).toHaveLength(1);
    expect(drops[0]?.drop).toEqual([{ ch: "docker:log", key: followReq?.a?.[0] }]);
    expect(reqFrames(socket, "docker:unfollow")).toHaveLength(1);
    expect(stream.get()).toEqual({ text: "", phase: "idle", droppedBytes: 0, notice: undefined });

    // A push after close() for the old (now dropped) id changes nothing.
    pushLog(socket, followReq?.a?.[0] as string, "late\n", 2);
    expect(stream.get().text).toBe("");
  });
});

describe("createDockerLogStream: reconnect", () => {
  it(
    "reconnect drops the local keyed subscription immediately, then follows again under a " +
      "fresh id and discloses the gap in the text " +
      "[bite-proof: skip the immediate client.unsubscribe on disconnect and this fails]",
    async () => {
      const { transport, clock, client } = createEnv();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket1 = completeHandshake(transport);
      const stream = createDockerLogStream({ client, randomId: makeRandomId() });
      void stream.follow("jarvis", "app_web_1");
      await flush();
      const [followReq1] = reqFrames(socket1, "docker:follow");
      const firstId = followReq1?.a?.[0] as string;
      await answer(socket1, followReq1?.id as number, { ok: true, value: undefined });
      expect(stream.get().phase).toBe("following");

      await dropSocket(socket1);
      // The local keyed subscription is dropped the moment the connection
      // leaves "open" — before any reconnect, not only once one succeeds —
      // so RpcClient's own re-`sub`-on-welcome can never resend a key for a
      // follower the desktop already reaped on disconnect.
      expect(client.subscriptions()).not.toContainEqual({ ch: "docker:log", key: firstId });
      expect(stream.get().phase).toBe("waiting");

      clock.advance(1_000); // first backoff delay at random()=0.5
      const socket2 = completeHandshake(transport);
      await flush();

      const followReqs2 = reqFrames(socket2, "docker:follow");
      expect(followReqs2).toHaveLength(1);
      const secondId = followReqs2[0]?.a?.[0] as string;
      expect(secondId).not.toBe(firstId); // a fresh id per segment, never the old one

      await answer(socket2, followReqs2[0]?.id as number, { ok: true, value: undefined });
      expect(stream.get().phase).toBe("following");
      expect(stream.get().text).toBe(DOCKER_LOG_GAP_MARKER); // missed-output disclosure

      const subs2 = subFrames(socket2);
      expect(subs2[0]?.add).toEqual([{ ch: "docker:log", key: secondId }]);
    },
  );

  it("a first follow while offline waits, then attaches once open — no gap marker", async () => {
    const { transport, client } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const stream = createDockerLogStream({ client, randomId: makeRandomId() });

    void stream.follow("jarvis", "app_web_1");
    expect(stream.get().phase).toBe("waiting");

    const socket = completeHandshake(transport);
    await flush();
    const [followReq] = reqFrames(socket, "docker:follow");
    await answer(socket, followReq?.id as number, { ok: true, value: undefined });

    expect(stream.get().phase).toBe("following");
    expect(stream.get().text).toBe("");
  });
});
