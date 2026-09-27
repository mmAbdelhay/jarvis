import { describe, expect, it } from "vitest";
import type { RpcResult } from "./rpc-client";
import { type CreatePasskey, passkeyLabel, registerPasskey } from "./passkey-registration";

const OPTIONS = {
  challenge: "AQID",
  rpId: "laptop.tail.ts.net",
  user: { id: "BAUG", name: "owner", displayName: "Jarvis owner" },
};
const CREATED = { credentialId: "-w", clientDataJSON: "AQ", attestationObject: "Bw" };

function rpcDouble(replies: Record<string, RpcResult[]>) {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  return {
    calls,
    rpc: {
      async call(channel: string, args: unknown[]): Promise<RpcResult> {
        calls.push({ channel, args });
        return replies[channel]?.shift() ?? { ok: true, value: null };
      },
    },
  };
}

function remote(code: string): RpcResult {
  return {
    ok: false,
    error: { kind: "remote", code, text: "x", language: "en" },
  } as RpcResult;
}

const create: CreatePasskey = async () => CREATED;

describe("registerPasskey", () => {
  it("begins with the re-entered password, creates, then finishes with the label", async () => {
    const double = rpcDouble({ "auth:passkeyRegisterBegin": [{ ok: true, value: OPTIONS }] });
    const asked: unknown[] = [];
    const outcome = await registerPasskey({
      rpc: double.rpc,
      password: "pw",
      label: "Chrome · macOS",
      create: async (options) => {
        asked.push(options);
        return CREATED;
      },
    });
    expect(outcome).toBe("registered");
    expect(asked).toEqual([OPTIONS]);
    expect(double.calls).toEqual([
      { channel: "auth:passkeyRegisterBegin", args: [{ password: "pw" }] },
      { channel: "auth:passkeyRegisterFinish", args: [{ ...CREATED, label: "Chrome · macOS" }] },
    ]);
  });

  it.each([
    ["forbidden", "wrong-password"],
    ["rate-limited", "rate-limited"],
    ["locked", "locked"],
    ["unsupported", "unsupported"],
    ["internal", "failed"],
  ] as const)("a begin refused %s answers %s and never opens the sheet", async (code, expected) => {
    const double = rpcDouble({ "auth:passkeyRegisterBegin": [remote(code)] });
    let asked = false;
    const outcome = await registerPasskey({
      rpc: double.rpc,
      password: "pw",
      label: "x",
      create: async () => {
        asked = true;
        return CREATED;
      },
    });
    expect(outcome).toBe(expected);
    expect(asked).toBe(false);
    expect(double.calls).toHaveLength(1);
  });

  it("offline begin answers offline", async () => {
    const double = rpcDouble({
      "auth:passkeyRegisterBegin": [{ ok: false, error: { kind: "offline" } }],
    });
    expect(await registerPasskey({ rpc: double.rpc, password: "pw", label: "x", create })).toBe(
      "offline",
    );
  });

  it("a dismissed sheet, or a passkey this authenticator already holds, sends no finish", async () => {
    for (const answer of ["cancelled", "exists"] as const) {
      const double = rpcDouble({ "auth:passkeyRegisterBegin": [{ ok: true, value: OPTIONS }] });
      const outcome = await registerPasskey({
        rpc: double.rpc,
        password: "pw",
        label: "x",
        create: async () => answer,
      });
      expect(outcome).toBe(answer);
      expect(double.calls).toHaveLength(1);
    }
  });

  it("a malformed begin answer never reaches the browser", async () => {
    const double = rpcDouble({ "auth:passkeyRegisterBegin": [{ ok: true, value: { rpId: 1 } }] });
    let asked = false;
    const outcome = await registerPasskey({
      rpc: double.rpc,
      password: "pw",
      label: "x",
      create: async () => {
        asked = true;
        return CREATED;
      },
    });
    expect(outcome).toBe("failed");
    expect(asked).toBe(false);
  });

  it("a refused finish is a failure", async () => {
    const double = rpcDouble({
      "auth:passkeyRegisterBegin": [{ ok: true, value: OPTIONS }],
      "auth:passkeyRegisterFinish": [remote("forbidden")],
    });
    expect(await registerPasskey({ rpc: double.rpc, password: "pw", label: "x", create })).toBe(
      "failed",
    );
  });

  it("a browser error is a failure", async () => {
    const double = rpcDouble({ "auth:passkeyRegisterBegin": [{ ok: true, value: OPTIONS }] });
    const outcome = await registerPasskey({
      rpc: double.rpc,
      password: "pw",
      label: "x",
      create: async () => {
        throw new Error("NotSupportedError");
      },
    });
    expect(outcome).toBe("failed");
  });
});

describe("passkeyLabel", () => {
  it("trims, caps at the wire limit and falls back when empty", () => {
    expect(passkeyLabel("  Chrome · macOS  ", "Web browser")).toBe("Chrome · macOS");
    expect(passkeyLabel("   ", "Web browser")).toBe("Web browser");
    expect(passkeyLabel("x".repeat(100), "Web browser")).toHaveLength(64);
  });
});
