import { describe, expect, it, vi } from "vitest";
import { AGENT_ATTACH_MAX_BYTES } from "./agent-attach.js";
import { attachFromRenderer } from "./agent-attach-ipc.js";

const client = () => ({
  attachAgentFile: vi.fn(async () => ({ ok: true, path: "/p" })),
});

describe("attachFromRenderer", () => {
  it("passes a Uint8Array, an ArrayBuffer and a Node Buffer on as bytes with the name", async () => {
    for (const bytes of [
      new Uint8Array([1, 2]),
      new Uint8Array([1, 2]).buffer,
      Buffer.from([1, 2]),
    ]) {
      const c = client();
      expect(await attachFromRenderer(c, ["t1", { name: "a.png", bytes }])).toEqual({
        ok: true,
        path: "/p",
      });
      expect(c.attachAgentFile).toHaveBeenCalledWith("t1", "a.png", new Uint8Array([1, 2]));
    }
  });

  it("refuses a malformed request without calling the core", async () => {
    for (const args of [
      [],
      [7, { name: "a", bytes: new Uint8Array(1) }],
      ["t1", null],
      ["t1", { name: 5, bytes: new Uint8Array(1) }],
      ["t1", { name: "a", bytes: "text" }],
      ["t1", { name: "a", bytes: [1, 2] }],
      ["t1", { name: "a", bytes: new Uint8Array(0) }],
      ["t1", { name: "a", bytes: { 0: 1, 1: 2 } }],
    ]) {
      const c = client();
      expect(await attachFromRenderer(c, args)).toEqual({ ok: false, reason: "invalid" });
      expect(c.attachAgentFile).not.toHaveBeenCalled();
    }
  });

  it("answers toolarge for an oversize file, still without calling the core", async () => {
    const c = client();
    const big = new Uint8Array(AGENT_ATTACH_MAX_BYTES + 1);
    expect(await attachFromRenderer(c, ["t1", { name: "a.png", bytes: big }])).toEqual({
      ok: false,
      reason: "toolarge",
    });
    expect(c.attachAgentFile).not.toHaveBeenCalled();
  });

  it("answers failed, never throws, when the core cannot be reached", async () => {
    const c = {
      attachAgentFile: vi.fn(async () => {
        throw new Error("secret path");
      }),
    };
    expect(
      await attachFromRenderer(c, ["t1", { name: "a.png", bytes: new Uint8Array(1) }]),
    ).toEqual({
      ok: false,
      reason: "failed",
    });
  });
});
