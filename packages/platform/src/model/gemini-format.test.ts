// packages/platform/src/model/gemini-format.test.ts
import type { ModelMessage } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import {
  createThoughtSignatures,
  GEMINI_DUMMY_THOUGHT_SIGNATURE,
  geminiApiRoot,
  geminiModelPath,
  geminiNameMap,
  needsThoughtSignatures,
  toGeminiContents,
  toGeminiName,
  toGeminiTools,
} from "./gemini-format.js";

describe("toGeminiName", () => {
  it("keeps names Gemini accepts: the registry's underscore names and dotted names", () => {
    expect(toGeminiName("pkg_install")).toBe("pkg_install");
    expect(toGeminiName("updates_apply")).toBe("updates_apply");
    expect(toGeminiName("pkg.install")).toBe("pkg.install");
  });

  it("prefixes a name that does not start with a letter or underscore and caps it at 64", () => {
    expect(toGeminiName("2fa_check")).toBe("_2fa_check");
    expect(toGeminiName("-x")).toBe("_-x");
    const long = `9${"a".repeat(80)}`;
    expect(toGeminiName(long)).toHaveLength(64);
    expect(toGeminiName(long).startsWith("_9")).toBe(true);
  });

  it("maps every declared name back to the model name", () => {
    const map = geminiNameMap([
      { name: "net_status", description: "", inputSchema: {} },
      { name: "2fa_check", description: "", inputSchema: {} },
    ]);
    expect(map.get("net_status")).toBe("net_status");
    expect(map.get("_2fa_check")).toBe("2fa_check");
  });
});

describe("geminiApiRoot and geminiModelPath", () => {
  it("adds /v1beta to a bare base URL and keeps an explicit version", () => {
    expect(geminiApiRoot("https://generativelanguage.googleapis.com")).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
    expect(geminiApiRoot("https://generativelanguage.googleapis.com/")).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
    expect(geminiApiRoot("https://proxy.example/gemini/v1beta")).toBe(
      "https://proxy.example/gemini/v1beta",
    );
    expect(geminiApiRoot("https://proxy.example/v1")).toBe("https://proxy.example/v1");
  });

  it("puts a bare model under models/ and encodes each segment", () => {
    expect(geminiModelPath("gemini-2.5-flash")).toBe("models/gemini-2.5-flash");
    expect(geminiModelPath("models/gemini-2.5-flash")).toBe("models/gemini-2.5-flash");
    expect(geminiModelPath("tunedModels/my model")).toBe("tunedModels/my%20model");
  });

  it("asks for placeholder signatures only on models newer than 2.x", () => {
    expect(needsThoughtSignatures("gemini-2.5-flash")).toBe(false);
    expect(needsThoughtSignatures("models/gemini-2.0-flash")).toBe(false);
    expect(needsThoughtSignatures("gemini-1.5-pro")).toBe(false);
    expect(needsThoughtSignatures("gemini-3-pro-preview")).toBe(true);
    expect(needsThoughtSignatures("gemini-3.0-flash")).toBe(true);
  });
});

describe("createThoughtSignatures", () => {
  it("forgets the oldest entry past its size", () => {
    const store = createThoughtSignatures(2);
    store.set("a", "1");
    store.set("b", "2");
    store.set("c", "3");
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toBe("2");
    expect(store.get("c")).toBe("3");
  });
});

describe("toGeminiContents", () => {
  const history: ModelMessage[] = [
    { role: "user", text: "update my computer" },
    {
      role: "assistant",
      text: "Checking.",
      toolCalls: [
        { id: "gemini-1", name: "updates_list", input: {} },
        { id: "gemini-2", name: "2fa_check", input: "not an object" },
      ],
    },
    {
      role: "tool",
      results: [
        {
          callId: "gemini-1",
          name: "updates_list",
          content: "<untrusted-data>{}</untrusted-data>",
          isError: false,
        },
        { callId: "gemini-2", name: "2fa_check", content: "boom", isError: true },
      ],
    },
    { role: "assistant", text: "", toolCalls: [] },
  ];

  it("maps users, model turns with stored signatures, and function responses; drops empty turns", () => {
    const signatures = createThoughtSignatures();
    signatures.set("gemini-1", "sig-A");
    expect(toGeminiContents(history, signatures, { dummySignatures: true })).toEqual([
      { role: "user", parts: [{ text: "update my computer" }] },
      {
        role: "model",
        parts: [
          { text: "Checking." },
          { functionCall: { name: "updates_list", args: {} }, thoughtSignature: "sig-A" },
          { functionCall: { name: "_2fa_check", args: {} } },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "updates_list",
              response: { output: "<untrusted-data>{}</untrusted-data>" },
            },
          },
          { functionResponse: { name: "_2fa_check", response: { error: "boom" } } },
        ],
      },
    ]);
  });

  it("puts a placeholder signature on the first call of foreign history only when asked", () => {
    const foreign: ModelMessage[] = [
      { role: "user", text: "hi" },
      {
        role: "assistant",
        text: "",
        toolCalls: [
          { id: "ollama-1", name: "net_status", input: {} },
          { id: "ollama-2", name: "sys_health", input: {} },
        ],
      },
    ];
    const withDummy = toGeminiContents(foreign, createThoughtSignatures(), {
      dummySignatures: true,
    });
    expect(withDummy[1]).toEqual({
      role: "model",
      parts: [
        {
          functionCall: { name: "net_status", args: {} },
          thoughtSignature: GEMINI_DUMMY_THOUGHT_SIGNATURE,
        },
        { functionCall: { name: "sys_health", args: {} } },
      ],
    });
    const without = toGeminiContents(foreign, createThoughtSignatures(), {
      dummySignatures: false,
    });
    expect(without[1]).toEqual({
      role: "model",
      parts: [
        { functionCall: { name: "net_status", args: {} } },
        { functionCall: { name: "sys_health", args: {} } },
      ],
    });
  });
});

describe("toGeminiTools", () => {
  it("declares functions with full JSON Schema, minus $schema; no tools -> []", () => {
    expect(toGeminiTools([])).toEqual([]);
    expect(
      toGeminiTools([
        {
          name: "updates_apply",
          description: "Apply updates",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { items: { type: "array", maxItems: 200 } },
            required: ["items"],
            additionalProperties: false,
          },
        },
      ]),
    ).toEqual([
      {
        functionDeclarations: [
          {
            name: "updates_apply",
            description: "Apply updates",
            parametersJsonSchema: {
              type: "object",
              properties: { items: { type: "array", maxItems: 200 } },
              required: ["items"],
              additionalProperties: false,
            },
          },
        ],
      },
    ]);
  });
});
