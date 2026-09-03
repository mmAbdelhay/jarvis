import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFaviconStore, MISS_RETRY_DAYS } from "./favicons.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jarvis-favicons-"));
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("createFaviconStore", () => {
  it("returns undefined for an origin it has never seen", async () => {
    const store = createFaviconStore(await tempDir());

    const result = await store.get("https://a.test/page");

    expect(result).toEqual({ ok: true, value: undefined });
  });

  it("round-trips bytes as a data uri", async () => {
    const store = createFaviconStore(await tempDir());
    await store.put("https://a.test/page", new Uint8Array([1, 2, 3]), "image/png");

    const result = await store.get("https://a.test/page");

    expect(result.ok && result.value?.dataUri).toBe("data:image/png;base64,AQID");
  });

  it("shares one icon across every url of an origin", async () => {
    const store = createFaviconStore(await tempDir());
    await store.put("https://a.test/one", new Uint8Array([1]), "image/png");

    const result = await store.get("https://a.test/two?q=1#frag");

    expect(result.ok && result.value?.dataUri).toBe("data:image/png;base64,AQ==");
  });

  it("wants a fetch when nothing is cached", async () => {
    const store = createFaviconStore(await tempDir());

    expect(await store.shouldFetch("https://a.test/")).toEqual({ ok: true, value: true });
  });

  it("does not want a fetch straight after a recorded miss", async () => {
    const store = createFaviconStore(await tempDir());
    await store.putMiss("https://a.test/");

    expect(await store.shouldFetch("https://a.test/")).toEqual({ ok: true, value: false });
  });

  it("wants a fetch again once the miss is older than the retry window", async () => {
    let clock = 1_000_000;
    const store = createFaviconStore(await tempDir(), () => clock);
    await store.putMiss("https://a.test/");

    clock += (MISS_RETRY_DAYS + 1) * DAY_MS;

    expect(await store.shouldFetch("https://a.test/")).toEqual({ ok: true, value: true });
  });

  it("reports a recorded miss as no icon", async () => {
    const store = createFaviconStore(await tempDir());
    await store.putMiss("https://a.test/");

    expect(await store.get("https://a.test/")).toEqual({ ok: true, value: undefined });
  });

  // The exact transition the capture path makes real: a site with nothing
  // last week (recorded as a miss) getting an icon today, once it is
  // actually visited. A stale miss must not shadow the icon that arrives.
  it("clears a recorded miss when the icon later arrives", async () => {
    const store = createFaviconStore(await tempDir());
    await store.putMiss("https://a.test/");

    await store.put("https://a.test/", new Uint8Array([1]), "image/png");

    const icon = await store.get("https://a.test/");
    expect(icon.ok && icon.value?.dataUri).toBe("data:image/png;base64,AQ==");
    expect(await store.shouldFetch("https://a.test/")).toEqual({ ok: true, value: false });
  });

  // The filename is a hash, so a url that looks like a path cannot walk out
  // of the cache directory. Without this the origin would become the name.
  it("keeps a traversal-shaped url inside the cache directory", async () => {
    const directory = await tempDir();
    const store = createFaviconStore(directory);

    await store.put("https://../../etc.test/x", new Uint8Array([1]), "image/png");

    const written = await readdir(directory);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^[0-9a-f]+\.json$/);
  });

  it("treats a url it cannot parse as a failure, not a crash", async () => {
    const store = createFaviconStore(await tempDir());

    const result = await store.get("not a url");

    expect(result.ok).toBe(false);
  });
});
