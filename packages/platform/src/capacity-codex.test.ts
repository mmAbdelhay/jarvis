import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_LOGS_TO_SCAN,
  codexSessionsDir,
  createCodexCapacityReader,
  parseCodexRateLimits,
} from "./capacity-codex.js";

// The real shape, trimmed: a token_count event_msg with rate_limits under payload.
const LINE = (ordinal: number, used: number, ts = "2026-09-20T13:36:36.803Z"): string =>
  JSON.stringify({
    timestamp: ts,
    ordinal,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 2481311 } },
      rate_limits: {
        limit_id: "codex",
        limit_name: null,
        primary: { used_percent: used, window_minutes: 300, resets_at: 1789928531 },
        secondary: { used_percent: 79.0, window_minutes: 10080, resets_at: 1790326065 },
        credits: { has_credits: false, unlimited: false, balance: "0" },
      },
    },
  });

describe("codexSessionsDir", () => {
  it("is ~/.codex/sessions, or $CODEX_HOME/sessions when set", () => {
    // codexSessionsDir builds these with `join()` (platform-correct —
    // backslash-joined on win32), so the expected value is built the same
    // way rather than as a POSIX-literal regex.
    expect(codexSessionsDir({}, "/home/u")).toBe(join("/home/u", ".codex", "sessions"));
    expect(codexSessionsDir({ CODEX_HOME: "/x/codex" }, "/home/u")).toBe(
      join("/x/codex", "sessions"),
    );
    expect(codexSessionsDir({ CODEX_HOME: "" }, "/home/u")).toMatch(/\.codex[\\/]sessions$/);
  });
});

describe("parseCodexRateLimits", () => {
  it("takes the newest rate_limits line (scanning from the end), rounds the percentage and converts epoch seconds", () => {
    const text = [
      '{"timestamp":"2026-09-20T13:00:00.000Z","type":"session_meta","payload":{}}',
      LINE(1, 4.0, "2026-09-20T13:10:00.000Z"),
      '{"type":"response_item","payload":{"text":"nothing here"}}',
      LINE(2, 9.4),
      "",
    ].join("\n");
    expect(parseCodexRateLimits(text)).toEqual({
      ok: true,
      primary: { usedPercent: 9, resetsAt: "2026-09-20T18:22:11.000Z" },
      secondary: { usedPercent: 79, resetsAt: "2026-09-25T08:47:45.000Z" },
      readAt: Date.parse("2026-09-20T13:36:36.803Z"),
    });
  });

  it("is undefined for a log with no rate_limits line at all (a session that never reached the model)", () => {
    expect(parseCodexRateLimits('{"type":"session_meta"}\n{"type":"event_msg"}\n')).toBeUndefined();
    expect(parseCodexRateLimits("")).toBeUndefined();
  });

  it("skips a rate_limits line that does not parse and keeps looking [bite-proof: bail on the first bad line and a truncated tail hides every good reading above it]", () => {
    const text = [LINE(1, 12), '{"timestamp":"x","payload":{"rate_limits":{"primary":{"used_'].join(
      "\n",
    );
    const reading = parseCodexRateLimits(text);
    expect(reading?.ok).toBe(true);
    expect(reading?.ok && reading.primary.usedPercent).toBe(12);
  });

  it("finds rate_limits nested one level deeper too (older Codex wrote it under payload.info)", () => {
    const text = JSON.stringify({
      timestamp: "2026-09-20T13:36:36.803Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          rate_limits: { primary: { used_percent: 50, resets_at: 1789928531 } },
        },
      },
    });
    expect(parseCodexRateLimits(text)?.ok).toBe(true);
  });

  it("skips a line whose primary window is malformed, and tolerates a missing secondary", () => {
    const bad = JSON.stringify({
      payload: { rate_limits: { primary: { used_percent: "9", resets_at: 1789928531 } } },
    });
    const noSecondary = JSON.stringify({
      payload: { rate_limits: { primary: { used_percent: 9, resets_at: 1789928531 } } },
    });
    expect(parseCodexRateLimits(bad)).toBeUndefined();
    const reading = parseCodexRateLimits(`${noSecondary}\n${bad}`);
    expect(reading?.ok).toBe(true);
    expect(reading?.ok && reading.secondary).toBeUndefined();
    expect(reading).not.toHaveProperty("readAt");
  });
});

describe("createCodexCapacityReader", () => {
  it("returns the first log (newest first) that has a reading, opening no more than CODEX_LOGS_TO_SCAN", async () => {
    const opened: string[] = [];
    const read = createCodexCapacityReader({
      sessionsDir: "/s",
      listLogs: async (dir, limit) => {
        expect(dir).toBe("/s");
        expect(limit).toBe(CODEX_LOGS_TO_SCAN);
        return ["/s/2026/09/20/rollout-b.jsonl", "/s/2026/09/20/rollout-a.jsonl"];
      },
      readFile: async (path) => {
        opened.push(path);
        return path.endsWith("b.jsonl") ? '{"type":"session_meta"}\n' : `${LINE(1, 22)}\n`;
      },
    });
    const reading = await read();
    expect(opened).toEqual(["/s/2026/09/20/rollout-b.jsonl", "/s/2026/09/20/rollout-a.jsonl"]);
    expect(reading.ok && reading.primary.usedPercent).toBe(22);
  });

  it("is unavailable, not a rejection, when there are no logs or a log cannot be read", async () => {
    const none = createCodexCapacityReader({ sessionsDir: "/s", listLogs: async () => [] });
    await expect(none()).resolves.toEqual({ ok: false, reason: "unavailable" });
    const broken = createCodexCapacityReader({
      sessionsDir: "/s",
      listLogs: async () => ["/s/x.jsonl"],
      readFile: async () => {
        throw new Error("EACCES");
      },
    });
    await expect(broken()).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("is unavailable when the sessions directory does not exist (real listing, no fixture)", async () => {
    const read = createCodexCapacityReader({ sessionsDir: "/nonexistent/jarvis-codex-sessions" });
    await expect(read()).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});
