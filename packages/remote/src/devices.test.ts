import { describe, expect, it } from "vitest";
import { fakeClock } from "./clock-double.js";
import type { DevicePush } from "./devices.js";
import { createDeviceStore, MAX_DEVICE_NAME_LENGTH, sanitizeDeviceName } from "./devices.js";
import { memoryFs } from "./fs-double.js";
import type { RandomBytes } from "./io.js";

const TOKEN_A = "ExponentPushToken[aaaaaaaaAAAA1111]";
const TOKEN_B = "ExponentPushToken[bbbbbbbbBBBB2222]";

/** A RandomBytes double that fills each call's buffer with an incrementing byte, so successive mints never collide. */
function countingRandom(): RandomBytes {
  let call = 0;
  return (size: number) => Buffer.alloc(size, ++call);
}

const PATH = "/remote/devices.json";

function makeStore(
  overrides: {
    fs?: ReturnType<typeof memoryFs>;
    random?: RandomBytes;
    now?: () => number;
    path?: string;
    log?: (line: string) => void;
  } = {},
) {
  const fs = overrides.fs ?? memoryFs();
  const random = overrides.random ?? countingRandom();
  const now = overrides.now ?? (() => 1_000);
  const path = overrides.path ?? PATH;
  return {
    fs,
    store: createDeviceStore({
      fs,
      path,
      random,
      now,
      enforceFileModes: true,
      ...(overrides.log !== undefined ? { log: overrides.log } : {}),
    }),
  };
}

