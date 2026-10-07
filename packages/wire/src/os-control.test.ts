import { describe, expect, it } from "vitest";
import {
  CARD_TIMEOUT_MS,
  OS_CONTROL_PUSHES,
  OS_CONTROL_REQUESTS,
  parseAgentConfirm,
  parseAgentPrompt,
  parseAgentStop,
  parseAuditList,
  parseBaseUrl,
  parseDoctorSkip,
  parseNoArgs,
  parseProviderDraft,
} from "./os-control.js";

describe("OS control channel names (contracts §3, M2 §2)", () => {
  it("are exactly the contract's", () => {
    expect(Object.values(OS_CONTROL_REQUESTS).sort()).toEqual(
      [
        "agent:confirm",
        "agent:prompt",
        "agent:stop",
        "audit:list",
        "doctor:skip",
        "doctor:start",
        "provider:list",
        "provider:probe",
        "provider:save",
        "updates:check",
      ].sort(),
    );
    expect(Object.values(OS_CONTROL_PUSHES).sort()).toEqual(
      ["agent:events", "doctor:state", "provider:status", "sys:snapshot"].sort(),
    );
    expect(CARD_TIMEOUT_MS).toBe(300_000);
  });
});

describe("parseNoArgs", () => {
  it("accepts [] and refuses anything else", () => {
    expect(parseNoArgs([])).toEqual({ ok: true, value: null });
    expect(parseNoArgs([{}]).ok).toBe(false);
  });
});

describe("parseAgentPrompt", () => {
  it("accepts 1-8000 characters", () => {
    expect(parseAgentPrompt([{ text: "my internet isn't working" }])).toEqual({
      ok: true,
      value: { text: "my internet isn't working" },
    });
    expect(parseAgentPrompt([{ text: "x".repeat(8000) }]).ok).toBe(true);
  });
  it("refuses empty, blank, too long, wrong type, extra args", () => {
    expect(parseAgentPrompt([{ text: "" }]).ok).toBe(false);
    expect(parseAgentPrompt([{ text: "   " }]).ok).toBe(false);
    expect(parseAgentPrompt([{ text: "x".repeat(8001) }]).ok).toBe(false);
    expect(parseAgentPrompt([{ text: 5 }]).ok).toBe(false);
    expect(parseAgentPrompt([]).ok).toBe(false);
    expect(parseAgentPrompt([{ text: "a" }, {}]).ok).toBe(false);
  });
  it("picks only the text field", () => {
    const parsed = parseAgentPrompt([{ text: "hi", admin: true }]);
    expect(parsed).toEqual({ ok: true, value: { text: "hi" } });
  });
});

describe("parseAgentStop", () => {
  it("needs a turn id", () => {
    expect(parseAgentStop([{ turnId: "abc123" }])).toEqual({
      ok: true,
      value: { turnId: "abc123" },
    });
    expect(parseAgentStop([{ turnId: "" }]).ok).toBe(false);
    expect(parseAgentStop([{ turnId: "../x" }]).ok).toBe(false);
  });
});

describe("parseAgentConfirm", () => {
  const good = {
    cardId: "c1",
    approve: true,
    ticked: ["item-1", "item-3"],
    secrets: { "item-3": { password: "hunter2" } },
  };

  it("accepts up to 200 ticked items (updates.apply, M2 contracts §2) and refuses 201", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `item-${i + 1}`);
    expect(parseAgentConfirm([{ ...good, ticked: ids(200), secrets: {} }]).ok).toBe(true);
    expect(parseAgentConfirm([{ ...good, ticked: ids(201), secrets: {} }]).ok).toBe(false);
  });

  it("parses a full answer", () => {
    const parsed = parseAgentConfirm([good]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.cardId).toBe("c1");
    expect(parsed.value.approve).toBe(true);
    expect(parsed.value.ticked).toEqual(["item-1", "item-3"]);
    expect(parsed.value.secrets["item-3"]?.["password"]).toBe("hunter2");
  });

  it("refuses a non-boolean approve, a non-array ticked, duplicates", () => {
    expect(parseAgentConfirm([{ ...good, approve: "yes" }]).ok).toBe(false);
    expect(parseAgentConfirm([{ ...good, ticked: "item-1" }]).ok).toBe(false);
    expect(parseAgentConfirm([{ ...good, ticked: ["item-1", "item-1"] }]).ok).toBe(false);
  });

  it("refuses secrets that are not strings or are too long", () => {
    expect(parseAgentConfirm([{ ...good, secrets: { "item-3": { password: 1 } } }]).ok).toBe(false);
    expect(
      parseAgentConfirm([{ ...good, secrets: { "item-3": { password: "x".repeat(1025) } } }]).ok,
    ).toBe(false);
  });

  it("refuses a __proto__ key instead of letting it touch a prototype", () => {
    const hostile = JSON.parse(
      '{"cardId":"c1","approve":true,"ticked":["item-1"],"secrets":{"__proto__":{"polluted":"yes"}}}',
    ) as unknown;
    expect(parseAgentConfirm([hostile]).ok).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("returns null-prototype records", () => {
    const parsed = parseAgentConfirm([good]);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(Object.getPrototypeOf(parsed.value.secrets)).toBeNull();
  });
});

