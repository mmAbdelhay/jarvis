import { describe, expect, it } from "vitest";
import {
  type ConfigIo,
  parseProviderSection,
  readProviderSection,
  writeProviderSection,
} from "./provider-config.js";

function memoryIo(initial?: string) {
  const files = new Map<string, string>(initial === undefined ? [] : [["/c/jarvis.yaml", initial]]);
  const io: ConfigIo = {
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    },
    writeFile: async (path, text) => {
      files.set(path, text);
    },
  };
  return { io, files };
}

describe("parseProviderSection", () => {
  it("parses a gemini section; subscription stays anthropic-only", () => {
    expect(
      parseProviderSection({
        kind: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com",
        model: "gemini-2.5-flash",
      }),
    ).toEqual({
      kind: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-2.5-flash",
      auth: "api-key",
      supportsTools: true,
    });
    expect(() =>
      parseProviderSection({
        kind: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com",
        model: "m",
        auth: "subscription",
      }),
    ).toThrow(/subscription for anthropic/);
  });

  it("parses a section and fills defaults", () => {
    expect(
      parseProviderSection({
        kind: "ollama",
        baseUrl: "http://localhost:11434/",
        model: "qwen3:8b",
      }),
    ).toEqual({
      kind: "ollama",
      baseUrl: "http://localhost:11434",
      model: "qwen3:8b",
      auth: "api-key",
      supportsTools: true,
    });
    expect(
      parseProviderSection({
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "claude-sonnet-4-5",
        auth: "subscription",
        tools: false,
      }),
    ).toMatchObject({ auth: "subscription", supportsTools: false });
  });
  it("answers null for no section and names the bad key otherwise", () => {
    expect(parseProviderSection(undefined)).toBeNull();
    expect(() =>
      parseProviderSection({ kind: "mistral", baseUrl: "https://x.dev", model: "m" }),
    ).toThrow(/provider.kind/);
    expect(() => parseProviderSection({ kind: "ollama", baseUrl: "ftp://x", model: "m" })).toThrow(
      /provider.baseUrl/,
    );
    expect(() => parseProviderSection({ kind: "ollama", baseUrl: "http://x", model: "" })).toThrow(
      /provider.model/,
    );
    expect(() =>
      parseProviderSection({
        kind: "ollama",
        baseUrl: "http://x",
        model: "m",
        auth: "subscription",
      }),
    ).toThrow(/provider.auth/);
  });
});

describe("read/writeProviderSection", () => {
  it("reads null when the file does not exist", async () => {
    await expect(readProviderSection("/c/jarvis.yaml", memoryIo().io)).resolves.toBeNull();
  });

  it("creates the file, and keeps the rest of a hand-edited file and its comments", async () => {
    const fresh = memoryIo();
    await writeProviderSection(
      "/c/jarvis.yaml",
      {
        kind: "ollama",
        baseUrl: "http://localhost:11434",
        model: "qwen3:8b",
        auth: "api-key",
        supportsTools: true,
      },
      fresh.io,
    );
    expect(fresh.files.get("/c/jarvis.yaml")).toBe(
      "provider:\n  kind: ollama\n  baseUrl: http://localhost:11434\n  model: qwen3:8b\n",
    );

    const edited = memoryIo(
      "# mine\nbrain:\n  systemPrompt: hi # keep\nprovider:\n  kind: anthropic\n  baseUrl: https://api.anthropic.com\n  model: old\n",
    );
    await writeProviderSection(
      "/c/jarvis.yaml",
      {
        kind: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4.1-mini",
        auth: "api-key",
        supportsTools: false,
      },
      edited.io,
    );
    const text = edited.files.get("/c/jarvis.yaml") ?? "";
    expect(text).toContain("# mine");
    expect(text).toContain("systemPrompt: hi # keep");
    expect(text).toContain("kind: openai-compatible");
    expect(text).toContain("tools: false");
    await expect(readProviderSection("/c/jarvis.yaml", edited.io)).resolves.toMatchObject({
      model: "gpt-4.1-mini",
      supportsTools: false,
    });
  });

  it("refuses to rewrite a file that does not parse", async () => {
    const broken = memoryIo("provider: [unclosed\n");
    await expect(
      writeProviderSection(
        "/c/jarvis.yaml",
        { kind: "ollama", baseUrl: "http://x", model: "m", auth: "api-key", supportsTools: true },
        broken.io,
      ),
    ).rejects.toThrow(/does not parse/);
    expect(broken.files.get("/c/jarvis.yaml")).toBe("provider: [unclosed\n");
  });
});

describe("account providers (Plan Y §2.1)", () => {
  it("parses kind account with its account and forces the display URL", () => {
    expect(
      parseProviderSection({
        kind: "account",
        account: "copilot",
        baseUrl: "http://x.example",
        model: "default",
      }),
    ).toEqual({
      kind: "account",
      account: "copilot",
      baseUrl: "https://github.com/copilot",
      model: "default",
      auth: "api-key",
      supportsTools: true,
    });
  });

  it("refuses an account provider without a known account, and an account on another kind", () => {
    expect(() => parseProviderSection({ kind: "account", model: "default" })).toThrow(
      /provider.account/,
    );
    expect(() =>
      parseProviderSection({ kind: "account", account: "bard", model: "default" }),
    ).toThrow(/provider.account/);
    expect(() =>
      parseProviderSection({
        kind: "anthropic",
        account: "claude",
        baseUrl: "https://api.anthropic.com",
        model: "m",
      }),
    ).toThrow(/only for kind account/);
  });
});
