import { describe, expect, it } from "vitest";
import { moveUp, parseProviderList, removeAt, savePayload, setup } from "./setup.js";
import { type TestDaemon, testDaemons } from "./testing/daemon.js";
import { FakeTerminal } from "./testing/fake-terminal.js";

const daemons = testDaemons();
const KINDS = ["anthropic", "openai-compatible", "ollama", "gemini"];
const local = {
  id: "local",
  kind: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  model: "qwen3:8b",
  hasKey: false,
};
const work = {
  id: "work",
  kind: "anthropic",
  baseUrl: "https://api.anthropic.com",
  model: "claude-sonnet-5-5",
  hasKey: true,
};
const listOf = (providers: unknown[], allowCloudFallback = false) => ({
  providers,
  activeId: null,
  allowCloudFallback,
  kinds: KINDS,
});
const ok = { ok: true, supportsTools: true, models: [] };

describe("setup state", () => {
  it("parses the list and sends keys only for new providers", () => {
    const state = parseProviderList(listOf([local, work], true));
    expect(state.providers.map((p) => p.id)).toEqual(["local", "work"]);
    expect(state.allowCloudFallback).toBe(true);
    state.providers.push({ ...work, id: "spare", hasKey: true, apiKey: "sk-new" });
    expect(savePayload(state)).toEqual({
      providers: [
        { id: "local", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b" },
        {
          id: "work",
          kind: "anthropic",
          baseUrl: "https://api.anthropic.com",
          model: "claude-sonnet-5-5",
        },
        {
          id: "spare",
          kind: "anthropic",
          baseUrl: "https://api.anthropic.com",
          model: "claude-sonnet-5-5",
          apiKey: "sk-new",
        },
      ],
      allowCloudFallback: true,
    });
  });

  it("moves and removes, but keeps at least one provider", () => {
    const state = parseProviderList(listOf([local, work]));
    expect(moveUp(state, 1).state.providers.map((p) => p.id)).toEqual(["work", "local"]);
    expect(moveUp(state, 0).message).toBe("That one is already first.");
    expect(moveUp(state, 5).message).toBe("There is no provider with that number.");
    expect(removeAt(state, 0).state.providers.map((p) => p.id)).toEqual(["work"]);
    const single = parseProviderList(listOf([local]));
    expect(removeAt(single, 0).message).toBe("Jarvis needs at least one provider.");
  });
});

describe("jarvis setup", () => {
  it("adds a cloud provider: hidden key, model list, check, save", async () => {
    const d: TestDaemon = await daemons.start((channel, args) => {
      if (channel === "provider:list") return listOf([local]);
      if (channel === "provider:probe") {
        const draft = args[0] as { model: string };
        return draft.model === ""
          ? {
              ok: false,
              supportsTools: false,
              models: ["claude-a", "claude-b"],
              error: "pick a model",
            }
          : { ok: true, supportsTools: true, models: ["claude-a", "claude-b"] };
      }
      if (channel === "provider:save") return { ok: true, results: { local: ok, work: ok } };
      return null;
    });
    const term = new FakeTerminal({
      lines: ["a", "work", "1", "", "", "s", "q"],
      secrets: ["sk-test"],
    });
    expect(await setup(await daemons.connect(d), term)).toBe(0);
    const probes = d.requests.filter((r) => r.channel === "provider:probe");
    expect(probes[0]?.args).toEqual([
      { kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "", apiKey: "sk-test" },
    ]);
    expect(probes[1]?.args).toEqual([
      {
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "claude-a",
        apiKey: "sk-test",
      },
    ]);
    expect(d.requests.find((r) => r.channel === "provider:save")?.args).toEqual([
      {
        providers: [
          { id: "local", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b" },
          {
            id: "work",
            kind: "anthropic",
            baseUrl: "https://api.anthropic.com",
            model: "claude-a",
            apiKey: "sk-test",
          },
        ],
        allowCloudFallback: false,
      },
    ]);
    expect(term.output).toContain("Connected. Tool calling works.");
    expect(term.output).toContain("Saved. Jarvis tries these in order.");
    expect(term.output).not.toContain("sk-test");
  });

  it("reorders and turns cloud fallback on", async () => {
    const d: TestDaemon = await daemons.start((channel) => {
      if (channel === "provider:list") return listOf([local, work]);
      if (channel === "provider:save") return { ok: true, results: { local: ok, work: ok } };
      return null;
    });
    const term = new FakeTerminal({ lines: ["u 2", "f", "s", "q"] });
    expect(await setup(await daemons.connect(d), term)).toBe(0);
    expect(d.requests.find((r) => r.channel === "provider:save")?.args).toEqual([
      {
        providers: [
          {
            id: "work",
            kind: "anthropic",
            baseUrl: "https://api.anthropic.com",
            model: "claude-sonnet-5-5",
          },
          { id: "local", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b" },
        ],
        allowCloudFallback: true,
      },
    ]);
    expect(term.output).toContain("Cloud fallback from local or network providers: on");
  });

  it("a failing provider saves nothing and quitting asks first", async () => {
    const d: TestDaemon = await daemons.start((channel) => {
      if (channel === "provider:list") return listOf([local, work]);
      if (channel === "provider:save") {
        return {
          ok: false,
          results: {
            local: ok,
            work: { ok: false, supportsTools: false, models: [], error: "401 invalid x-api-key" },
          },
        };
      }
      return null;
    });
    const term = new FakeTerminal({ lines: ["f", "s", "q", "y"] });
    expect(await setup(await daemons.connect(d), term)).toBe(0);
    expect(term.output).toContain("work: 401 invalid x-api-key");
    expect(term.output).toContain("Nothing was saved.");
    expect(term.prompts).toContain("Quit without saving? [y/N] ");
  });

  it("validates new ids and refuses duplicates", async () => {
    const d: TestDaemon = await daemons.start((channel) =>
      channel === "provider:list" ? listOf([local]) : null,
    );
    const term = new FakeTerminal({ lines: ["a", "Bad Id", "local", null] });
    expect(await setup(await daemons.connect(d), term)).toBe(0);
    expect(term.output).toContain("Use lowercase letters, digits and dashes, up to 32 characters.");
    expect(term.output).toContain("local is already in the list.");
    expect(d.requests.some((r) => r.channel === "provider:probe")).toBe(false);
  });

  it("keeps the last provider and needs a terminal", async () => {
    const d: TestDaemon = await daemons.start((channel) =>
      channel === "provider:list" ? listOf([local]) : null,
    );
    const term = new FakeTerminal({ lines: ["r 1", "q"] });
    expect(await setup(await daemons.connect(d), term)).toBe(0);
    expect(term.output).toContain("Jarvis needs at least one provider.");
    const piped = new FakeTerminal({ interactive: false });
    expect(await setup(await daemons.connect(d), piped)).toBe(2);
    expect(piped.output).toContain("needs an interactive terminal");
  });
});
