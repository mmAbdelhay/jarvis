import { describe, expect, it } from "vitest";
import {
  COPILOT_KEYCHAIN_ARGS,
  COPILOT_QUOTA_ARGS,
  createCopilotCapacityReader,
  parseCopilotQuota,
} from "./capacity-copilot.js";

// The real response, trimmed to the fields that matter plus the ones that
// must be ignored (chat/completions are unlimited on every plan).
const USER = {
  copilot_plan: "individual",
  quota_reset_date: "2026-10-01",
  quota_snapshots: {
    chat: { percent_remaining: 100, unlimited: true, timestamp_utc: "2026-09-20T13:36:54.057Z" },
    completions: { percent_remaining: 100, unlimited: true },
    premium_interactions: {
      percent_remaining: 99.8,
      quota_remaining: 199.7,
      unlimited: false,
      remaining: 199,
      entitlement: 200,
      timestamp_utc: "2026-09-20T13:36:54.057Z",
    },
  },
};

describe("parseCopilotQuota", () => {
  it("meters premium requests: used = 100 - percent_remaining, reset = the reset day at midnight UTC, readAt = the snapshot's own stamp", () => {
    expect(parseCopilotQuota(JSON.stringify(USER))).toEqual({
      ok: true,
      primary: { usedPercent: 0, resetsAt: "2026-10-01T00:00:00.000Z" },
      secondary: undefined,
      readAt: Date.parse("2026-09-20T13:36:54.057Z"),
    });
  });

  it("rounds: 37.5% remaining is 63% used (never a fraction on the meter)", () => {
    const text = JSON.stringify({
      ...USER,
      quota_snapshots: { premium_interactions: { percent_remaining: 37.5, unlimited: false } },
    });
    const reading = parseCopilotQuota(text);
    expect(reading.ok && reading.primary.usedPercent).toBe(63);
    expect(reading).not.toHaveProperty("readAt");
  });

  it.each([
    ["not JSON", "<html>"],
    ["no quota_snapshots", JSON.stringify({ copilot_plan: "individual" })],
    ["no premium_interactions", JSON.stringify({ ...USER, quota_snapshots: { chat: {} } })],
    [
      "an unlimited premium allowance (no meter to show)",
      JSON.stringify({
        ...USER,
        quota_snapshots: { premium_interactions: { percent_remaining: 100, unlimited: true } },
      }),
    ],
    [
      "a percentage out of range",
      JSON.stringify({
        ...USER,
        quota_snapshots: { premium_interactions: { percent_remaining: 250, unlimited: false } },
      }),
    ],
    ["a reset date that is not a day", JSON.stringify({ ...USER, quota_reset_date: "soon" })],
    ["a missing reset date", JSON.stringify({ ...USER, quota_reset_date: undefined })],
  ])("is unavailable — never a guess — for %s", (_label, text) => {
    expect(parseCopilotQuota(text)).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("createCopilotCapacityReader", () => {
  it("on darwin, asks as the Copilot CLI's own keychain account first and never touches gh when it answers", async () => {
    const calls: string[] = [];
    const tokensSeen: string[] = [];
    const read = createCopilotCapacityReader({
      platform: "darwin",
      run: async (command, args) => {
        calls.push(command);
        if (command === "security") {
          expect(args).toEqual([...COPILOT_KEYCHAIN_ARGS]);
          return { code: 0, stdout: "gho_worktoken\n", stderr: "" };
        }
        throw new Error("gh must not be called");
      },
      fetchQuota: async (token) => {
        tokensSeen.push(token);
        return JSON.stringify({
          ...USER,
          quota_snapshots: {
            premium_interactions: {
              percent_remaining: 11.1,
              unlimited: false,
              timestamp_utc: "2026-09-20T16:00:00.000Z",
            },
          },
        });
      },
    });
    const reading = await read();
    expect(calls).toEqual(["security"]);
    expect(tokensSeen).toEqual(["gho_worktoken"]);
    expect(reading.ok && reading.primary.usedPercent).toBe(89);
  });

  it("falls back to gh when the keychain has no token, the fetch fails, or the platform is not darwin", async () => {
    const ghAnswer = { code: 0, stdout: JSON.stringify(USER), stderr: "" };
    const noItem = createCopilotCapacityReader({
      platform: "darwin",
      run: async (command) =>
        command === "security" ? { code: 44, stdout: "", stderr: "not found" } : ghAnswer,
      fetchQuota: async () => {
        throw new Error("must not fetch without a token");
      },
    });
    await expect(noItem()).resolves.toMatchObject({ ok: true });

    const fetchFails = createCopilotCapacityReader({
      platform: "darwin",
      run: async (command) =>
        command === "security" ? { code: 0, stdout: "tok", stderr: "" } : ghAnswer,
      fetchQuota: async () => {
        throw new Error("HTTP 401");
      },
    });
    await expect(fetchFails()).resolves.toMatchObject({ ok: true });

    const linuxCalls: string[] = [];
    const linux = createCopilotCapacityReader({
      platform: "linux",
      run: async (command) => {
        linuxCalls.push(command);
        return ghAnswer;
      },
    });
    await expect(linux()).resolves.toMatchObject({ ok: true });
    expect(linuxCalls).toEqual(["gh"]);
  });

  it("runs `gh api /copilot_internal/user` through the caller's runner and parses stdout", async () => {
    const calls: [string, string[]][] = [];
    const read = createCopilotCapacityReader({
      run: async (command, args) => {
        calls.push([command, args]);
        return { code: 0, stdout: JSON.stringify(USER), stderr: "" };
      },
    });
    const reading = await read();
    expect(calls).toEqual([["gh", [...COPILOT_QUOTA_ARGS]]]);
    expect(reading.ok && reading.primary.usedPercent).toBe(0);
  });

  it("is unavailable, not a rejection, when gh exits non-zero (signed out) or cannot be spawned (not installed)", async () => {
    const signedOut = createCopilotCapacityReader({
      run: async () => ({ code: 1, stdout: "", stderr: "gh auth login" }),
    });
    await expect(signedOut()).resolves.toEqual({ ok: false, reason: "unavailable" });
    const missing = createCopilotCapacityReader({
      run: async () => {
        throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      },
    });
    await expect(missing()).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});
