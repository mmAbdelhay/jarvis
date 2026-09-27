import { describe, expect, it, vi } from "vitest";
import { createPlansStore } from "./plans-store";
import type { RpcResult } from "./rpc-client";

function ok(value: unknown): RpcResult {
  return { ok: true, value };
}

function fakeClient(results: RpcResult[]) {
  const pushes = new Map<string, (payload: unknown) => void>();
  return {
    call: vi.fn(async () => results.shift() ?? ok(undefined)),
    onPush: vi.fn((channel: string, handler: (payload: unknown) => void) => {
      pushes.set(channel, handler);
      return () => pushes.delete(channel);
    }),
    subscribe: vi.fn(() => ok(undefined)),
    unsubscribe: vi.fn(),
    push(channel: string, payload: unknown) {
      pushes.get(channel)?.(payload);
    },
  };
}

const list = {
  session: { path: "/tmp/session.md", name: "session.md", source: "session", mtimeMs: 1 },
  planMode: [],
  repo: [],
} as const;
const doc = {
  path: "/tmp/session.md",
  mtimeMs: 12,
  blocks: [
    { id: "b1", kind: "paragraph", start: 0, end: 5, source: "Hello", html: "<p>Hello</p>" },
  ],
};
const comment = {
  id: "c1",
  path: doc.path,
  blockId: "b1",
  quote: "Hello",
  body: "Tighten this",
  createdAt: 2,
};

