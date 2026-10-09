import { type Card, createRecipeEngine } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { DONE, fakeSession, scripted, startAgent, tool } from "./__fixtures__/os-agent-harness.js";

const LOCAL = "ollama http://127.0.0.1:11434 qwen3:8b";
const YAML = `os:
  providers:
    - { id: local, kind: ollama, baseUrl: http://127.0.0.1:11434, model: qwen3:8b }
`;
const NODE = {
  id: "node-dev",
  title: { en: "Node.js development", ar: "تطوير Node.js" },
  description: { en: "Node.js and npm", ar: "Node.js و npm" },
  steps: [
    {
      tool: "pkg.install",
      input: { items: [{ source: "apt", id: "nodejs" }] },
      title: { en: "Install Node.js", ar: "تثبيت Node.js" },
    },
    {
      tool: "pkg.install",
      input: { items: [{ source: "apt", id: "npm" }] },
      title: { en: "Install npm", ar: "تثبيت npm" },
    },
  ],
  requires: { os: "rafiq" },
};

describe("recipes in jarvisd (M4 §4)", () => {
  it("shows the recipe card in the prompt's language and runs only the ticked steps", async () => {
    const pkg = fakeSession("jarvis-pkg", [
      tool("pkg.install", "confirm", { batch: "items" }),
      tool("recipes.run", "confirm"),
    ]);
    const provider = scripted([
      [{ type: "tool_call", id: "c1", name: "recipes_run", input: { id: "node-dev" } }, DONE],
      [{ type: "text", delta: "تمّ التنفيذ" }, DONE],
    ]);
    const { agent, waitFor } = await startAgent({
      yaml: YAML,
      sessions: [pkg],
      providers: { [LOCAL]: provider },
      overrides: {
        recipes: createRecipeEngine({
          load: async () => [NODE],
          machine: async () => ({ osId: "rafiq", memTotalBytes: 8 * 1024 ** 3 }),
          hostServers: new Set(["jarvis-pkg", "jarvis-diag"]),
          log: () => {},
        }),
      },
    });
    const { turnId } = agent.prompt("جهّز الجهاز لتطوير Node.js");
    const event = await waitFor((e) => e.type === "card");
    const card = (event as { card: Card }).card;
    expect(card.items.map((i) => i.title)).toEqual(["تثبيت Node.js", "تثبيت npm"]);
    agent.confirm({
      cardId: card.cardId,
      approve: true,
      ticked: [card.items[1]?.itemId ?? ""],
      secrets: {},
    });
    await waitFor((e) => e.type === "turn-end" && e.turnId === turnId);
    expect(pkg.calls.filter((c) => c.tool !== "jarvis.describe")).toEqual([
      { tool: "pkg.install", args: { items: [{ source: "apt", id: "npm" }] } },
    ]);
  });
});
