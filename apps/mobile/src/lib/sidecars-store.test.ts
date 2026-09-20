import { describe, expect, it, vi } from "vitest";
import { STRINGS } from "./i18n";
import type { RpcResult } from "./rpc-client";
import { createSidecarsStore } from "./sidecars-store";

const NAME = "laptop.tail1234.ts.net";
const PORT = 8443;
const HANDLE = "0123456789abcdef0123456789abcdef";
const PROJECT = "jarvis";

/** A minimal fake of `Pick<RpcClient, "call">`: results are handed out in
 * call order from a queue the test fills in, and every call is recorded
 * for assertions on channel/args. */
function createFakeClient() {
  const callLog: { channel: string; args: unknown[] }[] = [];
  const results: RpcResult[] = [];
  const pendingResolvers: ((result: RpcResult) => void)[] = [];

  return {
    call: vi.fn((channel: string, args: unknown[]) => {
      callLog.push({ channel, args });
      const queued = results.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise<RpcResult>((resolve) => {
        pendingResolvers.push(resolve);
      });
    }),
    callLog,
    queueResult(result: RpcResult) {
      results.push(result);
    },
    resolvePending(index: number, result: RpcResult) {
      const resolve = pendingResolvers[index];
      if (resolve === undefined) throw new Error(`no pending call at index ${index}`);
      resolve(result);
    },
  };
}

function ok(value: unknown): RpcResult {
  return { ok: true, value };
}

function remoteErr(text: string): RpcResult {
  return { ok: false, error: { kind: "remote", code: "internal", text, language: "en" } };
}

