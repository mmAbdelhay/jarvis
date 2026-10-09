// packages/desktop/src/daemon/os/agent-service.cu.test.ts
import {
  type AgentEvent,
  type AuditEntry,
  CU_MODEL_TEXT,
  type CuState,
  createFakeCuClient,
  IMAGE_WITHHELD,
  type ModelChatRequest,
  type ModelEvent,
  type ModelProvider,
  type ModelToolResult,
  ProviderError,
} from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { DONE, scripted, startAgent } from "./__fixtures__/os-agent-harness.js";

const CLOUD = "anthropic https://api.anthropic.com claude-sonnet-4-5";
const WORK =
  "    - { id: work, kind: anthropic, baseUrl: 'https://api.anthropic.com', model: claude-sonnet-4-5 }";
const yaml = (...lines: string[]) => ["os:", "  providers:", WORK, ...lines, ""].join("\n");
const ON = [
  "  computerUse:",
  "    enabled: { work: true }",
  "    cloudConsent: { work: '2026-10-10T09:00:00Z' }",
];
const START = { goal: "export beach.xcf as PNG", apps: ["org.gimp.GIMP"] };
const call = (id: string, name: string, input: unknown = {}): ModelEvent => ({
  type: "tool_call",
  id,
  name,
  input,
});
const text = (delta: string): ModelEvent[] => [{ type: "text", delta }, DONE];
const results = (r: ModelChatRequest | undefined) =>
  (r?.messages ?? []).flatMap((m): ModelToolResult[] => (m.role === "tool" ? m.results : []));

/** A provider whose replies may wait on a promise (to act mid-turn). */
function held(
  replies: (() => Promise<ModelEvent[]>)[],
): ModelProvider & { requests: ModelChatRequest[] } {
  const requests: ModelChatRequest[] = [];
  return {
    requests,
    async *chat(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      const next = replies.shift();
      yield* next === undefined ? text("ok") : await next();
    },
    probe: async () => ({ ok: true, supportsTools: true, models: [] }),
    listModels: async () => [],
    reachable: async () => ({ ok: true }),
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!check()) throw new Error("condition never became true");
}

async function cuAgent(options: {
  yaml: string;
  providers: Record<string, ModelProvider>;
  approve?: boolean;
}) {
  const fake = createFakeCuClient();
  const audit: AuditEntry[] = [];
  const h = await startAgent({
    yaml: options.yaml,
    providers: options.providers,
    overrides: {
      // An Ollama tag counts as vision only from the catalog or /api/show (Task 2).
      readVisionTags: async () => new Set(["llava:7b"]),
      computerUse: { client: fake.client, hash: async (png) => png },
      audit: {
        append: async (entry) => {
          audit.push(entry);
        },
        list: async () => [],
      },
    },
  });
  h.agent.onEvent((event) => {
    if (event.type !== "card") return;
    const approve = options.approve ?? true;
    queueMicrotask(() =>
      h.agent.confirm({
        cardId: event.card.cardId,
        approve,
        ticked: approve ? event.card.items.map((i) => i.itemId) : [],
        secrets: {},
      }),
    );
  });
  const cuStates = () =>
    h.pushed.filter((p) => p.channel === "cu:state").map((p) => p.payload as CuState);
  const turnEnd = (turnId: string) =>
    h.waitFor((e) => e.type === "turn-end" && e.turnId === turnId);
  const cards = () =>
    h.events().filter((e): e is Extract<AgentEvent, { type: "card" }> => e.type === "card");
  return { ...h, fake, audit, cuStates, turnEnd, cards };
}

