import { describe, expect, it } from "vitest";
import { fakeClock } from "./clock-double.js";
import { memoryFs } from "./fs-double.js";
import type { RandomBytes } from "./io.js";
import { createSessionStore } from "./sessions.js";

const PATH = "/remote/sessions.json";
const DAY = 24 * 60 * 60 * 1_000;

function countingRandom(): RandomBytes {
  let byte = 0;
  return (size) => Buffer.alloc(size, ++byte);
}

function makeStore(start = 1_000) {
  const fs = memoryFs();
  const clock = fakeClock(start);
  const store = createSessionStore({
    fs,
    path: PATH,
    random: countingRandom(),
    now: clock.now,
    enforceFileModes: true,
  });
  return { fs, clock, store };
}

describe("createSessionStore", () => {
  it("rotates refresh tokens and keeps access tokens in memory only", async () => {
    const { fs, store } = makeStore();
    const issued = await store.issue("device-a");

    expect(issued.access).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.refresh).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.accessExpiresAt).toBe(1_000 + 15 * 60 * 1_000);
    expect(store.verifyAccess("device-a", issued.access)).toEqual({
      familyId: issued.familyId,
      expiresAt: issued.accessExpiresAt,
    });
    expect(store.verifyAccess("device-b", issued.access)).toBeUndefined();

    const rotated = await store.refresh("device-a", issued.refresh);
    expect(rotated).toMatchObject({ kind: "ok", familyId: issued.familyId });
    if (rotated.kind !== "ok") throw new Error("expected rotation");
    expect(rotated.refresh).not.toBe(issued.refresh);

    const text = fs.files.get(PATH)?.data ?? "";
    expect(fs.files.get(PATH)?.mode).toBe(0o600);
    expect(fs.dirs.get("/remote")).toBe(0o700);
    expect(text).not.toContain(issued.access);
    expect(text).not.toContain(issued.refresh);
    expect(text).not.toContain(rotated.access);
    expect(text).not.toContain(rotated.refresh);
    expect(JSON.parse(text).sessions).toHaveLength(2);
  });

  it("detects reuse of a rotated token and revokes its whole family", async () => {
    const { store } = makeStore();
    const issued = await store.issue("device-a");
    const rotated = await store.refresh("device-a", issued.refresh);
    if (rotated.kind !== "ok") throw new Error("expected rotation");

    expect(await store.refresh("device-a", issued.refresh)).toEqual({
      kind: "reuse",
      familyId: issued.familyId,
    });
    expect(await store.refresh("device-a", rotated.refresh)).toEqual({ kind: "invalid" });
    expect(store.verifyAccess("device-a", issued.access)).toBeUndefined();
    expect(store.verifyAccess("device-a", rotated.access)).toBeUndefined();
  });

  it("expires a refresh token after 7 days idle plus 1ms", async () => {
    const { clock, store } = makeStore();
    const issued = await store.issue("device-a");
    clock.advance(7 * DAY + 1);
    expect(await store.refresh("device-a", issued.refresh)).toEqual({ kind: "invalid" });
  });

  it("expires a refresh family at exactly 30 days", async () => {
    const { clock, store } = makeStore();
    const issued = await store.issue("device-a");
    clock.advance(6 * DAY);
    const first = await store.refresh("device-a", issued.refresh);
    if (first.kind !== "ok") throw new Error("expected rotation");
    clock.advance(6 * DAY);
    const second = await store.refresh("device-a", first.refresh);
    if (second.kind !== "ok") throw new Error("expected rotation");
    clock.advance(6 * DAY);
    const third = await store.refresh("device-a", second.refresh);
    if (third.kind !== "ok") throw new Error("expected rotation");
    clock.advance(6 * DAY);
    const fourth = await store.refresh("device-a", third.refresh);
    if (fourth.kind !== "ok") throw new Error("expected rotation");
    clock.advance(6 * DAY);
    expect(await store.refresh("device-a", fourth.refresh)).toEqual({ kind: "invalid" });
  });

  it("revokeDevice removes only that device's sessions", async () => {
    const { store } = makeStore();
    const a = await store.issue("device-a");
    const b = await store.issue("device-b");
    await store.revokeDevice("device-a");
    expect(await store.refresh("device-a", a.refresh)).toEqual({ kind: "invalid" });
    expect((await store.refresh("device-b", b.refresh)).kind).toBe("ok");
  });

  it("revokeAll removes every refresh and access session", async () => {
    const { store } = makeStore();
    const a = await store.issue("device-a");
    const b = await store.issue("device-b");
    await store.revokeAll();
    expect(await store.refresh("device-a", a.refresh)).toEqual({ kind: "invalid" });
    expect(await store.refresh("device-b", b.refresh)).toEqual({ kind: "invalid" });
    expect(store.verifyAccess("device-a", a.access)).toBeUndefined();
    expect(store.verifyAccess("device-b", b.access)).toBeUndefined();
  });

  it("loads persisted refresh records, purges expired ones, and tolerates corrupt files", async () => {
    const { fs, clock, store } = makeStore();
    const issued = await store.issue("device-a");
    const reloaded = createSessionStore({
      fs,
      path: PATH,
      random: countingRandom(),
      now: clock.now,
      enforceFileModes: true,
    });
    await reloaded.load();
    expect((await reloaded.refresh("device-a", issued.refresh)).kind).toBe("ok");

    fs.files.set(PATH, { data: "not json", mode: 0o644 });
    const corrupt = createSessionStore({
      fs,
      path: PATH,
      random: countingRandom(),
      now: clock.now,
      enforceFileModes: true,
    });
    await expect(corrupt.load()).resolves.toBeUndefined();
    expect(await corrupt.refresh("device-a", issued.refresh)).toEqual({ kind: "invalid" });
  });
});
