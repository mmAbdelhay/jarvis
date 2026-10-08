import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const WIRE = fileURLToPath(new URL("../../wire/os-control.json", import.meta.url));

describe("the CLI's control channels", () => {
  it("are all listed in packages/wire/os-control.json", () => {
    const wire = JSON.parse(readFileSync(WIRE, "utf8")) as { requests: string[]; pushes: string[] };
    const used = new Set<string>();
    const pushes = new Set<string>();
    for (const file of readdirSync(SRC)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const text = readFileSync(`${SRC}${file}`, "utf8");
      for (const match of text.matchAll(/invoke\("([^"]+)"/g)) used.add(match[1] ?? "");
      for (const match of text.matchAll(/channel !== "([^"]+)"/g)) pushes.add(match[1] ?? "");
    }
    expect([...used].sort()).toEqual([
      "agent:confirm",
      "agent:prompt",
      "agent:stop",
      "memory:clear",
      "memory:list",
      "provider:list",
      "provider:probe",
      "provider:save",
    ]);
    for (const channel of used) expect(wire.requests).toContain(channel);
    for (const channel of pushes) if (channel.includes(":")) expect(wire.pushes).toContain(channel);
  });
});
