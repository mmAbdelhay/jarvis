import { describe, expect, it } from "vitest";
import { loadProjectChoices } from "./new-session";

describe("loadProjectChoices", () => {
  it("parses the project list field by field", async () => {
    const client = {
      call: async () => ({
        ok: true as const,
        value: ["jarvis", { name: "api", path: "/code/api", extra: 1 }, { nope: true }, 3],
      }),
    };
    expect(await loadProjectChoices(client)).toEqual({
      ok: true,
      projects: [{ name: "jarvis" }, { name: "api", path: "/code/api" }],
    });
  });

  it("reports a failed call", async () => {
    const client = {
      call: async () => ({ ok: false as const, error: { kind: "offline" as const } }),
    };
    expect(await loadProjectChoices(client as never)).toEqual({ ok: false });
  });
});
