import { describe, expect, it } from "vitest";
import { memoryFs } from "./fs-double.js";
import type { RandomBytes } from "./io.js";
import type { OwnerHashParams, PasskeyRecord } from "./owner.js";
import { createOwnerStore, OWNER_HASH_PARAMS } from "./owner.js";

const PATH = "/remote/owner.json";
// Unit tests run scrypt at a tiny cost so the suite stays fast; the one
// test named "real parameters" below covers N=2^17 itself.
const FAST: OwnerHashParams = { N: 2 ** 4, r: 8, p: 1 };
const PASSWORD = "correct horse battery";

function countingRandom(): RandomBytes {
  let call = 0;
  return (size: number) => Buffer.alloc(size, ++call);
}

function makeStore(
  overrides: { fs?: ReturnType<typeof memoryFs>; hashParams?: OwnerHashParams } = {},
) {
  const fs = overrides.fs ?? memoryFs();
  const store = createOwnerStore({
    fs,
    path: PATH,
    random: countingRandom(),
    now: () => 5_000,
    enforceFileModes: true,
    hashParams: overrides.hashParams ?? FAST,
  });
  return { fs, store };
}

function passkey(overrides: Partial<PasskeyRecord> = {}): PasskeyRecord {
  return {
    credentialId: "Y3JlZC0x",
    publicKey: "cHVibGljLWtleQ",
    alg: -7,
    signCount: 0,
    label: "Laptop Chrome",
    createdAt: 1_000,
    ...overrides,
  };
}

