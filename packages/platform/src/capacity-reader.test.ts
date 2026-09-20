import { describe, expect, it } from "vitest";
import { createCapacityReader } from "./capacity-reader.js";

const OK = (used: number) => ({
  ok: true as const,
  primary: { usedPercent: used, resetsAt: "2026-09-20T18:00:00.000Z" },
  secondary: undefined,
});

function build() {
  const seen: string[] = [];
  const read = createCapacityReader({
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    readSnapshot: async (configDir) => {
      seen.push(`snapshot:${configDir}`);
      return OK(1);
    },
    readCodex: async () => {
      seen.push("codex");
      return OK(2);
    },
    readCopilot: async () => {
      seen.push("copilot");
      return OK(3);
    },
  });
  return { read, seen };
}

describe("createCapacityReader", () => {
  it("routes anthropic to the snapshot in the account's config dir, openai to Codex's logs, github to Copilot's quota", async () => {
    const { read, seen } = build();
    expect(await read({ id: "a", vendor: "anthropic", configDir: "/c/a" })).toEqual(OK(1));
    expect(await read({ id: "b", vendor: "openai", configDir: undefined })).toEqual(OK(2));
    expect(await read({ id: "c", vendor: "github", configDir: undefined })).toEqual(OK(3));
    expect(seen).toEqual(["snapshot:/c/a", "codex", "copilot"]);
  });

  it("is unavailable for a Claude account without a config dir, without touching any source", async () => {
    const { read, seen } = build();
    expect(await read({ id: "a", vendor: "anthropic", configDir: undefined })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(seen).toEqual([]);
  });

  it("builds real readers by default: with a runner that reports gh signed out, a github target is unavailable rather than a throw", async () => {
    const read = createCapacityReader({ run: async () => ({ code: 1, stdout: "", stderr: "" }) });
    await expect(read({ id: "c", vendor: "github", configDir: undefined })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});
