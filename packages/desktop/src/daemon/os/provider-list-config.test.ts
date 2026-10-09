import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { ConfigIo } from "./provider-config.js";
import {
  LEGACY_PROVIDER_ID,
  emptyBrain,
  parseOsBrainConfig,
  readOsBrainConfig,
  writeOsProviders,
  writeOsLanguage,
} from "./provider-list-config.js";

const PATH = "/home/u/.config/jarvis/jarvis.yaml";

function memoryIo(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set(PATH, initial);
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

const local = {
  id: "local",
  kind: "ollama" as const,
  baseUrl: "http://127.0.0.1:11434",
  model: "qwen3:8b",
  auth: "api-key" as const,
  supportsTools: true,
};

describe("parseOsBrainConfig (M2.5 contracts §1)", () => {
  it("migrates the M1/M2 single provider to one entry with id default", () => {
    expect(
      parseOsBrainConfig({
        provider: { kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b" },
      }),
    ).toEqual({
      providers: [{ ...local, id: LEGACY_PROVIDER_ID }],
      allowCloudFallback: false,
      memoryEnabled: true,
      migratedFromLegacy: true,
      language: null,
    });
  });

  it("reads the ordered list, the cloud-fallback flag and memory.enabled", () => {
    const config = parseOsBrainConfig({
      os: {
        providers: [
          { id: "local", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b" },
          {
            id: "work",
            kind: "anthropic",
            baseUrl: "https://api.anthropic.com",
            model: "claude-sonnet-5-5",
            tools: false,
          },
        ],
        allowCloudFallback: true,
        memory: { enabled: false },
      },
    });
    expect(config.providers.map((p) => p.id)).toEqual(["local", "work"]);
    expect(config.providers[1]?.supportsTools).toBe(false);
    expect(config.allowCloudFallback).toBe(true);
    expect(config.memoryEnabled).toBe(false);
    expect(config.migratedFromLegacy).toBe(false);
  });

  it("prefers os.providers over a leftover legacy provider", () => {
    const config = parseOsBrainConfig({
      provider: { kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "m" },
      os: { providers: [{ ...local }] },
    });
    expect(config.providers.map((p) => p.id)).toEqual(["local"]);
    expect(config.migratedFromLegacy).toBe(false);
  });

  it("names the bad key", () => {
    const entry = { id: "a", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "m" };
    expect(() => parseOsBrainConfig({ os: { providers: {} } })).toThrow(/os\.providers/);
    expect(() => parseOsBrainConfig({ os: { providers: [{ ...entry, id: "A" }] } })).toThrow(
      /os\.providers\[0\]\.id/,
    );
    expect(() => parseOsBrainConfig({ os: { providers: [entry, entry] } })).toThrow(/unique/);
    expect(() =>
      parseOsBrainConfig({
        os: { providers: Array.from({ length: 9 }, (_, i) => ({ ...entry, id: `p${i}` })) },
      }),
    ).toThrow(/at most 8/);
    expect(() =>
      parseOsBrainConfig({ os: { providers: [{ ...entry, kind: "mistral" }] } }),
    ).toThrow(/os\.providers\[0\]/);
    expect(() => parseOsBrainConfig({ os: { allowCloudFallback: "yes" } })).toThrow(
      /allowCloudFallback/,
    );
    expect(() => parseOsBrainConfig({ os: { memory: { enabled: 1 } } })).toThrow(/memory/);
  });

  it("gives an empty brain for an empty document", () => {
    expect(parseOsBrainConfig(null)).toEqual(emptyBrain());
  });
});

describe("readOsBrainConfig / writeOsProviders", () => {
  it("reads an empty brain when the file is missing", async () => {
    const { io } = memoryIo();
    await expect(readOsBrainConfig(PATH, io)).resolves.toEqual(emptyBrain());
  });

  it("writes os.providers, drops the legacy key, keeps comments and other keys", async () => {
    const { io, files } = memoryIo(
      [
        "# my settings",
        "provider:",
        "  kind: ollama",
        "  baseUrl: http://127.0.0.1:11434",
        "  model: qwen3:8b",
        "os:",
        "  memory:",
        "    enabled: false # keep",
        "daemon:",
        "  enabled: true",
        "",
      ].join("\n"),
    );
    await writeOsProviders(
      PATH,
      {
        providers: [
          local,
          {
            id: "work",
            kind: "anthropic",
            baseUrl: "https://api.anthropic.com",
            model: "claude-sonnet-5-5",
            auth: "api-key",
            supportsTools: false,
          },
        ],
        allowCloudFallback: false,
      },
      io,
    );
    const text = files.get(PATH) ?? "";
    expect(text).toContain("# my settings");
    expect(text).toContain("# keep");
    const root = parse(text) as Record<string, unknown>;
    expect(root["provider"]).toBeUndefined();
    expect(root["daemon"]).toEqual({ enabled: true });
    expect(root["os"]).toEqual({
      memory: { enabled: false },
      providers: [
        { id: "local", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b" },
        {
          id: "work",
          kind: "anthropic",
          baseUrl: "https://api.anthropic.com",
          model: "claude-sonnet-5-5",
          tools: false,
        },
      ],
      allowCloudFallback: false,
    });
    const back = await readOsBrainConfig(PATH, io);
    expect(back.providers.map((p) => p.id)).toEqual(["local", "work"]);
    expect(back.memoryEnabled).toBe(false);
  });

  it("writes into an empty `os:` key and a new file", async () => {
    const { io, files } = memoryIo("os:\n");
    await writeOsProviders(PATH, { providers: [local], allowCloudFallback: true }, io);
    expect((parse(files.get(PATH) ?? "") as { os: unknown }).os).toEqual({
      providers: [
        { id: "local", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b" },
      ],
      allowCloudFallback: true,
    });
    const fresh = memoryIo();
    await writeOsProviders(PATH, { providers: [], allowCloudFallback: false }, fresh.io);
    expect(parse(fresh.files.get(PATH) ?? "")).toEqual({
      os: { providers: [], allowCloudFallback: false },
    });
  });
});

describe("os.language and the reserved id (M4 §1, §3)", () => {
  it("reads en and ar, and null for anything else", () => {
    expect(parseOsBrainConfig({ os: { language: "ar" } }).language).toBe("ar");
    expect(parseOsBrainConfig({ os: { language: "fr" } }).language).toBeNull();
    expect(parseOsBrainConfig({ os: { language: 7 } }).language).toBeNull();
    expect(parseOsBrainConfig({}).language).toBeNull();
  });

  it("refuses a configured provider called backup", () => {
    expect(() =>
      parseOsBrainConfig({
        os: {
          providers: [
            { id: "backup", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "x" },
          ],
        },
      }),
    ).toThrow(/reserved/);
  });

  it("writes os.language and keeps the rest of the file", async () => {
    const files = new Map([["/c.yaml", "# mine\nos:\n  allowCloudFallback: true\n"]]);
    const io = {
      readFile: async (path: string) => files.get(path) ?? "",
      writeFile: async (path: string, text: string) => {
        files.set(path, text);
      },
    };
    await writeOsLanguage("/c.yaml", "ar", io);
    expect(files.get("/c.yaml")).toContain("# mine");
    expect(files.get("/c.yaml")).toContain("allowCloudFallback: true");
    expect(files.get("/c.yaml")).toContain("language: ar");
  });
});
