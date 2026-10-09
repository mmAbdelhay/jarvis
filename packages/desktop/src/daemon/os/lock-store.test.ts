import { describe, expect, it } from "vitest";
import { createLockStore } from "./lock-store.js";

function memoryFs(initial?: string, readError?: Error) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set("/run/user/1000/jarvis/lock-state.json", initial);
  return {
    files,
    readFile: async (path: string) => {
      if (readError !== undefined) throw readError;
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    },
    writeFile: async (path: string, text: string) => {
      files.set(path, text);
    },
  };
}
const PATH = "/run/user/1000/jarvis/lock-state.json";

describe("createLockStore", () => {
  it("reads unlocked when no state was ever written", async () => {
    await expect(createLockStore(PATH, memoryFs()).read()).resolves.toBe(false);
  });
  it("round-trips the state", async () => {
    const fs = memoryFs();
    const store = createLockStore(PATH, fs);
    await store.write(true);
    await expect(store.read()).resolves.toBe(true);
    expect(JSON.parse(fs.files.get(PATH) ?? "")).toEqual({ locked: true });
  });
  it("an unreadable lock file reads as locked", async () => {
    await expect(createLockStore(PATH, memoryFs("{not json")).read()).resolves.toBe(true);
    await expect(createLockStore(PATH, memoryFs('{"locked":"no"}')).read()).resolves.toBe(true);
    const denied = Object.assign(new Error("EACCES"), { code: "EACCES" });
    await expect(createLockStore(PATH, memoryFs(undefined, denied)).read()).resolves.toBe(true);
  });
});