describe("createDeviceStore", () => {
  it("has zero devices when no file exists", async () => {
    const { store } = makeStore();
    await store.load();
    expect(store.count()).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it("add() writes a 0600 devices.json in a 0700 dir, matching the documented shape, without the token, leaving no .tmp file", async () => {
    const { fs, store } = makeStore({ now: () => 12_345 });
    const { deviceId, token } = await store.add("Phone");

    expect(fs.dirs.get("/remote")).toBe(0o700);
    const entry = fs.files.get(PATH);
    expect(entry?.mode).toBe(0o600);
    expect(entry?.data).not.toContain(token);
    expect([...fs.files.keys()].some((key) => key.endsWith(".tmp"))).toBe(false);

    const parsed = JSON.parse(entry?.data ?? "{}");
    expect(parsed).toEqual({
      version: 1,
      devices: [
        {
          id: deviceId,
          name: "Phone",
          salt: expect.stringMatching(/^[0-9a-f]{32}$/),
          hash: expect.stringMatching(/^[0-9a-f]{128}$/),
          pairedAt: 12_345,
        },
      ],
    });
  });

  it("authenticate() works right after add(), and again from a fresh store loaded off the same fs", async () => {
    const { fs, store } = makeStore();
    const { deviceId, token } = await store.add("A");
    expect(store.authenticate(deviceId, token)?.id).toBe(deviceId);

    const reloaded = createDeviceStore({
      fs,
      path: PATH,
      random: countingRandom(),
      now: () => 2,
      enforceFileModes: true,
    });
    await reloaded.load();
    expect(reloaded.authenticate(deviceId, token)?.id).toBe(deviceId);
  });

  it("authenticate() refuses a wrong token, an unknown id, and another device's token", async () => {
    const { store } = makeStore();
    const a = await store.add("A");
    const b = await store.add("B");

    expect(store.authenticate(a.deviceId, "not-the-right-token")).toBeUndefined();
    expect(store.authenticate("f".repeat(32), a.token)).toBeUndefined();
    expect(store.authenticate(a.deviceId, b.token)).toBeUndefined();
  });

  it("[bite-proof] revoke() removes the device from the map before its promise is awaited", async () => {
    const { fs, store } = makeStore();
    const { deviceId, token } = await store.add("A");

    const revoked = store.revoke(deviceId);
    // Deliberately not awaited yet: the map must already be clear.
    expect(store.authenticate(deviceId, token)).toBeUndefined();
    expect(store.count()).toBe(0);

    expect(await revoked).toBe(true);
    const onDisk = JSON.parse(fs.files.get(PATH)?.data ?? "{}");
    expect(onDisk.devices.find((device: { id: string }) => device.id === deviceId)).toBeUndefined();
  });

  it("revoke() whose rename throws rejects, and the device stays refused", async () => {
    const { fs, store } = makeStore();
    const { deviceId, token } = await store.add("A");
    fs.rename = async () => {
      throw new Error("disk full");
    };

    await expect(store.revoke(deviceId)).rejects.toThrow("disk full");
    expect(store.authenticate(deviceId, token)).toBeUndefined();
  });

  it("revoke() of an unknown id resolves false", async () => {
    const { store } = makeStore();
    expect(await store.revoke("a".repeat(32))).toBe(false);
  });

  it("add() whose rename throws rejects, and count() goes back to 0", async () => {
    const { store, fs } = makeStore();
    fs.rename = async () => {
      throw new Error("disk full");
    };
    await expect(store.add("A")).rejects.toThrow("disk full");
    expect(store.count()).toBe(0);
  });

  it("Promise.all([add A, add B]) then revoke(A) leaves only B on disk", async () => {
    const { fs, store } = makeStore();
    const [a, b] = await Promise.all([store.add("A"), store.add("B")]);
    await store.revoke(a.deviceId);

    const onDisk = JSON.parse(fs.files.get(PATH)?.data ?? "{}");
    expect(onDisk.devices.map((device: { id: string }) => device.id)).toEqual([b.deviceId]);
  });

  it("touch() after advancing the clock sets lastSeenAt to the new now()", async () => {
    const clock = fakeClock(1_000);
    const { store } = makeStore({ now: clock.now });
    const { deviceId } = await store.add("A");
    clock.advance(60_000);
    await store.touch(deviceId);
    expect(store.list().find((device) => device.id === deviceId)?.lastSeenAt).toBe(clock.now());
  });

  it.each<[string, string]>([
    ["non-JSON", "{"],
    ["a version other than 1", JSON.stringify({ version: 2, devices: [] })],
    [
      "a short hash",
      JSON.stringify({
        version: 1,
        devices: [
          {
            id: "a".repeat(32),
            name: "x",
            salt: "a".repeat(32),
            hash: "a".repeat(10),
            pairedAt: 1,
          },
        ],
      }),
    ],
    [
      "a duplicate id",
      JSON.stringify({
        version: 1,
        devices: [
          {
            id: "a".repeat(32),
            name: "x",
            salt: "a".repeat(32),
            hash: "a".repeat(128),
            pairedAt: 1,
          },
          {
            id: "a".repeat(32),
            name: "y",
            salt: "b".repeat(32),
            hash: "b".repeat(128),
            pairedAt: 2,
          },
        ],
      }),
    ],
  ])("load() refuses %s, leaving the file unchanged", async (_label, text) => {
    const fs = memoryFs();
    fs.files.set(PATH, { data: text, mode: 0o600 });
    const { store } = makeStore({ fs });

    await expect(store.load()).rejects.toThrow(/devices\.json/);
    expect(fs.files.get(PATH)?.data).toBe(text);
  });

  it("load() tightens a 0644 devices.json to 0600", async () => {
    const fs = memoryFs();
    fs.files.set(PATH, { data: JSON.stringify({ version: 1, devices: [] }), mode: 0o644 });
    const { store } = makeStore({ fs });

    await store.load();
    expect(fs.files.get(PATH)?.mode).toBe(0o600);
  });

  it('add("\\u{202e}enohp\\nX") stores the sanitised name "enohp X"', async () => {
    const { store } = makeStore();
    const { deviceId } = await store.add("\u{202e}enohp\nX");
    expect(store.list().find((device) => device.id === deviceId)?.name).toBe("enohp X");
  });

  it('add() rejects a name that sanitises to empty, with a message about "name"', async () => {
    const { store } = makeStore();
    await expect(store.add("\u{200b}\u{202e}")).rejects.toThrow(/name/);
  });
});

describe("createDeviceStore: push", () => {
  it("a token registration clears the same token from every other device in one write", async () => {
    const { store } = makeStore();
    const first = await store.add("First");
    const second = await store.add("Second");
    const push: DevicePush = { token: TOKEN_A, platform: "ios", language: "en", registeredAt: 0 };

    await store.setPush(first.deviceId, push);
    await store.setPush(second.deviceId, push);

    expect(store.pushTargets()).toEqual([
      { deviceId: second.deviceId, token: TOKEN_A, platform: "ios", language: "en" },
    ]);
  });

  it("a file with a valid push loads, and pushTargets() lists it", async () => {
    const fs = memoryFs();
    fs.files.set(PATH, {
      data: JSON.stringify({
        version: 1,
        devices: [
          {
            id: "a".repeat(32),
            name: "Phone",
            salt: "a".repeat(32),
            hash: "a".repeat(128),
            pairedAt: 1,
            push: { token: TOKEN_A, platform: "ios", language: "en", registeredAt: 5 },
          },
        ],
      }),
      mode: 0o600,
    });
    const { store } = makeStore({ fs });

    await store.load();

    expect(store.pushTargets()).toEqual([
      { deviceId: "a".repeat(32), token: TOKEN_A, platform: "ios", language: "en" },
    ]);
    expect(store.list()[0]?.push).toBe("ios");
  });

  it('[bite-proof: skip the pattern check] a file with push.token "nope" refuses the whole file', async () => {
    const fs = memoryFs();
    fs.files.set(PATH, {
      data: JSON.stringify({
        version: 1,
        devices: [
          {
            id: "a".repeat(32),
            name: "Phone",
            salt: "a".repeat(32),
            hash: "a".repeat(128),
            pairedAt: 1,
            push: { token: "nope", platform: "ios", language: "en", registeredAt: 5 },
          },
        ],
      }),
      mode: 0o600,
    });
    const { store } = makeStore({ fs });

    await expect(store.load()).rejects.toThrow(/devices\.json/);
    expect(store.count()).toBe(0);
  });

  it("[bite-proof: always persist; the write count is 2] setPush writes once on a fresh device; an identical setPush writes zero more times", async () => {
    const { fs, store } = makeStore();
    const { deviceId } = await store.add("Phone");
    const writesBefore = fs.files.get(PATH)?.data;
    expect(writesBefore).toBeDefined();

    let writeCount = 0;
    const originalRename = fs.rename.bind(fs);
    fs.rename = async (from, to) => {
      writeCount += 1;
      return originalRename(from, to);
    };

    const push: DevicePush = { token: TOKEN_A, platform: "ios", language: "en", registeredAt: 0 };
    expect(await store.setPush(deviceId, push)).toBe("ok");
    expect(writeCount).toBe(1);

    expect(await store.setPush(deviceId, push)).toBe("ok");
    expect(writeCount).toBe(1); // no second write for an identical push
  });

  it("retries an unchanged push registration after its prior write failed", async () => {
    const { fs, store } = makeStore();
    const { deviceId } = await store.add("Phone");
    const originalRename = fs.rename.bind(fs);
    let failOnce = true;
    fs.rename = async (from, to) => {
      if (failOnce) {
        failOnce = false;
        throw new Error(TOKEN_A);
      }
      return originalRename(from, to);
    };
    const push: DevicePush = { token: TOKEN_A, platform: "ios", language: "en", registeredAt: 0 };

    const failed = store.setPush(deviceId, push);
    await expect(failed).rejects.toThrow("devices push write failed");
    await expect(failed).rejects.not.toThrow(TOKEN_A);
    await expect(store.setPush(deviceId, push)).resolves.toBe("ok");
    expect(fs.files.get(PATH)?.data).toContain(TOKEN_A);
  });

  it("an unchanged registration still clears duplicate records holding the same token", async () => {
    const fs = memoryFs();
    const { store: seed } = makeStore({ fs });
    const first = await seed.add("First");
    const second = await seed.add("Second");
    const file = JSON.parse(fs.files.get(PATH)?.data ?? "{}");
    const push = {
      token: TOKEN_A,
      platform: "ios" as const,
      language: "en" as const,
      registeredAt: 7,
    };
    file.devices[0].push = push;
    file.devices[1].push = push;
    fs.files.set(PATH, { data: `${JSON.stringify(file)}\n`, mode: 0o600 });

    const { store } = makeStore({ fs });
    await store.load();
    await store.setPush(first.deviceId, push);

    expect(store.pushTargets()).toEqual([
      { deviceId: first.deviceId, token: TOKEN_A, platform: "ios", language: "en" },
    ]);
    expect(store.pushTargets().some((target) => target.deviceId === second.deviceId)).toBe(false);
  });

  it("a failing push-record write logs a line naming the fs error's code, when it has one", async () => {
    const logs: string[] = [];
    const { fs, store } = makeStore({ log: (line) => logs.push(line) });
    const { deviceId } = await store.add("Phone");
    fs.rename = async () => {
      const error = new Error("rename failed") as Error & { code?: string };
      error.code = "EACCES";
      throw error;
    };
    const push: DevicePush = { token: TOKEN_A, platform: "ios", language: "en", registeredAt: 0 };

    await expect(store.setPush(deviceId, push)).rejects.toThrow("devices push write failed");

    expect(logs.some((line) => line.includes("EACCES"))).toBe(true);
    // Task 6 fix round 1 (review minor): the code is worth logging; the
    // token that failed to save is a credential-adjacent secret and must
    // never be.
    expect(logs.join("\n")).not.toContain(TOKEN_A);
  });

  it("a failing push-record write with no error code still logs, without inventing one", async () => {
    const logs: string[] = [];
    const { fs, store } = makeStore({ log: (line) => logs.push(line) });
    const { deviceId } = await store.add("Phone");
    fs.rename = async () => {
      throw new Error("disk full");
    };
    const push: DevicePush = { token: TOKEN_A, platform: "ios", language: "en", registeredAt: 0 };

    await expect(store.setPush(deviceId, push)).rejects.toThrow("devices push write failed");

    const line = logs.find((entry) => entry.includes("push write failed"));
    expect(line).not.toContain("code=");
    expect(logs.join("\n")).not.toContain(TOKEN_A);
  });

  it(
    "Task 6 fix round 1: a push write failure's log line never carries the underlying error's free-text " +
      "message, only the code when there is one — this log now reaches the bridge's real sink, and the " +
      "failing write is a push registration whose payload carries the token",
    async () => {
      const logs: string[] = [];
      const { fs, store } = makeStore({ log: (line) => logs.push(line) });
      const { deviceId } = await store.add("Phone");
      // A deliberately worst-case error: its *message* is the token itself
      // (nothing a real fs.rename failure would ever produce — a real one
      // is paths and an OS code — but this module cannot prove that for
      // every possible RemoteFs, so it never trusts describeError(error)
      // here regardless).
      fs.rename = async () => {
        throw new Error(TOKEN_A);
      };
      const push: DevicePush = { token: TOKEN_A, platform: "ios", language: "en", registeredAt: 0 };

      await expect(store.setPush(deviceId, push)).rejects.toThrow("devices push write failed");

      expect(logs.join("\n")).not.toContain(TOKEN_A);
    },
  );

  it('setPush(unknown) answers "unknown-device"', async () => {
    const { store } = makeStore();
    const push: DevicePush = { token: TOKEN_A, platform: "ios", language: "en", registeredAt: 0 };
    expect(await store.setPush("f".repeat(32), push)).toBe("unknown-device");
  });

  it('setPush(id, undefined) on a device with no push is a no-op ("ok", no write)', async () => {
    const { fs, store } = makeStore();
    const { deviceId } = await store.add("Phone");
    let writeCount = 0;
    const originalRename = fs.rename.bind(fs);
    fs.rename = async (from, to) => {
      writeCount += 1;
      return originalRename(from, to);
    };

    expect(await store.setPush(deviceId, undefined)).toBe("ok");
    expect(writeCount).toBe(0);
  });

  it("revoke() after setPush() leaves pushTargets() empty", async () => {
    const { store } = makeStore();
    const { deviceId } = await store.add("Phone");
    await store.setPush(deviceId, {
      token: TOKEN_A,
      platform: "android",
      language: "ar",
      registeredAt: 0,
    });
    expect(store.pushTargets()).toHaveLength(1);

    await store.revoke(deviceId);
    expect(store.pushTargets()).toEqual([]);
  });

  it("the serialised file omits the push key for a device without one", async () => {
    const { fs, store } = makeStore();
    await store.add("Phone");
    const onDisk = JSON.parse(fs.files.get(PATH)?.data ?? "{}");
    expect(onDisk.devices[0]).not.toHaveProperty("push");
  });

  it("[bite-proof: return the record; the assertion fails] list() never contains the token string", async () => {
    const { store } = makeStore();
    const { deviceId } = await store.add("Phone");
    await store.setPush(deviceId, {
      token: TOKEN_B,
      platform: "ios",
      language: "en",
      registeredAt: 0,
    });

    expect(JSON.stringify(store.list())).not.toContain(TOKEN_B);
  });
});

describe("sanitizeDeviceName", () => {
  it.each<[string, string]>([
    ["Abdulaziz's iPhone", "Abdulaziz's iPhone"],
    ["هاتف عبدالعزيز", "هاتف عبدالعزيز"],
    ["  padded  ", "padded"],
    ["a\nb\tc\r\nd", "a b c d"],
    ["\u{202e}enohp", "enohp"],
    ["pay\u{2066}pal\u{2069}", "paypal"],
    ["zero\u{200b}width\u{feff}", "zerowidth"],
    ["\u{200b}\u{202e}", ""],
  ])("sanitises %j to %j", (raw, expected) => {
    expect(sanitizeDeviceName(raw)).toBe(expected);
  });

  it("keeps at most 64 code points", () => {
    expect(sanitizeDeviceName("x".repeat(100))).toBe("x".repeat(MAX_DEVICE_NAME_LENGTH));
  });

  it("counts by code point, not UTF-16 code unit, for astral characters", () => {
    const result = sanitizeDeviceName("\u{1f600}".repeat(70));
    expect([...result]).toHaveLength(MAX_DEVICE_NAME_LENGTH);
    expect(result).toBe("\u{1f600}".repeat(MAX_DEVICE_NAME_LENGTH));
  });
});
