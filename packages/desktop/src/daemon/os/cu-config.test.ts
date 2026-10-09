import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseComputerUse, pruneComputerUse, writeComputerUse } from "./cu-config.js";
import { parseOsBrainConfig } from "./provider-list-config.js";

describe("os.computerUse (v1.1 contracts §2)", () => {
  it("parses enabled and RFC3339 consents, dropping anything malformed", () => {
    expect(
      parseComputerUse({
        enabled: { work: true, home: false, Bad: true, backup: true, x: "yes" },
        cloudConsent: {
          work: "2026-10-10T09:00:00Z",
          home: "yesterday",
          other: "2026-10-10T09:00:00.123+02:00",
        },
      }),
    ).toEqual({
      enabled: { work: true, home: false },
      cloudConsent: { work: "2026-10-10T09:00:00Z", other: "2026-10-10T09:00:00.123+02:00" },
    });
    expect(parseComputerUse("on")).toEqual({ enabled: {}, cloudConsent: {} });
    expect(parseComputerUse(undefined)).toEqual({ enabled: {}, cloudConsent: {} });
  });

  it("is part of the brain config, and a broken section never breaks the providers", () => {
    const brain = parseOsBrainConfig(
      parse(
        "os:\n  providers:\n    - { id: work, kind: anthropic, baseUrl: 'https://api.anthropic.com', model: m }\n  computerUse: 7\n",
      ),
    );
    expect(brain.providers).toHaveLength(1);
    expect(brain.computerUse).toEqual({ enabled: {}, cloudConsent: {} });
  });

  it("prunes by provider id", () => {
    const s = {
      enabled: { a: true, b: true },
      cloudConsent: { a: "2026-10-10T09:00:00Z", b: "2026-10-10T09:00:00Z" },
    };
    expect(pruneComputerUse(s, (id) => id === "a")).toEqual({
      enabled: { a: true },
      cloudConsent: { a: "2026-10-10T09:00:00Z" },
    });
  });

  it("writes the section and keeps the rest of jarvis.yaml", async () => {
    const files = new Map([
      ["/c.yaml", "# mine\nos:\n  language: ar\nremote: { enabled: false }\n"],
    ]);
    const io = {
      readFile: async (p: string) => files.get(p) ?? "",
      writeFile: async (p: string, t: string) => {
        files.set(p, t);
      },
    };
    await writeComputerUse(
      "/c.yaml",
      { enabled: { work: true }, cloudConsent: { work: "2026-10-10T09:00:00.000Z" } },
      io,
    );
    const text = files.get("/c.yaml") ?? "";
    expect(text).toContain("# mine");
    const root = parse(text) as Record<string, Record<string, unknown>>;
    expect(root["os"]?.["language"]).toBe("ar");
    expect(root["remote"]).toEqual({ enabled: false });
    expect(parseComputerUse(root["os"]?.["computerUse"])).toEqual({
      enabled: { work: true },
      cloudConsent: { work: "2026-10-10T09:00:00.000Z" },
    });
  });
});
