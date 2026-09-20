import { describe, expect, it, vi } from "vitest";
import type { RpcClient, RpcResult } from "./rpc-client";
import { openTerminal, TERMINAL_OPEN_TIMEOUT_MS } from "./terminal-open";

/** A minimal fake `RpcClient`: only `call` is ever exercised by
 *  openTerminal() — everything else throws if it is somehow reached. */
function fakeClient(call: RpcClient["call"]): RpcClient {
  return {
    connect: () => {},
    disconnect: () => {},
    call,
    upload: async () => ({ ok: false, error: { kind: "offline" } }),
    subscribe: () => ({ ok: true, value: undefined }),
    unsubscribe: () => {},
    onPush: () => () => {},
    onState: () => () => {},
    state: () => "open",
    subscriptions: () => [],
    lastFrameAt: () => undefined,
  } as unknown as RpcClient;
}

describe("openTerminal", () => {
  it("calls terminal:open with [project], whenNotOpen reject and the bounded timeout", async () => {
    const call = vi.fn(
      async (): Promise<RpcResult> => ({ ok: true, value: { ok: true, value: "tab-1" } }),
    );
    const client = fakeClient(call);
    await openTerminal(client, "acme");
    expect(call).toHaveBeenCalledWith("terminal:open", ["acme"], {
      whenNotOpen: "reject",
      timeoutMs: TERMINAL_OPEN_TIMEOUT_MS,
    });
  });

  it("returns the tab id on success", async () => {
    const client = fakeClient(
      async () => ({ ok: true, value: { ok: true, value: "tab-42" } }) as RpcResult,
    );
    expect(await openTerminal(client, "acme")).toEqual({ ok: true, tabId: "tab-42" });
  });

  it("shows the server's own text for an unknownProject-style refusal", async () => {
    const client = fakeClient(
      async () =>
        ({
          ok: true,
          value: { ok: false, text: "Unknown project.", language: "en" },
        }) as RpcResult,
    );
    expect(await openTerminal(client, "nope")).toEqual({ ok: false, text: "Unknown project." });
  });

  it("falls back to common.loadFailed for a malformed reply", async () => {
    const client = fakeClient(
      async () => ({ ok: true, value: { not: "an envelope" } }) as RpcResult,
    );
    expect(await openTerminal(client, "acme")).toEqual({ ok: false, text: "common.loadFailed" });
  });

  it("falls back to common.loadFailed for a transport-level failure with no server text", async () => {
    const client = fakeClient(async () => ({ ok: false, error: { kind: "timeout" } }) as RpcResult);
    expect(await openTerminal(client, "acme")).toEqual({ ok: false, text: "common.loadFailed" });
  });

  it("passes a remote error's own text through verbatim", async () => {
    const client = fakeClient(
      async () =>
        ({
          ok: false,
          error: { kind: "remote", code: "internal", text: "server says no", language: "en" },
        }) as RpcResult,
    );
    expect(await openTerminal(client, "acme")).toEqual({ ok: false, text: "server says no" });
  });
});
