import { describe, expect, it } from "vitest";
import { createFailoverProvider, type FailoverEntry, type FailoverSwitch } from "./failover.js";
import { FAILOVER_TEXT } from "./messages.js";
import { type ModelEvent, type ModelProvider, ProviderError } from "./types.js";

const DONE: ModelEvent = { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };

function answering(id: string, seen: string[]): ModelProvider {
  return {
    async *chat() {
      seen.push(id);
      yield { type: "text", delta: `from ${id}` };
      yield DONE;
    },
    probe: async () => ({ ok: true, supportsTools: true, models: [id] }),
    listModels: async () => [id],
    reachable: async () => ({ ok: true }),
  };
}

function failing(id: string, error: Error, seen: string[]): ModelProvider {
  return {
    // biome-ignore lint/correctness/useYield: it fails before it yields anything.
    async *chat() {
      seen.push(id);
      throw error;
    },
    probe: async () => ({ ok: false, supportsTools: false, models: [], error: error.message }),
    listModels: async () => {
      throw error;
    },
    reachable: async () => ({ ok: false, error: error.message }),
  };
}

function failsAfterText(id: string, seen: string[]): ModelProvider {
  return {
    async *chat() {
      seen.push(id);
      yield { type: "text", delta: "half" };
      throw new ProviderError("network", "reset");
    },
    probe: async () => ({ ok: true, supportsTools: true, models: [] }),
    listModels: async () => [],
    reachable: async () => ({ ok: true }),
  };
}

const timers = { setTimeout: () => 0, clearTimeout: () => {} };
const network = () => new ProviderError("network", "ECONNREFUSED");
const auth = () => new ProviderError("auth", "401 invalid x-api-key");

function setup(
  entries: FailoverEntry[],
  backup: ModelProvider | undefined,
  language: "en" | "ar" = "en",
) {
  const switches: FailoverSwitch[] = [];
  const provider = createFailoverProvider({
    entries,
    allowCloudFallback: false,
    ...(backup === undefined
      ? {}
      : { backup: { id: "backup", locality: "local" as const, provider: backup } }),
    timers,
    onSwitch: (change) => switches.push(change),
    language: () => language,
  });
  return { provider, switches };
}

async function text(
  provider: ModelProvider,
  signal = new AbortController().signal,
): Promise<string> {
  let out = "";
  for await (const event of provider.chat({ system: "s", messages: [], tools: [], signal })) {
    if (event.type === "text") out += event.delta;
  }
  return out;
}

describe("the backup provider (M4 §1)", () => {
  it("answers when every configured provider is down, and says why", async () => {
    const seen: string[] = [];
    const { provider, switches } = setup(
      [
        { id: "local", locality: "local", provider: failing("local", network(), seen) },
        { id: "lan", locality: "local", provider: failing("lan", network(), seen) },
      ],
      answering("backup", seen),
    );
    expect(await text(provider)).toBe("from backup");
    expect(seen).toEqual(["local", "lan", "backup"]);
    expect(provider.status()).toEqual({
      activeId: "backup",
      fallbackReason: FAILOVER_TEXT.en.reason("lan", FAILOVER_TEXT.en.unreachable("ECONNREFUSED")),
    });
    expect(switches.map((s) => s.toId)).toEqual(["lan", "backup"]);
  });

  it("an auth error goes straight to the backup, skipping the other configured providers", async () => {
    const seen: string[] = [];
    const { provider } = setup(
      [
        { id: "work", locality: "cloud", provider: failing("work", auth(), seen) },
        { id: "home", locality: "cloud", provider: answering("home", seen) },
      ],
      answering("backup", seen),
    );
    expect(await text(provider)).toBe("from backup");
    expect(seen).toEqual(["work", "backup"]);
    expect(provider.status().fallbackReason).toBe(
      FAILOVER_TEXT.en.reason("work", FAILOVER_TEXT.en.failed("401 invalid x-api-key")),
    );
  });

  it("is the whole chain when nothing is configured", async () => {
    const seen: string[] = [];
    const { provider } = setup([], answering("backup", seen), "ar");
    expect(provider.status()).toEqual({
      activeId: "backup",
      fallbackReason: FAILOVER_TEXT.ar.noneConfigured,
    });
    expect(await text(provider)).toBe("from backup");
  });

  it("is reached even past the privacy rule (it is local)", async () => {
    const seen: string[] = [];
    const { provider } = setup(
      [
        { id: "local", locality: "local", provider: failing("local", network(), seen) },
        { id: "cloud", locality: "cloud", provider: answering("cloud", seen) },
      ],
      answering("backup", seen),
    );
    expect(await text(provider)).toBe("from backup");
    expect(seen).toEqual(["local", "backup"]);
  });

  it("never takes over after the first event, or after a user stop", async () => {
    const seen: string[] = [];
    const { provider } = setup(
      [{ id: "local", locality: "local", provider: failsAfterText("local", seen) }],
      answering("backup", seen),
    );
    await expect(text(provider)).rejects.toThrow("reset");
    const controller = new AbortController();
    controller.abort();
    const stopped = setup(
      [{ id: "local", locality: "local", provider: failing("local", network(), seen) }],
      answering("backup", seen),
    );
    await expect(text(stopped.provider, controller.signal)).rejects.toThrow();
    expect(seen).toEqual(["local", "local"]);
  });

  it("starts each turn at the first configured provider again", async () => {
    const seen: string[] = [];
    let up = false;
    const flaky: ModelProvider = {
      ...answering("local", seen),
      async *chat(request) {
        if (!up) {
          seen.push("local");
          throw network();
        }
        yield* answering("local", seen).chat(request);
      },
    };
    const { provider } = setup(
      [{ id: "local", locality: "local", provider: flaky }],
      answering("backup", seen),
    );
    await text(provider);
    up = true;
    provider.beginTurn();
    expect(await text(provider)).toBe("from local");
    expect(provider.status()).toEqual({ activeId: "local", fallbackReason: null });
  });

  it("reachable() tries the backup after an auth failure", async () => {
    const { provider } = setup(
      [{ id: "work", locality: "cloud", provider: failing("work", auth(), []) }],
      answering("backup", []),
    );
    expect(await provider.reachable()).toEqual({ ok: true });
    expect(provider.status().activeId).toBe("backup");
  });

  it("reachable() is false when the backup is down too (the doctor's case)", async () => {
    const { provider } = setup(
      [{ id: "local", locality: "local", provider: failing("local", network(), []) }],
      failing("backup", network(), []),
    );
    expect((await provider.reachable()).ok).toBe(false);
    expect(provider.status()).toEqual({ activeId: "local", fallbackReason: null });
  });

  it("writes reasons in the UI language", async () => {
    const { provider } = setup(
      [{ id: "local", locality: "local", provider: failing("local", network(), []) }],
      answering("backup", []),
      "ar",
    );
    await text(provider);
    expect(provider.status().fallbackReason).toBe(
      FAILOVER_TEXT.ar.reason("local", FAILOVER_TEXT.ar.unreachable("ECONNREFUSED")),
    );
  });
});
