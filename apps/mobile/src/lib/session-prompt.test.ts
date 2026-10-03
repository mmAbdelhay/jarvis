import { describe, expect, it, vi } from "vitest";
import { answerPrompt, fetchPrompt, parsePhonePrompt, promptLayout } from "./session-prompt";

describe("parsePhonePrompt", () => {
  it("keeps the question and the option labels, and nothing else", () => {
    expect(
      parsePhonePrompt({
        question: "Do you want to proceed?",
        options: [
          { label: "Yes", keys: "\r" },
          { label: "No", keys: "\x1b[B\r" },
        ],
        extra: "ignored",
      }),
    ).toEqual({ question: "Do you want to proceed?", options: ["Yes", "No"] });
  });

  it("refuses anything that is not a prompt", () => {
    for (const value of [
      null,
      "x",
      { question: 1, options: [] },
      { question: "q", options: [] },
      { question: "q", options: [{ label: 2 }] },
    ]) {
      expect(parsePhonePrompt(value)).toBeUndefined();
    }
  });
});

describe("talking to the laptop", () => {
  it("reads a prompt, and reads none when the call fails", async () => {
    const ok = {
      call: vi.fn(async () => ({
        ok: true as const,
        value: { question: "q?", options: [{ label: "Yes" }] },
      })),
    };
    expect(await fetchPrompt(ok, "s1")).toEqual({ question: "q?", options: ["Yes"] });
    expect(ok.call).toHaveBeenCalledWith("session:prompt", ["s1"], { whenNotOpen: "reject" });

    const down = { call: vi.fn(async () => ({ ok: false as const, error: { code: "offline" } })) };
    // biome-ignore lint/suspicious/noExplicitAny: a minimal RpcError stand-in.
    expect(await fetchPrompt(down as any, "s1")).toBeUndefined();
  });

  it("answers by index and label, and tells a changed prompt from a lost connection", async () => {
    const answered = { call: vi.fn(async () => ({ ok: true as const, value: { ok: true } })) };
    expect(await answerPrompt(answered, "s1", 1, "No")).toBe("answered");
    expect(answered.call).toHaveBeenCalledWith("session:answer", ["s1", 1, "No"], {
      whenNotOpen: "reject",
    });

    const changed = {
      call: vi.fn(async () => ({ ok: true as const, value: { ok: false, reason: "changed" } })),
    };
    expect(await answerPrompt(changed, "s1", 1, "No")).toBe("changed");

    const offline = {
      call: vi.fn(async () => ({ ok: false as const, error: { code: "offline" } })),
    };
    // biome-ignore lint/suspicious/noExplicitAny: a minimal RpcError stand-in.
    expect(await answerPrompt(offline as any, "s1", 1, "No")).toBe("offline");
  });
});

describe("promptLayout", () => {
  it("is a row for two options or fewer and stacked for three or more", () => {
    expect(promptLayout(1)).toBe("row");
    expect(promptLayout(2)).toBe("row");
    expect(promptLayout(3)).toBe("stacked");
  });
});