describe("computer use in jarvisd (v1.1 contracts §2)", () => {
  it("offers screen tools only when enabled, vision-capable and (cloud) consented", async () => {
    const cases: [string, string, boolean][] = [
      ["on", yaml(...ON), true],
      ["no consent", yaml("  computerUse:", "    enabled: { work: true }"), false],
      [
        "not enabled",
        yaml("  computerUse:", "    cloudConsent: { work: '2026-10-10T09:00:00Z' }"),
        false,
      ],
      ["nothing", yaml(), false],
    ];
    for (const [name, config, offered] of cases) {
      const provider = scripted([text("hi")]);
      const h = await cuAgent({ yaml: config, providers: { [CLOUD]: provider } });
      await h.turnEnd(h.agent.prompt("hello").turnId);
      expect(
        provider.requests[0]?.tools.some((t) => t.name === "screen_look"),
        name,
      ).toBe(offered);
    }
  });

  it("runs a GIMP export: one session card, a consequential card, audit without screenshots", async () => {
    const provider = scripted([
      [call("a", "screen_look", START), DONE],
      [call("b", "screen_click", { x: 10, y: 10, target: "File" }), DONE],
      [call("c", "screen_click", { x: 20, y: 20, target: "Export" }), DONE],
      [call("d", "screen_done", { summary: "exported beach.png" }), DONE],
      text("Exported."),
      text("You're welcome."),
    ]);
    const h = await cuAgent({ yaml: yaml(...ON), providers: { [CLOUD]: provider } });
    await h.turnEnd(h.agent.prompt("export beach.xcf as PNG to Pictures").turnId);

    expect(h.fake.calls.map((c) => c.op)).toEqual([
      "begin",
      "capture",
      "describeAt",
      "click",
      "describeAt",
      "click",
      "end",
    ]);
    expect(h.cards().map((c) => c.card.items[0]?.tool)).toEqual(["cu.begin", "screen.click"]);
    expect(results(provider.requests[1]).at(-1)?.image?.mediaType).toBe("image/png");
    expect(h.cuStates().some((s) => s.active && s.step === 2)).toBe(true);
    expect(h.cuStates().at(-1)).toMatchObject({ active: false });
    expect(h.audit.map((e) => e.tool)).toEqual([
      "cu.begin",
      "screen.click",
      "screen.click",
      "cu.end",
    ]);
    expect(JSON.stringify(h.audit)).not.toContain("iVBORw0KGgo");

    // turn-end is pushed before the agent frees the turn: let it finish.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.turnEnd(h.agent.prompt("thanks").turnId);
    expect(JSON.stringify(provider.requests.at(-1)?.messages)).not.toContain("iVBORw0KGgo");
  });

  it("refuses computer use for a turn that came from a phone", async () => {
    const provider = scripted([[call("a", "screen_look", START), DONE], text("ok")]);
    const h = await cuAgent({ yaml: yaml(...ON), providers: { [CLOUD]: provider } });
    await h.turnEnd(
      h.agent.prompt("export it", { via: "phone:Pixel", allowPassword: false }).turnId,
    );
    expect(results(provider.requests[1])[0]?.content).toBe(CU_MODEL_TEXT.phone);
    expect(h.cards()).toHaveLength(0);
    expect(h.fake.calls).toEqual([]);
  });

  it("locking the screen ends the session; the next action is refused", async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = held([
      async () => [call("a", "screen_look", START), DONE],
      async () => {
        await hold;
        return [call("b", "screen_click", { x: 1, y: 1, target: "File" }), DONE];
      },
      async () => text("stopped"),
    ]);
    const h = await cuAgent({ yaml: yaml(...ON), providers: { [CLOUD]: provider } });
    const { turnId } = h.agent.prompt("export it");
    await until(() => h.cuStates().some((s) => s.active));
    await h.agent.setLocked(true);
    await until(() => h.cuStates().at(-1)?.active === false);
    expect(h.fake.calls.at(-1)?.op).toBe("end");
    release();
    await h.turnEnd(turnId);
    expect(results(provider.requests[2]).at(-1)?.content).toBe(CU_MODEL_TEXT.locked);
    expect(h.fake.calls.some((c) => c.op === "click")).toBe(false);
  });

  it("cu:stop ends the session and stops the turn", async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = held([
      async () => [call("a", "screen_look", START), DONE],
      async () => {
        await hold;
        return [call("b", "screen_click", { x: 1, y: 1, target: "File" }), DONE];
      },
    ]);
    const h = await cuAgent({ yaml: yaml(...ON), providers: { [CLOUD]: provider } });
    const { turnId } = h.agent.prompt("export it");
    await until(() => h.cuStates().some((s) => s.active));
    await expect(h.agent.cuStop()).resolves.toBeNull();
    release();
    const end = await h.turnEnd(turnId);
    expect(end).toMatchObject({ reason: "stopped" });
    expect(h.agent.cuState().active).toBe(false);
    expect(h.fake.calls.some((c) => c.op === "click")).toBe(false);
  });

  it("a failover to an unconsented cloud provider never receives the screenshot", async () => {
    const LOCAL = "ollama http://127.0.0.1:11434 llava:7b";
    const local = scripted([
      [call("a", "screen_look", START), DONE],
      new ProviderError("network", "connect ECONNREFUSED"),
    ]);
    const cloud = scripted([text("I lost the local model.")]);
    const config = [
      "os:",
      "  providers:",
      "    - { id: eyes, kind: ollama, baseUrl: 'http://127.0.0.1:11434', model: 'llava:7b' }",
      WORK,
      "  allowCloudFallback: true",
      "  computerUse:",
      "    enabled: { eyes: true }",
      "",
    ].join("\n");
    const h = await cuAgent({ yaml: config, providers: { [LOCAL]: local, [CLOUD]: cloud } });
    await h.turnEnd(h.agent.prompt("export it").turnId);
    expect(h.fake.calls.map((c) => c.op)).toContain("capture");
    const sent = JSON.stringify(cloud.requests[0]?.messages);
    expect(sent).not.toContain("iVBORw0KGgo");
    expect(sent).toContain(IMAGE_WITHHELD);
  });

  it("re-pushes cu:state on every new connection", async () => {
    const h = await cuAgent({ yaml: yaml(...ON), providers: { [CLOUD]: scripted([]) } });
    h.agent.resync();
    expect(h.cuStates().at(-1)).toEqual(h.agent.cuState());
  });
});
