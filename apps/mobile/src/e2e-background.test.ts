// task-5-brief.md, "Tests: e2e-background.test.ts" — the real
// `createRpcClient` plus a real `SessionStream` over a fake transport, a
// recording of the laptop-side frame log the same way e2e-session.test.ts
// does. Exercises M10 ruling d end to end: background drops every
// subscription in one frame, keeping the socket; foreground re-sends them
// in one frame and the stream's own M7-ruling-7 re-attach fires exactly
// once more; a reconnect that lands while still backgrounded stays quiet
// (the ordinary welcome path, no `resumed` event).
import { PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./lib/clock";
import { createFakeTransport, type FakeSocket } from "./lib/fake-transport";
import { createRpcClient } from "./lib/rpc-client";
import { createSessionStream } from "./lib/session-stream";

type Frame = {
  t: string;
  id: number;
  ch: string;
  a: unknown[];
  add?: unknown[];
  drop?: unknown[];
};

function frames(socket: FakeSocket): Frame[] {
  return socket.sent.map((text) => JSON.parse(text) as Frame);
}
function request(socket: FakeSocket, channel: string): Frame {
  const frame = frames(socket).findLast((item) => item.t === "req" && item.ch === channel);
  if (!frame) throw new Error(`missing request ${channel}`);
  return frame;
}
async function answer(socket: FakeSocket, channel: string, value: unknown) {
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "res", id: request(socket, channel).id, v: value }),
  });
}
function welcome(socket: FakeSocket, capabilities: string[]) {
  socket.emit({ kind: "open" });
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities }),
  });
}
function snapshotRequestCount(socket: FakeSocket): number {
  return frames(socket).filter((item) => item.t === "req" && item.ch === "session:snapshot").length;
}

/** Folds a socket's own `sub` frames into the laptop's own reconstructed
 * view of this device's watching set — the same fold `RemoteStatus`'s
 * suppression rule performs server-side (task-5-brief.md's security
 * review, item 3: "the laptop's suppression rule now sees an empty
 * watching set for a backgrounded phone"). */
function serverSubscriptions(socket: FakeSocket): unknown[] {
  const key = (target: unknown) => JSON.stringify(target);
  const targets: unknown[] = [];
  for (const frame of frames(socket)) {
    if (frame.t !== "sub") continue;
    for (const target of frame.add ?? []) {
      if (!targets.some((existing) => key(existing) === key(target))) targets.push(target);
    }
    for (const target of frame.drop ?? []) {
      const index = targets.findIndex((existing) => key(existing) === key(target));
      if (index >= 0) targets.splice(index, 1);
    }
  }
  return targets;
}

describe("background/foreground over the real client and a live session stream", () => {
  it(
    "drops the watching set on background (keeping the socket), re-attaches once on " +
      "return, and survives a background reconnect with no resumed event",
    async () => {
      const transport = createFakeTransport();
      const clock = createFakeClock();
      const logs: string[] = [];
      const token = "T".repeat(43);
      const client = createRpcClient({
        transport,
        clock,
        random: () => 0.5,
        client: "background-test",
        log: (line) => logs.push(line),
      });
      const states: { state: string; resumed?: true }[] = [];
      client.onState((state, detail) => states.push({ state, resumed: detail.resumed }));

      client.connect(
        { host: "192.168.1.5", port: 4317, fingerprint: "a".repeat(64) },
        { deviceId: "d".repeat(32), token },
      );
      const first = transport.sockets[0];
      if (!first) throw new Error("missing first socket");
      welcome(first, ["session:output"]);
      expect(client.state()).toBe("open");

      const writes: string[] = [];
      const stream = createSessionStream({
        client,
        clock,
        sessionId: "s1",
        log: (line) => logs.push(line),
      });
      stream.open({
        write: (text) => writes.push(text),
        reset: () => {
          writes.length = 0;
        },
      });
      expect(frames(first).find((item) => item.t === "sub")?.add).toEqual([
        { ch: "session:output", key: "s1" },
      ]);
      await answer(first, "session:snapshot", { text: "hello", end: 5 });
      expect(stream.get().phase).toBe("live");

      // Background: one `sub drop` frame carrying the live subscription,
      // and the socket stays open — no close, no reconnect.
      client.setAppActive(false);
      expect(frames(first).at(-1)).toEqual({
        t: "sub",
        drop: [{ ch: "session:output", key: "s1" }],
      });
      expect(client.state()).toBe("open");
      expect(serverSubscriptions(first)).toEqual([]);

      // Foreground: one `sub add` with the still-held target, and the
      // stream's own re-attach (M7 ruling 7 — every `onState("open")`,
      // this task's resumed one included) fires exactly once more.
      const snapshotsBeforeResume = snapshotRequestCount(first);
      const subFramesBeforeResume = frames(first).filter((item) => item.t === "sub").length;
      client.setAppActive(true);
      // The sub add is sent first; the stream's own re-attach (a fresh
      // `session:snapshot` request) follows synchronously within the same
      // `onState("open")` notification — so the *last* frame on the wire
      // is that request, not the sub add itself.
      const subFramesSinceResume = frames(first)
        .filter((item) => item.t === "sub")
        .slice(subFramesBeforeResume);
      expect(subFramesSinceResume).toHaveLength(1); // fix round 1, Minor 3: exactly one since resume
      expect(subFramesSinceResume[0]).toEqual({
        t: "sub",
        add: [{ ch: "session:output", key: "s1" }],
      });
      expect(snapshotRequestCount(first) - snapshotsBeforeResume).toBe(1);
      expect(states.at(-1)).toEqual({ state: "open", resumed: true });
      expect(serverSubscriptions(first)).toEqual([{ ch: "session:output", key: "s1" }]);
      await answer(first, "session:snapshot", { text: "hello", end: 5 });

      // Background again, then the socket drops (the heartbeat) while the
      // app is still backgrounded.
      client.setAppActive(false);
      const beforeClose = first.sent.length;
      first.emit({ kind: "close", code: 1006, reason: "heartbeat" });
      expect(client.state()).toBe("reconnecting");
      expect(first.sent.length).toBe(beforeClose); // nothing more to send on a dead socket

      // Foreground while still reconnecting: clears the flag locally
      // (rule 4's "if not open: nothing more") — no socket to send on yet.
      client.setAppActive(true);
      expect(client.state()).toBe("reconnecting");

      clock.advance(1_000);
      const second = transport.sockets[1];
      if (!second) throw new Error("missing reconnect socket");
      const statesBeforeReconnect = states.length;
      welcome(second, ["session:output"]);
      expect(client.state()).toBe("open");

      // The ordinary welcome path: one `sub add`, no `resumed` detail, and
      // the stream's own reconnect re-attach (also ruling 7, not this
      // task's special resume path) fires exactly once.
      const subFramesOnSecond = frames(second).filter((item) => item.t === "sub");
      expect(subFramesOnSecond).toHaveLength(1);
      expect(subFramesOnSecond[0]?.add).toEqual([{ ch: "session:output", key: "s1" }]);
      expect(states.slice(statesBeforeReconnect).some((item) => item.resumed === true)).toBe(false);
      expect(snapshotRequestCount(second)).toBe(1);

      for (const secret of [token]) {
        expect(logs.some((line) => line.includes(secret))).toBe(false);
      }
    },
  );
});
