// Free-signing plan, work item 3 — the pure half of expiry awareness.
import { describe, expect, test } from "vitest";
import {
  EXPIRY_NOTIFICATION_ID,
  decodeBase64,
  expiryDaysLeft,
  loadProvisioningExpiry,
  parseExpirationDate,
  shouldWarn,
  armExpiryWarning,
} from "./provisioning-expiry";

// A minimal stand-in for the profile: DER noise around plist text, the
// same shape a real embedded.mobileprovision has.
const PROFILE_TEXT = [
  "\x30\x82\x01\x00binary-noise",
  "<key>Name</key><string>iOS Team Provisioning Profile</string>",
  "<key>ExpirationDate</key>\n\t<date>2026-09-28T10:00:00Z</date>",
  "more-noise\xff\xfe",
].join("\n");

function toBase64(binary: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < binary.length; i += 3) {
    const a = binary.charCodeAt(i);
    const b = i + 1 < binary.length ? binary.charCodeAt(i + 1) : undefined;
    const c = i + 2 < binary.length ? binary.charCodeAt(i + 2) : undefined;
    out += alphabet[a >> 2];
    out += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : alphabet[c & 63];
  }
  return out;
}

describe("decodeBase64", () => {
  test("round-trips arbitrary bytes, padding and newlines included", () => {
    expect(decodeBase64(toBase64(PROFILE_TEXT))).toBe(PROFILE_TEXT);
    expect(decodeBase64("aGk=")).toBe("hi");
    expect(decodeBase64("aGk=\n")).toBe("hi");
  });

  test("foreign characters answer undefined, never a mangled blob", () => {
    expect(decodeBase64("aG!k")).toBeUndefined();
  });
});

describe("parseExpirationDate", () => {
  test("finds the ExpirationDate plist entry inside DER noise", () => {
    expect(parseExpirationDate(PROFILE_TEXT)?.toISOString()).toBe("2026-09-28T10:00:00.000Z");
  });

  test("absent key or garbage date -> undefined", () => {
    expect(parseExpirationDate("no plist here")).toBeUndefined();
    expect(parseExpirationDate("<key>ExpirationDate</key><date>not-a-date</date>")).toBeUndefined();
  });
});

describe("expiryDaysLeft / shouldWarn", () => {
  const now = new Date("2026-09-21T12:00:00Z");

  test("rounds up and floors at zero", () => {
    expect(expiryDaysLeft(new Date("2026-09-28T10:00:00Z"), now)).toBe(7);
    expect(expiryDaysLeft(new Date("2026-09-21T18:00:00Z"), now)).toBe(1);
    expect(expiryDaysLeft(new Date("2026-09-20T12:00:00Z"), now)).toBe(0);
  });

  test("warns only under 2 days, never without an expiry", () => {
    expect(shouldWarn(new Date("2026-09-23T11:59:00Z"), now)).toBe(true);
    expect(shouldWarn(new Date("2026-09-23T12:01:00Z"), now)).toBe(false);
    expect(shouldWarn(undefined, now)).toBe(false);
  });
});

describe("loadProvisioningExpiry", () => {
  test("android never reads; ios reads, decodes and parses", async () => {
    let asked: string | undefined;
    const read = async (name: string) => {
      asked = name;
      return toBase64(PROFILE_TEXT);
    };
    expect(
      await loadProvisioningExpiry({ platform: "android", readBundleFileBase64: read }),
    ).toBeUndefined();
    expect(asked).toBeUndefined();
    const expiry = await loadProvisioningExpiry({ platform: "ios", readBundleFileBase64: read });
    expect(asked).toBe("embedded.mobileprovision");
    expect(expiry?.toISOString()).toBe("2026-09-28T10:00:00.000Z");
  });

  test("a missing profile (App Store build, simulator) -> undefined", async () => {
    expect(
      await loadProvisioningExpiry({
        platform: "ios",
        readBundleFileBase64: async () => undefined,
      }),
    ).toBeUndefined();
  });
});

describe("armExpiryWarning", () => {
  const now = new Date("2026-09-21T12:00:00Z");
  const strings = { title: "t", body: "b" };

  function fakes() {
    const scheduled: { identifier: string; date: Date }[] = [];
    const cancelled: string[] = [];
    return {
      scheduled,
      cancelled,
      deps: {
        now: () => now,
        getPermission: async () => "granted",
        scheduleLocal: async (input: { identifier: string; date: Date }) => {
          scheduled.push({ identifier: input.identifier, date: input.date });
        },
        cancelScheduledLocal: async (identifier: string) => {
          cancelled.push(identifier);
        },
        strings,
      },
    };
  }

  test("no expiry -> off, nothing scheduled or cancelled", async () => {
    const { deps, scheduled, cancelled } = fakes();
    const state = await armExpiryWarning({ ...deps, loadExpiry: async () => undefined });
    expect(state).toEqual({ expiry: undefined, daysLeft: undefined, warn: false });
    expect(scheduled).toEqual([]);
    expect(cancelled).toEqual([]);
  });

  test("7 days out: no banner, notification lands a day before expiry", async () => {
    const { deps, scheduled, cancelled } = fakes();
    const expiry = new Date("2026-09-28T10:00:00Z");
    const state = await armExpiryWarning({ ...deps, loadExpiry: async () => expiry });
    expect(state).toEqual({ expiry, daysLeft: 7, warn: false });
    expect(cancelled).toEqual([EXPIRY_NOTIFICATION_ID]);
    expect(scheduled).toEqual([
      { identifier: EXPIRY_NOTIFICATION_ID, date: new Date("2026-09-27T10:00:00Z") },
    ]);
  });

  test("under a day left: banner on, stale notification cancelled, none rescheduled", async () => {
    const { deps, scheduled, cancelled } = fakes();
    const expiry = new Date("2026-09-22T10:00:00Z");
    const state = await armExpiryWarning({ ...deps, loadExpiry: async () => expiry });
    expect(state.warn).toBe(true);
    expect(state.daysLeft).toBe(1);
    expect(cancelled).toEqual([EXPIRY_NOTIFICATION_ID]);
    expect(scheduled).toEqual([]);
  });

  test("permission not granted: banner still computed, no scheduling calls", async () => {
    const { deps, scheduled, cancelled } = fakes();
    const expiry = new Date("2026-09-22T10:00:00Z");
    const state = await armExpiryWarning({
      ...deps,
      getPermission: async () => "denied",
      loadExpiry: async () => expiry,
    });
    expect(state.warn).toBe(true);
    expect(scheduled).toEqual([]);
    expect(cancelled).toEqual([]);
  });

  test("a throwing scheduler degrades to banner-only", async () => {
    const { deps } = fakes();
    const expiry = new Date("2026-09-28T10:00:00Z");
    const state = await armExpiryWarning({
      ...deps,
      cancelScheduledLocal: async () => {
        throw new Error("native says no");
      },
      loadExpiry: async () => expiry,
    });
    expect(state).toEqual({ expiry, daysLeft: 7, warn: false });
  });
});
