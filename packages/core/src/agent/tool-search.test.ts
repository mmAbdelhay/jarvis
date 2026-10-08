import { describe, expect, it } from "vitest";
import type { TextEmbedder } from "./text-index.js";
import { CORE_TOOLS, TOOL_SEARCH_MIN_TOOLS, selectTools, toolSearchText } from "./tool-search.js";
import { toModelName } from "./tool-registry.js";
import type { ModelToolSpec } from "./types.js";

const spec = (name: string, description = name): ModelToolSpec => ({
  name,
  description,
  inputSchema: { type: "object" },
});
const many = (n: number) =>
  Array.from({ length: n }, (_, i) => spec(`tool_${i}`, `thing number ${i}`));
const core = new Set(CORE_TOOLS.map(toModelName));

describe("selectTools", () => {
  it("offers every tool at or below 40", async () => {
    const all = many(TOOL_SEARCH_MIN_TOOLS);
    await expect(
      selectTools(all, "x", { coreModelNames: core, embedder: null, log: () => {} }),
    ).resolves.toEqual(all);
  });

  it("always includes the core tools first", async () => {
    const all = [...many(45), spec("pkg_search", "Search apps"), spec("sys_health", "Health")];
    const chosen = await selectTools(all, "nothing matches", {
      coreModelNames: core,
      embedder: null,
      log: () => {},
    });
    expect(chosen.map((t) => t.name)).toEqual(["pkg_search", "sys_health"]);
  });

  it("ranks by cosine with a local embedder", async () => {
    const all = [...many(41), spec("weather_forecast", "Weather forecast")];
    const embedder: TextEmbedder = {
      model: "fake",
      embed: async (texts, purpose) =>
        texts.map((text) =>
          purpose === "query" || text.includes("Weather")
            ? new Float32Array([1, 0])
            : new Float32Array([0, 1]),
        ),
    };
    const chosen = await selectTools(all, "will it rain?", {
      coreModelNames: core,
      embedder,
      log: () => {},
    });
    expect(chosen[0]?.name).toBe("weather_forecast");
    expect(chosen).toHaveLength(24);
  });

  it("falls back to keywords when the embedder fails, and says so", async () => {
    const logs: string[] = [];
    const all = [...many(41), spec("weather_forecast", "Weather forecast")];
    const embedder: TextEmbedder = {
      model: "fake",
      embed: async () => {
        throw new Error("no ollama");
      },
    };
    const chosen = await selectTools(all, "weather tomorrow", {
      coreModelNames: core,
      embedder,
      log: (l) => logs.push(l),
    });
    expect(chosen[0]?.name).toBe("weather_forecast");
    expect(logs[0]).toContain("no ollama");
  });

  it("searches names split on dots and underscores", () => {
    expect(toolSearchText(spec("music_next_track", "Skip"))).toBe("music next track Skip");
  });
});