describe("parseBaseUrl", () => {
  it("normalises http(s) URLs and drops a trailing slash", () => {
    expect(parseBaseUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(parseBaseUrl("http://192.168.1.20:11434")).toBe("http://192.168.1.20:11434");
  });
  it("refuses other schemes, credentials, queries, junk", () => {
    expect(parseBaseUrl("file:///etc/passwd")).toBeUndefined();
    expect(parseBaseUrl("https://user:pw@example.com")).toBeUndefined();
    expect(parseBaseUrl("https://example.com/?key=1")).toBeUndefined();
    expect(parseBaseUrl("not a url")).toBeUndefined();
    expect(parseBaseUrl(42)).toBeUndefined();
  });
});

describe("parseProviderDraft", () => {
  it("parses each kind", () => {
    expect(
      parseProviderDraft([
        { kind: "ollama", baseUrl: "http://localhost:11434/", model: "qwen3:8b" },
      ]),
    ).toEqual({
      ok: true,
      value: { kind: "ollama", baseUrl: "http://localhost:11434", model: "qwen3:8b" },
    });
    const anthropic = parseProviderDraft([
      {
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "claude-sonnet-4-5",
        apiKey: "sk-ant-x",
      },
    ]);
    expect(anthropic.ok && anthropic.value.apiKey).toBe("sk-ant-x");
  });
  it("accepts an empty model, which provider:probe uses to list models only (contracts §6 #10)", () => {
    expect(
      parseProviderDraft([{ kind: "ollama", baseUrl: "http://localhost:11434", model: "" }]),
    ).toEqual({
      ok: true,
      value: { kind: "ollama", baseUrl: "http://localhost:11434", model: "" },
    });
  });
  it("refuses unknown kinds, bad models, keys with whitespace", () => {
    expect(parseProviderDraft([{ kind: "gemini", baseUrl: "https://x.dev", model: "m" }]).ok).toBe(
      false,
    );
    expect(
      parseProviderDraft([{ kind: "ollama", baseUrl: "https://x.dev", model: "x".repeat(201) }]).ok,
    ).toBe(false);
    expect(parseProviderDraft([{ kind: "ollama", baseUrl: "https://x.dev", model: 5 }]).ok).toBe(
      false,
    );
    expect(
      parseProviderDraft([{ kind: "ollama", baseUrl: "https://x.dev", model: "m\n" }]).ok,
    ).toBe(false);
    expect(
      parseProviderDraft([
        { kind: "anthropic", baseUrl: "https://x.dev", model: "m", apiKey: "a b" },
      ]).ok,
    ).toBe(false);
  });
});

describe("parseDoctorSkip and parseAuditList", () => {
  it("accepts known step ids only", () => {
    expect(parseDoctorSkip([{ stepId: "dns" }])).toEqual({ ok: true, value: { stepId: "dns" } });
    expect(parseDoctorSkip([{ stepId: "reboot" }]).ok).toBe(false);
  });
  it("bounds limit to 1-500 and beforeTs to a finite number", () => {
    expect(parseAuditList([{ limit: 50 }])).toEqual({ ok: true, value: { limit: 50 } });
    expect(parseAuditList([{ limit: 10, beforeTs: 1700000000000 }])).toEqual({
      ok: true,
      value: { limit: 10, beforeTs: 1700000000000 },
    });
    expect(parseAuditList([{ limit: 0 }]).ok).toBe(false);
    expect(parseAuditList([{ limit: 501 }]).ok).toBe(false);
    expect(parseAuditList([{ limit: 1.5 }]).ok).toBe(false);
    expect(parseAuditList([{ limit: 5, beforeTs: Number.POSITIVE_INFINITY }]).ok).toBe(false);
  });
});
