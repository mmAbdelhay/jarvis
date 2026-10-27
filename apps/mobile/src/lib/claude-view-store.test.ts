import { describe, expect, it, vi } from "vitest";
import type { RpcClient, RpcResult } from "./rpc-client";
import { createClaudeViewStore } from "./claude-view-store";

function setup() {
  let push: (payload: unknown) => void = () => {};
  const pending: ((result: RpcResult) => void)[] = [];
  const call = vi.fn(() => new Promise<RpcResult>((resolve) => pending.push(resolve)));
  const off = vi.fn();
  const client = {
    call,
    onPush: vi.fn((_channel, handler) => {
      push = handler;
      return off;
    }),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  } as unknown as RpcClient;
  const store = createClaudeViewStore({ client, paneKey: "p", log: vi.fn() });
  return {
    store,
    client,
    call,
    off,
    push: (payload: unknown) => push(payload),
    reply: async (value: unknown) => {
      const resolve = pending.shift();
      if (!resolve) throw new Error("no pending call");
      resolve({ ok: true, value });
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}
const claude = { kind: "claude", sessionId: "s", turns: [] };

describe("Claude view store", () => {
  it("claude view → tab chat; later none → tab term", async () => {
    const e = setup();
    const listener = vi.fn();
    const stop = e.store.subscribe(listener);
    e.store.open();
    await e.reply(claude);
    expect(e.store.get().tab).toBe("chat");
    e.store.setTab("term");
    const refresh = e.store.refresh();
    await e.reply(claude);
    await refresh;
    expect(e.store.get().tab).toBe("term");
    e.store.setTab("chat");
    const next = e.store.refresh();
    await e.reply({ kind: "none" });
    await next;
    expect(e.store.get().tab).toBe("term");
    expect(listener).toHaveBeenCalled();
    stop();
    e.store.close();
  });

  it("three pushes during one refresh → exactly two calls", async () => {
    const e = setup();
    e.store.open();
    e.store.open();
    expect(e.client.subscribe).toHaveBeenCalledExactlyOnceWith({
      ch: "terminal:claudeViewChanged",
      key: "p",
    });
    e.push({ paneKey: "other" });
    for (let i = 0; i < 3; i++) e.push({ paneKey: "p" });
    expect(e.call).toHaveBeenCalledTimes(1);
    await e.reply(claude);
    expect(e.call).toHaveBeenCalledTimes(2);
    await e.reply(claude);
    e.store.close();
    expect(e.off).toHaveBeenCalledTimes(1);
    expect(e.client.unsubscribe).toHaveBeenCalledWith({
      ch: "terminal:claudeViewChanged",
      key: "p",
    });
    e.push({ paneKey: "p" });
    expect(e.call).toHaveBeenCalledTimes(2);
  });

  it("answer changed → refresh called", async () => {
    const e = setup();
    e.store.open();
    await e.reply(claude);
    const answering = e.store.answer(2, "Yes");
    expect(e.store.get().answering).toBe(true);
    expect(e.call).toHaveBeenLastCalledWith("terminal:answer", ["p", 2, "Yes"], {
      whenNotOpen: "reject",
    });
    await e.reply({ ok: false, reason: "changed" });
    expect(e.call).toHaveBeenLastCalledWith("terminal:claudeView", ["p"], {
      whenNotOpen: "reject",
    });
    await e.reply(claude);
    expect(await answering).toEqual({ ok: false, reason: "changed" });
    expect(e.store.get().answering).toBe(false);
  });
});