describe("createSidecarsStore", () => {
  describe("rule 1: LAN-only (no name on the record)", () => {
    it("view() is lanOnly forever, and load() makes no request", async () => {
      const client = createFakeClient();
      // Queued so that removing load()'s LAN-only guard (the bite-proof)
      // fails this test by the callLog assertion below, immediately — not
      // by a 5s vitest timeout from two hung, never-resolving calls.
      client.queueResult(ok([]));
      client.queueResult(ok([]));
      const store = createSidecarsStore({
        client,
        record: { port: PORT },
        project: PROJECT,
      });

      expect(store.view()).toEqual({ mode: "lanOnly" });
      await store.load();
      expect(store.view()).toEqual({ mode: "lanOnly" });
      // [bite-proof] removing load()'s LAN-only guard makes this fail.
      expect(client.callLog).toEqual([]);
    });

    it("open() makes no request and resolves to undefined", async () => {
      const client = createFakeClient();
      const store = createSidecarsStore({
        client,
        record: { port: PORT },
        project: PROJECT,
      });

      const result = await store.open({ kind: "editor", label: "" });
      expect(result).toBeUndefined();
      expect(client.callLog).toEqual([]);
      expect(store.view()).toEqual({ mode: "lanOnly" });
    });
  });

  describe("rule 2: load() builds rows", () => {
    it("two editor roots, zero clusters", async () => {
      const client = createFakeClient();
      client.queueResult(ok(["frontend", "backend"]));
      client.queueResult(ok([]));
      const store = createSidecarsStore({
        client,
        record: { name: NAME, port: PORT },
        project: PROJECT,
      });

      await store.load();

      const view = store.view();
      expect(view.mode).toBe("ready");
      if (view.mode !== "ready") throw new Error("expected ready");
      expect(view.rows).toEqual([
        { kind: "editor", label: "frontend" },
        { kind: "editor", label: "backend" },
        { kind: "database", label: "" },
      ]);
      expect(view.error).toBeUndefined();
      expect(client.callLog).toEqual([
        { channel: "editor:roots", args: [PROJECT] },
        { channel: "cluster:names", args: [PROJECT] },
      ]);
    });

    it("zero editor roots (one default row), two clusters", async () => {
      const client = createFakeClient();
      client.queueResult(ok([]));
      client.queueResult(ok(["prod", "staging"]));
      const store = createSidecarsStore({
        client,
        record: { name: NAME, port: PORT },
        project: PROJECT,
      });

      await store.load();

      const view = store.view();
      expect(view.mode).toBe("ready");
      if (view.mode !== "ready") throw new Error("expected ready");
      expect(view.rows).toEqual([
        { kind: "editor", label: "" },
        { kind: "database", label: "" },
        { kind: "cluster", label: "prod" },
        { kind: "cluster", label: "staging" },
      ]);
    });

    it("a failed call's server text lands in error, and rows still render what loaded", async () => {
      const client = createFakeClient();
      client.queueResult(remoteErr("Couldn't list folders."));
      client.queueResult(ok(["prod"]));
      const store = createSidecarsStore({
        client,
        record: { name: NAME, port: PORT },
        project: PROJECT,
      });

      await store.load();

      const view = store.view();
      expect(view.mode).toBe("ready");
      if (view.mode !== "ready") throw new Error("expected ready");
      expect(view.error).toBe("Couldn't list folders.");
      expect(view.rows).toEqual([
        { kind: "database", label: "" },
        { kind: "cluster", label: "prod" },
      ]);
    });

    it("a non-remote failure (offline) sets a generic error, not undefined", async () => {
      const client = createFakeClient();
      client.queueResult({ ok: false, error: { kind: "offline" } });
      client.queueResult(ok([]));
      const store = createSidecarsStore({
        client,
        record: { name: NAME, port: PORT },
        project: PROJECT,
      });

      await store.load();

      const view = store.view();
      expect(view.mode).toBe("ready");
      if (view.mode !== "ready") throw new Error("expected ready");
      // Pins the store→screen convention: a non-remote failure's `error`
      // is a real i18n.ts MessageKey (the screen resolves it via `t()`),
      // not arbitrary text.
      expect(view.error).toBeDefined();
      expect(Object.hasOwn(STRINGS, view.error as string)).toBe(true);
    });
  });

  describe("rule 3: open()", () => {
    it("editor: calls editor:open [project, root] and returns the url string", async () => {
      const client = createFakeClient();
      client.queueResult(ok([]));
      client.queueResult(ok([]));
      const store = createSidecarsStore({
        client,
        record: { name: NAME, port: PORT },
        project: PROJECT,
      });
      await store.load();

      const url = `https://${NAME}:${PORT}/s/${HANDLE}/`;
      client.queueResult(ok({ ok: true, value: url }));
      const result = await store.open({ kind: "editor", label: "frontend" });

      expect(result).toEqual({ url });
      expect(client.callLog.at(-1)).toEqual({
        channel: "editor:open",
        args: [PROJECT, "frontend"],
      });
    });

    it("editor with the default (empty) root omits the root argument", async () => {
      const client = createFakeClient();
      client.queueResult(ok([]));
      client.queueResult(ok([]));
      const store = createSidecarsStore({
        client,
        record: { name: NAME, port: PORT },
        project: PROJECT,
      });
      await store.load();

      const url = `https://${NAME}:${PORT}/s/${HANDLE}/`;
      client.queueResult(ok({ ok: true, value: url }));
      await store.open({ kind: "editor", label: "" });

      expect(client.callLog.at(-1)).toEqual({ channel: "editor:open", args: [PROJECT] });
    });

    it("database: calls database:open [project] and reads value.url", async () => {
      const client = createFakeClient();
      client.queueResult(ok([]));
      client.queueResult(ok([]));
      const store = createSidecarsStore({
        client,
        record: { name: NAME, port: PORT },
        project: PROJECT,
      });
      await store.load();

      const url = `https://${NAME}:${PORT}/s/${HANDLE}/`;
      client.queueResult(ok({ ok: true, value: { url } }));
      const result = await store.open({ kind: "database", label: "" });

      expect(result).toEqual({ url });
      expect(client.callLog.at(-1)).toEqual({ channel: "database:open", args: [PROJECT] });
    });

    it("cluster: calls cluster:open [project, name, true]", async () => {
      const client = createFakeClient();
      client.queueResult(ok([]));
      client.queueResult(ok(["prod"]));
      const store = createSidecarsStore({
        client,
        record: { name: NAME, port: PORT },
        project: PROJECT,
      });
      await store.load();

      const url = `https://${NAME}:${PORT}/s/${HANDLE}/`;
      client.queueResult(ok({ ok: true, value: url }));
      const result = await store.open({ kind: "cluster", label: "prod" });

      expect(result).toEqual({ url });
      expect(client.callLog.at(-1)).toEqual({
        channel: "cluster:open",
        args: [PROJECT, "prod", true],
      });
    });

    it("[bite-proof] a loopback URL is refused and never returned", async () => {
      const client = createFakeClient();
      client.queueResult(ok([]));
      client.queueResult(ok([]));
      const store = createSidecarsStore({
        client,
        record: { name: NAME, port: PORT },
        project: PROJECT,
      });
      await store.load();

      const loopbackUrl = `https://127.0.0.1:${PORT}/s/${HANDLE}/`;
      client.queueResult(ok({ ok: true, value: loopbackUrl }));
      const result = await store.open({ kind: "editor", label: "frontend" });

      expect(result).toBeUndefined();
      const view = store.view();
      expect(view.mode).toBe("ready");
      if (view.mode !== "ready") throw new Error("expected ready");
      expect(view.error).toBe("sidecars.unexpectedAddress");
    });

    it("an ok:false domain result shows its text verbatim", async () => {
      const client = createFakeClient();
      client.queueResult(ok([]));
      client.queueResult(ok([]));
      const store = createSidecarsStore({
        client,
        record: { name: NAME, port: PORT },
        project: PROJECT,
      });
      await store.load();

      client.queueResult(ok({ ok: false, text: "Not connected to prod.", language: "en" }));
      const result = await store.open({ kind: "cluster", label: "prod" });

      expect(result).toBeUndefined();
      const view = store.view();
      expect(view.mode).toBe("ready");
      if (view.mode !== "ready") throw new Error("expected ready");
      expect(view.error).toBe("Not connected to prod.");
    });

    it("opening toggles: set to the row while in flight, cleared after", async () => {
      const client = createFakeClient();
      client.queueResult(ok([]));
      client.queueResult(ok([]));
      const store = createSidecarsStore({
        client,
        record: { name: NAME, port: PORT },
        project: PROJECT,
      });
      await store.load();

      const row = { kind: "database" as const, label: "" };
      const openPromise = store.open(row);
      const inFlightView = store.view();
      expect(inFlightView.mode).toBe("ready");
      if (inFlightView.mode !== "ready") throw new Error("expected ready");
      expect(inFlightView.opening).toEqual(row);

      const url = `https://${NAME}:${PORT}/s/${HANDLE}/`;
      client.resolvePending(0, ok({ ok: true, value: { url } }));
      await openPromise;

      const doneView = store.view();
      expect(doneView.mode).toBe("ready");
      if (doneView.mode !== "ready") throw new Error("expected ready");
      expect(doneView.opening).toBeUndefined();
    });
  });

  describe("dismissError", () => {
    it("clears the error without touching rows", async () => {
      const client = createFakeClient();
      client.queueResult(remoteErr("boom"));
      client.queueResult(ok([]));
      const store = createSidecarsStore({
        client,
        record: { name: NAME, port: PORT },
        project: PROJECT,
      });
      await store.load();
      expect((store.view() as { error?: string }).error).toBe("boom");

      store.dismissError();

      const view = store.view();
      expect(view.mode).toBe("ready");
      if (view.mode !== "ready") throw new Error("expected ready");
      expect(view.error).toBeUndefined();
    });
  });
});
