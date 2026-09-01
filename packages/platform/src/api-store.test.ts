import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiStore, DEFAULT_API_SETTINGS, truncateBody } from "./api-store.js";

const made: string[] = [];

async function store() {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-api-store-"));
  made.push(dir);
  return createApiStore(join(dir, "api.json"));
}

const entry = (over: Record<string, unknown> = {}) => ({
  at: 1000,
  name: "List orders",
  method: "GET",
  url: "http://h/orders",
  status: 200,
  timeMs: 12,
  bytes: 40,
  bodyPreview: "{}",
  ...over,
});

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("createApiStore", () => {
  it("starts empty, with the safe defaults", async () => {
    expect(await (await store()).read("acme")).toEqual({
      history: [],
      cookies: [],
      settings: DEFAULT_API_SETTINGS,
    });
  });

  // Never relaxed by default: switching verification off has to be a choice.
  it("verifies certificates by default", () => {
    expect(DEFAULT_API_SETTINGS.verifyCertificate).toBe(true);
  });

  it("keeps history newest first", async () => {
    const api = await store();

    await api.addHistory("acme", entry({ at: 1 }));
    const history = await api.addHistory("acme", entry({ at: 2 }));

    expect(history.map((row) => row.at)).toEqual([2, 1]);
  });

  it("keeps each project's history apart", async () => {
    const api = await store();

    await api.addHistory("acme", entry({ name: "A" }));
    await api.addHistory("storefront", entry({ name: "B" }));

    expect((await api.read("acme")).history.map((row) => row.name)).toEqual(["A"]);
    expect((await api.read("storefront")).history.map((row) => row.name)).toEqual(["B"]);
  });

  // History is for finding a call again, not for becoming a log.
  // 205 sequential read-modify-writes of a real file, which on a loaded
  // machine has exceeded the 5s default and failed as a flake. The count is
  // the point of the test — the cap cannot be shown with fewer — so the
  // timeout is raised rather than the coverage lowered.
  it(
    "caps the history",
    async () => {
      const api = await store();

      for (let i = 0; i < 205; i += 1) await api.addHistory("acme", entry({ at: i }));

      const { history } = await api.read("acme");
      expect(history).toHaveLength(200);
      expect(history[0]?.at).toBe(204);
    },
    20_000,
  );

  it("clears the history without touching the settings", async () => {
    const api = await store();
    await api.saveSettings("acme", { proxyUrl: "http://p", verifyCertificate: false, timeoutMs: 5 });
    await api.addHistory("acme", entry());

    await api.clearHistory("acme");

    const state = await api.read("acme");
    expect(state.history).toEqual([]);
    expect(state.settings).toEqual({ proxyUrl: "http://p", verifyCertificate: false, timeoutMs: 5 });
  });

  it("round-trips cookies", async () => {
    const api = await store();

    await api.saveCookies("acme", [
      { name: "sid", value: "abc", domain: "h", path: "/", secure: false, httpOnly: true },
    ]);

    expect((await api.read("acme")).cookies[0]).toMatchObject({ name: "sid", value: "abc" });
  });

  it("fills in a missing setting from the defaults", async () => {
    const api = await store();

    const saved = await api.saveSettings("acme", { proxyUrl: "http://p" } as never);

    expect(saved).toEqual({ ...DEFAULT_API_SETTINGS, proxyUrl: "http://p" });
  });

  // Two sends finishing at once must not clobber each other.
  it("serialises concurrent writes", async () => {
    const api = await store();

    await Promise.all(
      Array.from({ length: 10 }, (_value, i) => api.addHistory("acme", entry({ at: i }))),
    );

    expect((await api.read("acme")).history).toHaveLength(10);
  });

  it("survives a file that is no longer JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-api-store-"));
    made.push(dir);
    const path = join(dir, "api.json");
    await (await import("node:fs/promises")).writeFile(path, "not json", "utf8");

    expect(await createApiStore(path).read("acme")).toEqual({
      history: [],
      cookies: [],
      settings: DEFAULT_API_SETTINGS,
    });
  });
});

describe("truncateBody", () => {
  it("leaves a short body alone", () => {
    expect(truncateBody("hello")).toBe("hello");
  });

  it("truncates a long one and says so", () => {
    const preview = truncateBody("x".repeat(3000));

    expect(preview).toHaveLength(2001);
    expect(preview.endsWith("…")).toBe(true);
  });
});
