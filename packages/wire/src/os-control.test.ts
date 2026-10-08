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
  parseMemoryDelete,
  parseMemoryList,
  parseMemorySetEnabled,
  parseNoArgs,
  parseProviderDraft,
  parseProviderSave,
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
        "memory:clear",
        "memory:delete",
        "memory:list",
        "memory:setEnabled",
        "provider:list",
        "provider:probe",
        "provider:save",
        "registry:list",
        "updates:check",
        "voice:setSpeak",
        "voice:stop",
        "agent:undo",
        "pairing:answer",
        "sys:setLocked",
        "remote:status",
        "remote:configure",
        "remote:setOwnerPassword",
        "remote:revoke",
        "pairing:open",
        "pairing:cancel",
      ].sort(),
    );
    expect(Object.values(OS_CONTROL_PUSHES).sort()).toEqual(
      [
        "agent:events",
        "doctor:state",
        "provider:status",
        "sys:snapshot",
        "voice:state",
        "pairing:pending",
        "remote:status",
      ].sort(),
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
  it("accepts the gemini kind (M2 contracts §3)", () => {
    expect(
      parseProviderDraft([
        {
          kind: "gemini",
          baseUrl: "https://generativelanguage.googleapis.com",
          model: "gemini-2.5-flash",
          apiKey: "AIza-k",
        },
      ]),
    ).toEqual({
      ok: true,
      value: {
        kind: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com",
        model: "gemini-2.5-flash",
        apiKey: "AIza-k",
      },
    });
  });

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
    expect(parseProviderDraft([{ kind: "mistral", baseUrl: "https://x.dev", model: "m" }]).ok).toBe(
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

describe("parseProviderSave (M2.5 contracts §2)", () => {
  const entry = {
    id: "local",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434/",
    model: "qwen3:8b",
  };

  it("parses an ordered list with ids and the cloud-fallback flag", () => {
    expect(
      parseProviderSave([
        {
          providers: [
            entry,
            {
              id: "work",
              kind: "anthropic",
              baseUrl: "https://api.anthropic.com",
              model: "claude-sonnet-5-5",
              apiKey: "sk-ant-x",
            },
          ],
          allowCloudFallback: true,
        },
      ]),
    ).toEqual({
      ok: true,
      value: {
        providers: [
          { id: "local", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b" },
          {
            id: "work",
            kind: "anthropic",
            baseUrl: "https://api.anthropic.com",
            model: "claude-sonnet-5-5",
            apiKey: "sk-ant-x",
          },
        ],
        allowCloudFallback: true,
      },
    });
  });

  it("accepts an empty list (no providers)", () => {
    expect(parseProviderSave([{ providers: [], allowCloudFallback: false }]).ok).toBe(true);
  });

  it("refuses bad ids, duplicates, empty models, more than 8, and a missing flag", () => {
    const bad = (value: unknown) => expect(parseProviderSave([value]).ok).toBe(false);
    bad({ providers: [{ ...entry, id: "Local" }], allowCloudFallback: false });
    bad({ providers: [{ ...entry, id: "-x" }], allowCloudFallback: false });
    bad({ providers: [{ ...entry, id: "a".repeat(33) }], allowCloudFallback: false });
    bad({ providers: [{ ...entry, id: undefined }], allowCloudFallback: false });
    bad({ providers: [entry, entry], allowCloudFallback: false });
    bad({ providers: [{ ...entry, model: "" }], allowCloudFallback: false });
    bad({
      providers: Array.from({ length: 9 }, (_, i) => ({ ...entry, id: `p${i}` })),
      allowCloudFallback: false,
    });
    bad({ providers: [entry] });
    bad({ providers: [{ ...entry, kind: "mistral" }], allowCloudFallback: false });
  });
});

describe("parseProviderDraft with an id (probe with a stored key)", () => {
  it("keeps a valid id and refuses a bad one", () => {
    const draft = { kind: "ollama", baseUrl: "http://10.0.0.2:11434", model: "" };
    expect(parseProviderDraft([{ ...draft, id: "lan" }])).toEqual({
      ok: true,
      value: { ...draft, id: "lan" },
    });
    expect(parseProviderDraft([draft])).toEqual({ ok: true, value: draft });
    expect(parseProviderDraft([{ ...draft, id: "LAN!" }]).ok).toBe(false);
  });
});

describe("memory channels", () => {
  it("parses memory:list limits 1-500", () => {
    expect(parseMemoryList([{ limit: 50 }])).toEqual({ ok: true, value: { limit: 50 } });
    expect(parseMemoryList([{ limit: 0 }]).ok).toBe(false);
    expect(parseMemoryList([{ limit: 501 }]).ok).toBe(false);
    expect(parseMemoryList([{ limit: 1.5 }]).ok).toBe(false);
    expect(parseMemoryList([]).ok).toBe(false);
  });

  it("parses memory:delete ids", () => {
    expect(parseMemoryDelete([{ id: "0a1b2c3d4e5f6789" }])).toEqual({
      ok: true,
      value: { id: "0a1b2c3d4e5f6789" },
    });
    expect(parseMemoryDelete([{ id: "../x" }]).ok).toBe(false);
    expect(parseMemoryDelete([{}]).ok).toBe(false);
  });

  it("parses memory:setEnabled (contracts §7 #9)", () => {
    expect(parseMemorySetEnabled([{ enabled: false }])).toEqual({
      ok: true,
      value: { enabled: false },
    });
    expect(parseMemorySetEnabled([{ enabled: "yes" }]).ok).toBe(false);
    expect(parseMemorySetEnabled([]).ok).toBe(false);
  });
});
