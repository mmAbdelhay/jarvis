import { describe, expect, it } from "vitest";
import { PROMPTS, TOOLS } from "./__fixtures__/tool-search-60.js";
import { CORE_TOOLS, MAX_TOOLS_PER_TURN, selectTools } from "./tool-search.js";
import { toModelName } from "./tool-registry.js";
import type { ModelToolSpec } from "./types.js";

const specs: ModelToolSpec[] = TOOLS.map((tool) => ({
  name: toModelName(tool.name),
  description: tool.description,
  inputSchema: { type: "object" },
}));
const core = new Set(CORE_TOOLS.map(toModelName));

describe("tool search eval (criterion 8, keyword fallback)", () => {
  it("offers at most 24 tools and includes the right one for >= 90% of 30 held-out prompts", async () => {
    expect(specs).toHaveLength(60);
    expect(PROMPTS).toHaveLength(30);
    let hits = 0;
    for (const prompt of PROMPTS) {
      const chosen = await selectTools(specs, prompt.text, {
        coreModelNames: core,
        embedder: null,
        log: () => {},
      });
      expect(chosen.length).toBeLessThanOrEqual(MAX_TOOLS_PER_TURN);
      if (chosen.some((tool) => tool.name === toModelName(prompt.expect))) hits++;
    }
    expect(hits / PROMPTS.length).toBeGreaterThanOrEqual(0.9);
  });
});
