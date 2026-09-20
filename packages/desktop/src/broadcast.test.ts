import { describe, expect, it, vi } from "vitest";
import { createBroadcaster, rendererSink } from "./broadcast.js";

function harness() {
  const toRenderer = vi.fn();
  const broadcast = createBroadcaster({ toRenderer });
  return { broadcast, toRenderer };
}

describe("createBroadcaster", () => {
  it("sends to the renderer", () => {
    const { broadcast, toRenderer } = harness();

    broadcast.send("voice:listening", true);

    expect(toRenderer).toHaveBeenCalledWith("voice:listening", true);
  });

  it("sends to every added sink as well as the renderer", () => {
    const { broadcast, toRenderer } = harness();
    const first: [string, unknown][] = [];
    const second: [string, unknown][] = [];
    broadcast.addSink((channel, payload) => first.push([channel, payload]));
    broadcast.addSink((channel, payload) => second.push([channel, payload]));

    broadcast.send("metrics:update", { cpu: 1 } as never);

    expect(toRenderer).toHaveBeenCalledTimes(1);
    expect(first).toEqual([["metrics:update", { cpu: 1 }]]);
    expect(second).toEqual([["metrics:update", { cpu: 1 }]]);
  });

  it("stops sending to a sink that removed itself", () => {
    const { broadcast } = harness();
    const seen: string[] = [];
    const remove = broadcast.addSink((channel) => seen.push(channel));

    broadcast.send("voice:speaking", true);
    remove();
    broadcast.send("voice:speaking", false);

    expect(seen).toEqual(["voice:speaking"]);
  });

  // local() is for events about this window. A remote client has no DevTools
  // panel and no first-run installer, so shipping it those would be noise at
  // best and a leak of local paths at worst.
  it("keeps local() away from the sinks", () => {
    const { broadcast, toRenderer } = harness();
    const seen: string[] = [];
    broadcast.addSink((channel) => seen.push(channel));

    broadcast.local("setup:output", "installing…");

    expect(toRenderer).toHaveBeenCalledWith("setup:output", "installing…");
    expect(seen).toEqual([]);
  });

  // A remote sink writes to a socket, which can throw for reasons that have
  // nothing to do with the renderer or the other sinks. One dead client must
  // not silence everyone else.
  it("keeps going when a sink throws, and still reaches the renderer", () => {
    const { broadcast, toRenderer } = harness();
    const seen: string[] = [];
    broadcast.addSink(() => {
      throw new Error("socket closed");
    });
    broadcast.addSink((channel) => seen.push(channel));

    expect(() => broadcast.send("turn:new", { role: "assistant" } as never)).not.toThrow();
    expect(seen).toEqual(["turn:new"]);
    expect(toRenderer).toHaveBeenCalledTimes(1);
  });

  it("keeps going when the renderer throws, and still reaches the sinks", () => {
    const toRenderer = vi.fn(() => {
      throw new Error("window destroyed");
    });
    const broadcast = createBroadcaster({ toRenderer });
    const seen: string[] = [];
    broadcast.addSink((channel) => seen.push(channel));

    expect(() => broadcast.send("git:counts", [] as never)).not.toThrow();
    expect(seen).toEqual(["git:counts"]);
  });

  // send() snapshots the sink set before iterating (a sink may add or remove
  // one from inside its own call — a real sink is a socket write, and a
  // socket can close another socket as a side effect). Without the snapshot,
  // a sink added mid-send could receive the event it was added during, and a
  // sink removed mid-send could be skipped for events already in flight —
  // both are "it depends what order the Set iterates in" bugs.
  describe("re-entrancy: send() snapshots the sink set for one call", () => {
    it("does not deliver to a sink added during the same send, only from the next send on", () => {
      const { broadcast } = harness();
      const seen: string[] = [];
      broadcast.addSink(() => {
        broadcast.addSink((channel) => seen.push(channel));
      });

      broadcast.send("voice:listening", true);
      expect(seen).toEqual([]);

      broadcast.send("voice:listening", false);
      expect(seen).toEqual(["voice:listening"]);
    });

    it("still delivers, in the same send, to a sink removed by an earlier sink", () => {
      const { broadcast } = harness();
      const seen: string[] = [];
      let removeSecond: () => void = () => {};
      broadcast.addSink(() => removeSecond());
      removeSecond = broadcast.addSink((channel) => seen.push(channel));

      broadcast.send("voice:listening", true);
      expect(seen).toEqual(["voice:listening"]);

      seen.length = 0;
      broadcast.send("voice:listening", false);
      expect(seen).toEqual([]);
    });

    it("does not throw or skip later sinks when a sink removes itself during its own delivery", () => {
      const { broadcast } = harness();
      const seen: string[] = [];
      let removeSelf: () => void = () => {};
      removeSelf = broadcast.addSink(() => removeSelf());
      broadcast.addSink((channel) => seen.push(channel));

      expect(() => broadcast.send("voice:listening", true)).not.toThrow();
      expect(seen).toEqual(["voice:listening"]);
    });
  });
});

describe("rendererSink", () => {
  it("forwards to the window when it is alive", () => {
    const send = vi.fn();
    const window = { isDestroyed: () => false, webContents: { send } };

    rendererSink(window)("voice:listening", true);

    expect(send).toHaveBeenCalledWith("voice:listening", true);
  });

  it("does not call send when the window is destroyed", () => {
    const send = vi.fn();
    const window = { isDestroyed: () => true, webContents: { send } };

    rendererSink(window)("voice:listening", true);

    expect(send).not.toHaveBeenCalled();
  });
});
