import { OS_CONTROL_BLOBS, OS_CONTROL_PUSHES, OS_CONTROL_REQUESTS } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import type { ConfirmFrom } from "@jarvis/core";
import { ControlRequestError } from "../control/messages.js";
import type { OsAgent } from "./agent-service.js";
import { createOsRouter, type OsOrigin, type OsRouter } from "./os-binding.js";
import {
  createPhoneRequestHandler,
  PHONE_BLOBS,
  PHONE_PUSHES,
  phoneAuditPolicy,
} from "./phone-policy.js";

const DEVICE = { id: "d".repeat(32), name: "Pixel 8" };

function fakeRouter(fail?: Error) {
  const calls: { kind: "invoke" | "upload"; channel: string; origin: OsOrigin; bytes?: number }[] =
    [];
  const router: OsRouter = {
    invoke: async (channel, _args, origin) => {
      calls.push({ kind: "invoke", channel, origin });
      if (fail !== undefined) throw fail;
      return { ok: true };
    },
    upload: async (channel, _args, bytes, origin) => {
      calls.push({ kind: "upload", channel, origin, bytes: bytes.byteLength });
      return { text: "yes", lang: "en", action: "approve" };
    },
  };
  return { router, calls };
}

describe("the phone's OS surface (Rafiq M3 §2)", () => {
  it("serves exactly the contract's request channels", async () => {
    const { router, calls } = fakeRouter();
    const handle = createPhoneRequestHandler(
      () => router,
      () => {},
    );
    for (const channel of [
      "agent:prompt",
      "agent:stop",
      "agent:confirm",
      "agent:undo",
      "audit:list",
      "memory:list",
      "account:status",
    ]) {
      await expect(handle(channel, [], DEVICE)).resolves.toEqual({
        kind: "value",
        value: { ok: true },
      });
    }
    expect(calls.every((c) => c.origin.kind === "phone")).toBe(true);
  });

  it("refuses every other OS channel, including the contract's named refusals", async () => {
    const { router, calls } = fakeRouter();
    const handle = createPhoneRequestHandler(
      () => router,
      () => {},
    );
    const allowed = new Set([
      "agent:prompt",
      "agent:stop",
      "agent:confirm",
      "agent:undo",
      "audit:list",
      "memory:list",
      "account:status",
    ]);
    for (const channel of Object.values(OS_CONTROL_REQUESTS).filter((c) => !allowed.has(c))) {
      await expect(handle(channel, [], DEVICE)).resolves.toEqual({ kind: "forbidden" });
    }
    for (const channel of [
      "provider:save",
      "memory:clear",
      "memory:setEnabled",
      "registry:list",
      "sys:setLocked",
      "pairing:answer",
    ]) {
      await expect(handle(channel, [], DEVICE)).resolves.toMatchObject({
        kind: expect.stringMatching(/forbidden|unknown-channel/),
      });
    }
    await expect(handle("voice:utterance", [], DEVICE)).resolves.toEqual({ kind: "forbidden" });
    await expect(handle("agent:prompt", [], DEVICE, new Uint8Array(4))).resolves.toEqual({
      kind: "forbidden",
    });
    await expect(handle("terminal:input", [], DEVICE)).resolves.toEqual({
      kind: "unknown-channel",
    });
    await expect(handle("__proto__", [], DEVICE)).resolves.toEqual({ kind: "unknown-channel" });
    expect(calls).toEqual([]);
  });

  it("takes a voice:utterance blob with the authenticated device as origin", async () => {
    const { router, calls } = fakeRouter();
    const handle = createPhoneRequestHandler(
      () => router,
      () => {},
    );
    await expect(
      handle(
        "voice:utterance",
        [{ cardId: "c1", deviceName: "spoofed" }],
        DEVICE,
        new Uint8Array(100),
      ),
    ).resolves.toMatchObject({ kind: "value" });
    expect(calls[0]).toEqual({
      kind: "upload",
      channel: "voice:utterance",
      origin: { kind: "phone", device: DEVICE },
      bytes: 100,
    });
    expect(PHONE_BLOBS.get(OS_CONTROL_BLOBS.voiceUtterance)).toBe(4_194_304);
  });

  it("audits a confirm from a hostile device name as a bounded phone: via", async () => {
    let seen: ConfirmFrom | undefined;
    const agent = {
      confirm: (_answer: unknown, from?: ConfirmFrom) => {
        seen = from;
        return null;
      },
    } as unknown as OsAgent;
    const handle = createPhoneRequestHandler(
      () => createOsRouter({ agent }),
      () => {},
    );
    await expect(
      handle(
        "agent:confirm",
        [{ cardId: "c1", approve: true, ticked: [], secrets: {}, via: "desktop" }],
        {
          id: DEVICE.id,
          name: `Pixel\u0007 ${"x".repeat(300)}`,
        },
      ),
    ).resolves.toMatchObject({ kind: "value" });
    expect(seen?.allowPassword).toBe(false);
    expect(seen?.via.startsWith("phone:Pixel x")).toBe(true);
    expect(seen?.via.length).toBe("phone:".length + 64);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this checks.
    expect(seen?.via).not.toMatch(/[\u0000-\u001f]/);
  });

  it("passes typed refusals to the phone and hides everything else", async () => {
    const locked = createPhoneRequestHandler(
      () => fakeRouter(new ControlRequestError("locked", "The screen is locked.")).router,
      () => {},
    );
    await expect(locked("agent:confirm", [], DEVICE)).resolves.toEqual({
      kind: "refused",
      code: "locked",
      text: "The screen is locked.",
    });
    const logs: string[] = [];
    const broken = createPhoneRequestHandler(
      () => fakeRouter(new Error("/home/jarvis/secret path")).router,
      (l) => logs.push(l),
    );
    await expect(broken("agent:prompt", [], DEVICE)).rejects.toThrow();
    expect(logs.join("\n")).not.toContain("secret path");
  });

  it("forwards only agent:events and sys:snapshot, and audits actions", () => {
    expect([...PHONE_PUSHES.keys()].sort()).toEqual(
      [OS_CONTROL_PUSHES.agentEvents, OS_CONTROL_PUSHES.sysSnapshot].sort(),
    );
    expect(PHONE_PUSHES.get("agent:events")).toEqual({ kind: "reliable" });
    expect(PHONE_PUSHES.get("sys:snapshot")).toEqual({ kind: "latest" });
    expect(phoneAuditPolicy("agent:confirm")).toBe("always");
    expect(phoneAuditPolicy("voice:utterance")).toBe("always");
    expect(phoneAuditPolicy("audit:list")).toBe("never");
  });
});