describe("createOwnerStore: password", () => {
  it("has no password when no file exists", async () => {
    const { store } = makeStore();
    await store.load();
    expect(store.hasPassword()).toBe(false);
    expect(await store.verifyPassword(PASSWORD)).toBe(false);
    expect(store.credentialsVersion()).toBe(0);
  });

  it("round-trips a password: the right one verifies, a wrong one does not", async () => {
    const { store } = makeStore();
    await store.load();
    expect(await store.setPassword(PASSWORD)).toBe("ok");
    expect(store.hasPassword()).toBe(true);
    expect(await store.verifyPassword(PASSWORD)).toBe(true);
    expect(await store.verifyPassword(`${PASSWORD}!`)).toBe(false);
    expect(await store.verifyPassword("")).toBe(false);
  });

  it("round-trips through the file: a second store loads the same hash and verifies", async () => {
    const { fs, store } = makeStore();
    await store.load();
    await store.setPassword(PASSWORD);

    const { store: reloaded } = makeStore({ fs });
    await reloaded.load();
    expect(reloaded.hasPassword()).toBe(true);
    expect(await reloaded.verifyPassword(PASSWORD)).toBe(true);
    expect(await reloaded.verifyPassword("wrong password here")).toBe(false);
  });

  it("verifies with the params stored in the file, not the store's own current ones", async () => {
    const { fs, store } = makeStore({ hashParams: FAST });
    await store.load();
    await store.setPassword(PASSWORD);

    const { store: reloaded } = makeStore({ fs, hashParams: { N: 2 ** 5, r: 8, p: 1 } });
    await reloaded.load();
    expect(await reloaded.verifyPassword(PASSWORD)).toBe(true);
  });

  it("writes owner.json at 0600 in a 0700 dir, without the password, with the documented fields", async () => {
    const { fs, store } = makeStore();
    await store.load();
    await store.setPassword(PASSWORD);

    expect(fs.dirs.get("/remote")).toBe(0o700);
    const entry = fs.files.get(PATH);
    expect(entry?.mode).toBe(0o600);
    expect(entry?.data).not.toContain(PASSWORD);
    const parsed = JSON.parse(entry?.data ?? "{}");
    expect(parsed.version).toBe(1);
    expect(parsed.password).toMatchObject({ N: FAST.N, r: 8, p: 1 });
    expect(parsed.password.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(parsed.password.hash).toMatch(/^[0-9a-f]{128}$/);
    expect(parsed.passkeys).toEqual([]);
    expect(parsed.credentialsVersion).toBe(1);
    expect([...fs.files.keys()].filter((path) => path.endsWith(".tmp"))).toEqual([]);
  });

  it("tightens a pre-existing owner.json with group/other bits back to 0600 on load", async () => {
    const { fs, store } = makeStore();
    await store.load();
    await store.setPassword(PASSWORD);
    const entry = fs.files.get(PATH);
    fs.files.set(PATH, { data: entry?.data ?? "", mode: 0o644 });

    const { store: reloaded } = makeStore({ fs });
    await reloaded.load();
    expect(fs.files.get(PATH)?.mode).toBe(0o600);
  });

  it("rejects an 11-code-point password and accepts 12, counting code points not UTF-16 units", async () => {
    const { fs, store } = makeStore();
    await store.load();
    expect(await store.setPassword("a".repeat(11))).toBe("too-short");
    // Six astral emoji are 12 UTF-16 units but only 6 code points.
    expect(await store.setPassword("😀".repeat(6))).toBe("too-short");
    expect(store.hasPassword()).toBe(false);
    expect(fs.files.has(PATH)).toBe(false);
    expect(await store.setPassword("a".repeat(12))).toBe("ok");
    expect(store.hasPassword()).toBe(true);
  });

  it("rejects a password longer than the wire's own password limit", async () => {
    const { store } = makeStore();
    await store.load();
    expect(await store.setPassword("a".repeat(1_025))).toBe("too-long");
    expect(await store.setPassword("a".repeat(1_024))).toBe("ok");
  });

  it("bumps credentialsVersion on every password change", async () => {
    const { store } = makeStore();
    await store.load();
    await store.setPassword(PASSWORD);
    await store.setPassword("another long password");
    expect(store.credentialsVersion()).toBe(2);
    expect(await store.verifyPassword(PASSWORD)).toBe(false);
    expect(await store.verifyPassword("another long password")).toBe(true);
  });

  it("keeps the old password when writing the new one fails", async () => {
    const { fs, store } = makeStore();
    await store.load();
    await store.setPassword(PASSWORD);
    fs.rename = async () => {
      throw new Error("disk full");
    };
    await expect(store.setPassword("another long password")).rejects.toThrow(
      "owner.json write failed",
    );
    expect(await store.verifyPassword(PASSWORD)).toBe(true);
  });

  it("never puts the password in a thrown error's text", async () => {
    const { fs, store } = makeStore();
    await store.load();
    fs.rename = async () => {
      throw new Error(`rename failed for ${PASSWORD}`);
    };
    const error = await store.setPassword(PASSWORD).catch((caught: unknown) => caught);
    expect(String(error)).not.toContain(PASSWORD);
  });

  it("uses N=2^17, r=8, p=1 by default, and hashing at those real parameters works", async () => {
    expect(OWNER_HASH_PARAMS).toEqual({ N: 2 ** 17, r: 8, p: 1 });
    const fs = memoryFs();
    const store = createOwnerStore({
      fs,
      path: PATH,
      random: countingRandom(),
      now: () => 0,
      enforceFileModes: true,
    });
    await store.load();
    expect(await store.setPassword(PASSWORD)).toBe("ok");
    expect(JSON.parse(fs.files.get(PATH)?.data ?? "{}").password).toMatchObject({
      N: 2 ** 17,
      r: 8,
      p: 1,
    });
    expect(await store.verifyPassword(PASSWORD)).toBe(true);
    expect(await store.verifyPassword("definitely wrong")).toBe(false);
  }, 15_000);
});

describe("createOwnerStore: owner.json validation", () => {
  it.each([
    ["not JSON", "{"],
    ["wrong version", JSON.stringify({ version: 2, passkeys: [], credentialsVersion: 0 })],
    ["no passkeys array", JSON.stringify({ version: 1, credentialsVersion: 0 })],
    [
      "a bad salt",
      JSON.stringify({
        version: 1,
        password: { hash: "a".repeat(128), salt: "zz", N: 16, r: 8, p: 1 },
        passkeys: [],
        credentialsVersion: 0,
      }),
    ],
    [
      "an N that is not a power of two",
      JSON.stringify({
        version: 1,
        password: { hash: "a".repeat(128), salt: "a".repeat(32), N: 1000, r: 8, p: 1 },
        passkeys: [],
        credentialsVersion: 0,
      }),
    ],
    [
      "an absurd N",
      JSON.stringify({
        version: 1,
        password: { hash: "a".repeat(128), salt: "a".repeat(32), N: 2 ** 30, r: 8, p: 1 },
        passkeys: [],
        credentialsVersion: 0,
      }),
    ],
    [
      "an N and r whose product would need gigabytes",
      JSON.stringify({
        version: 1,
        password: { hash: "a".repeat(128), salt: "a".repeat(32), N: 2 ** 20, r: 32, p: 1 },
        passkeys: [],
        credentialsVersion: 0,
      }),
    ],
    [
      "a bad passkey alg",
      JSON.stringify({
        version: 1,
        passkeys: [{ ...passkey(), alg: -8 }],
        credentialsVersion: 0,
      }),
    ],
    [
      "a malformed owner handle",
      JSON.stringify({ version: 1, passkeys: [], credentialsVersion: 0, ownerHandle: "short" }),
    ],
    [
      "a duplicate passkey",
      JSON.stringify({ version: 1, passkeys: [passkey(), passkey()], credentialsVersion: 0 }),
    ],
  ])("rejects %s, naming the file", async (_name, text) => {
    const fs = memoryFs();
    fs.files.set(PATH, { data: text, mode: 0o600 });
    const { store } = makeStore({ fs });
    await expect(store.load()).rejects.toThrow("owner.json");
  });
});

describe("createOwnerStore: passkeys", () => {
  it("adds, lists and persists a passkey record", async () => {
    const { fs, store } = makeStore();
    await store.load();
    await store.addPasskey(passkey());
    expect(store.listPasskeys()).toEqual([passkey()]);

    const { store: reloaded } = makeStore({ fs });
    await reloaded.load();
    expect(reloaded.listPasskeys()).toEqual([passkey()]);
  });

  it("refuses a duplicate credential id and a malformed record", async () => {
    const { store } = makeStore();
    await store.load();
    await store.addPasskey(passkey());
    await expect(store.addPasskey(passkey())).rejects.toThrow();
    await expect(store.addPasskey(passkey({ credentialId: "not base64url!" }))).rejects.toThrow();
    expect(store.listPasskeys()).toHaveLength(1);
  });

  it("listPasskeys hands out copies, never the store's own records", async () => {
    const { store } = makeStore();
    await store.load();
    await store.addPasskey(passkey());
    const [listed] = store.listPasskeys();
    if (listed !== undefined) listed.signCount = 99;
    expect(store.listPasskeys()[0]?.signCount).toBe(0);
  });

  it("deletePasskey removes it, bumps credentialsVersion, and answers false for an unknown id", async () => {
    const { store } = makeStore();
    await store.load();
    await store.addPasskey(passkey());
    expect(store.credentialsVersion()).toBe(0);
    expect(await store.deletePasskey("Y3JlZC0x")).toBe(true);
    expect(store.listPasskeys()).toEqual([]);
    expect(store.credentialsVersion()).toBe(1);
    expect(await store.deletePasskey("Y3JlZC0x")).toBe(false);
    expect(store.credentialsVersion()).toBe(1);
  });

  it("deletePasskey keeps the passkey gone in memory even when the write fails", async () => {
    const { fs, store } = makeStore();
    await store.load();
    await store.addPasskey(passkey());
    fs.rename = async () => {
      throw new Error("disk full");
    };
    await expect(store.deletePasskey("Y3JlZC0x")).rejects.toThrow();
    expect(store.listPasskeys()).toEqual([]);
  });

  it("updateSignCount persists the new count and answers false for an unknown id", async () => {
    const { fs, store } = makeStore();
    await store.load();
    await store.addPasskey(passkey());
    expect(await store.updateSignCount("Y3JlZC0x", 7)).toBe(true);
    expect(await store.updateSignCount("unknown", 7)).toBe(false);

    const { store: reloaded } = makeStore({ fs });
    await reloaded.load();
    expect(reloaded.listPasskeys()[0]?.signCount).toBe(7);
  });
});

describe("createOwnerStore: owner handle", () => {
  it("makes a 32-byte handle once, persists it and keeps it across a reload", async () => {
    const { fs, store } = makeStore();
    await store.load();
    const handle = await store.ownerHandle();
    expect(Buffer.from(handle, "base64url")).toHaveLength(32);
    expect(await store.ownerHandle()).toBe(handle);

    const { store: reloaded } = makeStore({ fs });
    await reloaded.load();
    expect(await reloaded.ownerHandle()).toBe(handle);
  });

  it("keeps nothing when the first write fails", async () => {
    const { fs, store } = makeStore();
    await store.load();
    const rename = fs.rename;
    fs.rename = async () => {
      throw new Error("disk full");
    };
    await expect(store.ownerHandle()).rejects.toThrow("owner.json write failed");
    fs.rename = rename;
    const handle = await store.ownerHandle();
    const { store: reloaded } = makeStore({ fs });
    await reloaded.load();
    expect(await reloaded.ownerHandle()).toBe(handle);
  });
});
