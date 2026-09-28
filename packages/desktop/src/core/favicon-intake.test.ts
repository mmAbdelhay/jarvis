import { describe, expect, it } from "vitest";
import type { FaviconStore } from "@jarvis/platform";
import { MAX_FAVICON_INTAKE_BYTES, faviconIntake } from "./favicon-intake.js";

function recordingStore() {
  const calls: unknown[][] = [];
  const store: Pick<FaviconStore, "put" | "putMiss"> = {
    put: async (...args) => {
      calls.push(["put", ...args]);
      return { ok: true, value: undefined };
    },
    putMiss: async (...args) => {
      calls.push(["putMiss", ...args]);
      return { ok: true, value: undefined };
    },
  };
  return { store, calls };
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

describe("faviconIntake", () => {
  it("decodes the base64 an app sends into the bytes the store keeps", async () => {
    const { store, calls } = recordingStore();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]);
    await expect(
      faviconIntake(store).put("https://example.com/", b64(bytes), "image/png"),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(calls).toEqual([["put", "https://example.com/", bytes, "image/png"]]);
    expect(calls[0]?.[2]).toBeInstanceOf(Uint8Array);
  });

  it("takes exactly the cap and refuses one byte more, without touching the store", async () => {
    const { store, calls } = recordingStore();
    const intake = faviconIntake(store);
    const atCap = new Uint8Array(MAX_FAVICON_INTAKE_BYTES);
    await expect(intake.put("https://a/", b64(atCap), "image/png")).resolves.toMatchObject({
      ok: true,
    });
    const over = new Uint8Array(MAX_FAVICON_INTAKE_BYTES + 1);
    await expect(intake.put("https://b/", b64(over), "image/png")).resolves.toEqual({
      ok: false,
      detail: "favicon too large",
    });
    expect(calls.map((call) => call[1])).toEqual(["https://a/"]);
    expect(MAX_FAVICON_INTAKE_BYTES).toBe(256 * 1024);
  });

  it("refuses text that is not base64 rather than storing whatever Buffer makes of it", async () => {
    const { store, calls } = recordingStore();
    const intake = faviconIntake(store);
    for (const bad of ["not base64!", "abc", "ab=c", 42 as unknown as string]) {
      await expect(intake.put("https://a/", bad, "image/png")).resolves.toEqual({
        ok: false,
        detail: "favicon is not base64",
      });
    }
    expect(calls).toEqual([]);
  });

  it("passes a miss straight through", async () => {
    const { store, calls } = recordingStore();
    await faviconIntake(store).putMiss("https://nothing/");
    expect(calls).toEqual([["putMiss", "https://nothing/"]]);
  });
});