describe("createPlansStore", () => {
  it("loads the list for the pane and optional cwd", async () => {
    const client = fakeClient([ok(list)]);
    const store = createPlansStore({ client: client as never, paneKey: "pane-1", cwd: "/repo" });
    await store.load();
    expect(client.call).toHaveBeenCalledWith("plans:list", ["pane-1", "/repo"]);
    expect(store.state.list).toEqual(list);
  });

  it("opens a plan then loads its anchored comments", async () => {
    const anchored = [
      { ...comment, number: 1, anchor: { kind: "block", blockId: "b1", text: "Hello" } },
    ];
    const client = fakeClient([ok({ ok: true, value: doc }), ok(anchored)]);
    const store = createPlansStore({ client: client as never, paneKey: "pane-1" });
    await store.open(doc.path);
    expect(client.call.mock.calls).toEqual([
      ["plans:read", [doc.path]],
      ["plans:comments", [doc.path]],
    ]);
    expect(store.state.doc).toEqual(doc);
    expect(store.state.comments).toEqual(anchored);
  });

  it("adds a comment using the open path and refreshes anchored comments", async () => {
    const anchored = [
      { ...comment, number: 1, anchor: { kind: "block", blockId: "b1", text: "Hello" } },
    ];
    const client = fakeClient([ok({ ok: true, value: doc }), ok([]), ok(comment), ok(anchored)]);
    const store = createPlansStore({ client: client as never, paneKey: "pane-1" });
    await store.open(doc.path);
    await expect(store.addComment("b1", "Hello", "Tighten this")).resolves.toEqual({
      ok: true,
      value: comment,
    });
    expect(client.call.mock.calls.slice(-2)).toEqual([
      ["plans:addComment", [doc.path, "b1", "Hello", "Tighten this"]],
      ["plans:comments", [doc.path]],
    ]);
    expect(store.state.comments).toEqual(anchored);
  });

  it("returns an error code and preserves server detail when adding a comment fails", async () => {
    const client = fakeClient([
      ok({ ok: true, value: doc }),
      ok([]),
      {
        ok: false,
        error: { kind: "remote", code: "internal", text: "disk denied", language: "en" },
      },
    ]);
    const store = createPlansStore({ client: client as never, paneKey: "pane-1" });
    await store.open(doc.path);
    const result = await store.addComment("b1", "Hello", "Tighten this");
    expect(result).toEqual({
      ok: false,
      error: { code: "saveFailed", detail: "disk denied" },
    });
    expect(store.state.error).toEqual({ code: "saveFailed", detail: "disk denied" });
    expect(client.call).toHaveBeenCalledTimes(3);
  });

  it("sends selected ids and reloads comments", async () => {
    const anchored = [
      { ...comment, number: 1, anchor: { kind: "block", blockId: "b1", text: "Hello" } },
    ];
    const client = fakeClient([
      ok({ ok: true, value: doc }),
      ok(anchored),
      ok({ ok: true, sent: 1 }),
      ok([{ ...anchored[0], sentAt: 3 }]),
    ]);
    const store = createPlansStore({ client: client as never, paneKey: "pane-1" });
    await store.open(doc.path);
    await expect(store.send(["c1"])).resolves.toEqual({ ok: true, value: undefined });
    expect(client.call.mock.calls.slice(-2)).toEqual([
      ["plans:send", ["pane-1", doc.path, ["c1"]]],
      ["plans:comments", [doc.path]],
    ]);
    expect(store.state.comments[0]?.sentAt).toBe(3);
  });

  it("surfaces a plans:send domain refusal and does not reload comments", async () => {
    const anchored = [
      { ...comment, number: 1, anchor: { kind: "block", blockId: "b1", text: "Hello" } },
    ];
    const client = fakeClient([
      ok({ ok: true, value: doc }),
      ok(anchored),
      ok({ ok: false, reason: "no-pane" }),
    ]);
    const store = createPlansStore({ client: client as never, paneKey: "pane-1" });
    await store.open(doc.path);
    await expect(store.send()).resolves.toEqual({
      ok: false,
      error: { code: "noPane" },
    });
    expect(store.state.error).toEqual({ code: "noPane" });
    expect(client.call).toHaveBeenCalledTimes(3);
  });

  it("does nothing when send has no queued comments", async () => {
    const client = fakeClient([ok({ ok: true, value: doc }), ok([])]);
    const store = createPlansStore({ client: client as never, paneKey: "pane-1" });
    await store.open(doc.path);
    client.call.mockClear();
    await store.send();
    expect(client.call).not.toHaveBeenCalled();
  });

  it("writes against the open mtime and reports conflicts", async () => {
    const client = fakeClient([
      ok({ ok: true, value: doc }),
      ok([]),
      ok({ ok: false, reason: "conflict", doc: { ...doc, mtimeMs: 13 } }),
    ]);
    const store = createPlansStore({ client: client as never, paneKey: "pane-1" });
    await store.open(doc.path);
    await expect(store.writeBlock("b1", "Changed")).resolves.toBe("conflict");
    expect(client.call).toHaveBeenLastCalledWith("plans:writeBlock", [
      doc.path,
      "b1",
      "Changed",
      12,
    ]);
    expect(store.state.doc?.mtimeMs).toBe(13);
  });

  it("stores the returned document after a successful block write", async () => {
    const changed = { ...doc, mtimeMs: 14, blocks: [{ ...doc.blocks[0]!, source: "Changed" }] };
    const client = fakeClient([
      ok({ ok: true, value: doc }),
      ok([]),
      ok({ ok: true, value: changed }),
    ]);
    const store = createPlansStore({ client: client as never, paneKey: "pane-1" });
    await store.open(doc.path);
    await expect(store.writeBlock("b1", "Changed")).resolves.toBe("ok");
    expect(store.state.doc).toEqual(changed);
    expect(store.state.error).toBeUndefined();
  });

  it("ignores an older open response after a newer path has been requested", async () => {
    const resolvers: ((result: RpcResult) => void)[] = [];
    const client = fakeClient([]);
    client.call.mockImplementation(
      () => new Promise<RpcResult>((resolve) => resolvers.push(resolve)),
    );
    const store = createPlansStore({ client: client as never, paneKey: "pane-1" });
    const oldOpen = store.open("/old.md");
    const newOpen = store.open("/new.md");
    resolvers[1]!(ok({ ok: true, value: { ...doc, path: "/new.md" } }));
    await vi.waitFor(() => expect(client.call).toHaveBeenCalledTimes(3));
    resolvers[2]!(ok([]));
    await newOpen;
    resolvers[0]!(ok({ ok: true, value: { ...doc, path: "/old.md" } }));
    await oldOpen;
    expect(store.state.doc?.path).toBe("/new.md");
  });

  it("subscribes to plans:changed and refreshes the matching open plan", async () => {
    const changed = { ...doc, mtimeMs: 20 };
    const client = fakeClient([
      ok({ ok: true, value: doc }),
      ok([]),
      ok({ ok: true, value: changed }),
      ok([]),
    ]);
    const store = createPlansStore({ client: client as never, paneKey: "pane-1" });
    const unsubscribe = store.subscribe(() => undefined);
    await store.open(doc.path);
    client.push("plans:changed", doc.path);
    await vi.waitFor(() => expect(store.state.doc?.mtimeMs).toBe(20));
    expect(client.subscribe).toHaveBeenCalledWith("plans:changed");
    unsubscribe();
    expect(client.unsubscribe).toHaveBeenCalledWith("plans:changed");
  });
});
