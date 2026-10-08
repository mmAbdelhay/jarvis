import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Walks value imports (not `import type`) from the OS entry through local
// files and collects every bare specifier the bundle would pull in. The
// esbuild bundle (scripts/build-daemon.mjs) is built from exactly this graph.
const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM_STORE = resolve(HERE, "../../../../platform/src/store/index.ts");
const PLATFORM_MODEL = resolve(HERE, "../../../../platform/src/model/index.ts");

function specifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found: string[] = [];
  for (const match of code.matchAll(
    /^\s*(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s+"([^"]+)"/gm,
  )) {
    found.push(match[1] ?? "");
  }
  for (const match of code.matchAll(/^\s*import\s+"([^"]+)"/gm)) found.push(match[1] ?? "");
  return found;
}

function walk(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
        if (existsSync(target)) queue.push(target);
      } else {
        bare.add(spec);
      }
    }
  }
  return { files, bare };
}

describe("the Jarvis OS daemon bundle graph", () => {
  it("imports only core, wire, platform/model, yaml and node built-ins", () => {
    const { files, bare } = walk(resolve(HERE, "os-daemon-main.ts"));
    expect(files.size).toBeGreaterThan(5);
    const outside = [...bare].filter(
      (spec) =>
        !spec.startsWith("node:") &&
        ![
          "@jarvis/core",
          "@jarvis/wire",
          "@jarvis/platform/model",
          "@jarvis/platform/store",
          "yaml",
        ].includes(spec),
    );
    expect(outside).toEqual([]);
    const names = [...files].map((file) => file.split(/[\\/]/).slice(-2).join("/"));
    for (const forbidden of [
      "src/config.ts",
      "core/compose.ts",
      "src/dispatch.ts",
      "daemon/binding.ts",
      "src/main.ts",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("keeps @jarvis/platform/store to node built-ins and @jarvis/core", () => {
    const { bare } = walk(PLATFORM_STORE);
    expect(
      [...bare].filter((spec) => !spec.startsWith("node:") && spec !== "@jarvis/core"),
    ).toEqual([]);
  });

  it("keeps @jarvis/platform/model free of the Agent SDK, node-pty and sqlite", () => {
    const { files, bare } = walk(PLATFORM_MODEL);
    expect(
      [...bare].filter((spec) => !spec.startsWith("node:") && spec !== "@jarvis/core"),
    ).toEqual([]);
    expect([...bare]).not.toContain("node:sqlite");
    expect(
      [...files].some(
        (file) => file.endsWith("brain.ts") || file.endsWith("anthropic-subscription.ts"),
      ),
    ).toBe(false);
  });

  it("cannot reach the installer backend: no file in jarvisd's graph names os.jarvis.Installer1", () => {
    const { files } = walk(resolve(HERE, "os-daemon-main.ts"));
    const platformModel = walk(PLATFORM_MODEL).files;
    for (const file of [...files, ...platformModel]) {
      expect(readFileSync(file, "utf8")).not.toMatch(/Installer1/);
    }
  });
});
