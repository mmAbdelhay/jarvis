import { describe, expect, it } from "vitest";
import { parseNetStatus } from "./doctor.js";
import {
  buildSysSnapshot,
  NO_VOICE,
  isLocalBaseUrl,
  isLoopbackBaseUrl,
  parseFailedUnitNames,
  parseSysHealth,
} from "./sys-snapshot.js";

const health = {
  uptimeSec: 60,
  load1: 0.2,
  memTotalBytes: 8_000,
  memUsedBytes: 3_000,
  swapUsedBytes: 0,
  disks: [
    { mount: "/boot", sizeBytes: 1, usedBytes: 1 },
    { mount: "/", sizeBytes: 64_000, usedBytes: 6_000 },
  ],
  failedUnits: 2,
  bootErrors: 0,
};
const wifiUp = parseNetStatus({
  nmRunning: true,
  connectivity: "full",
  devices: [{ name: "wlan0", type: "wifi", state: "connected", connection: "Home" }],
  ips: [],
  defaultRoute: "192.168.1.1 dev wlan0",
  dnsOk: true,
  gatewayPingOk: true,
  wifiSoftBlocked: false,
  wifiHardBlocked: false,
});

describe("buildSysSnapshot", () => {
  it("builds the contract shape from sys.health, net.status and the failed unit names", () => {
    const parsed = parseSysHealth(health);
    if (parsed === undefined || wifiUp === undefined) throw new Error("fixtures did not parse");
    expect(
      buildSysSnapshot({
        health: parsed,
        net: wifiUp,
        failedUnits: ["cups.service", "foo.service"],
        model: {
          kind: "anthropic",
          model: "claude-sonnet-4-5",
          baseUrl: "https://api.anthropic.com",
          supportsTools: true,
        },
      }),
    ).toEqual({
      online: true,
      network: { connectivity: "full", wifiSsid: "Home" },
      memTotalBytes: 8_000,
      memUsedBytes: 3_000,
      disk: { mount: "/", sizeBytes: 64_000, usedBytes: 6_000 },
      failedUnits: ["cups.service", "foo.service"],
      model: {
        kind: "anthropic",
        model: "claude-sonnet-4-5",
        local: false,
        supportsTools: true,
        download: null,
      },
      updates: { count: 0, security: 0, checkedAt: null },
      locked: false,
      voice: { available: false, stt: null, tts: null, speak: false },
      undo: { available: false, title: null },
    });
  });

  it("reports offline zeros when jarvis-diag is not answering, and a null model when none is set", () => {
    expect(buildSysSnapshot({ failedUnits: [], model: null })).toEqual({
      online: false,
      network: { connectivity: "unknown", wifiSsid: null },
      memTotalBytes: 0,
      memUsedBytes: 0,
      disk: { mount: "/", sizeBytes: 0, usedBytes: 0 },
      failedUnits: [],
      model: null,
      updates: { count: 0, security: 0, checkedAt: null },
      locked: false,
      voice: { available: false, stt: null, tts: null, speak: false },
      undo: { available: false, title: null },
    });
  });

  it("carries the updates summary and the model download (M2 contracts §2, §5)", () => {
    const snapshot = buildSysSnapshot({
      failedUnits: [],
      model: {
        kind: "ollama",
        model: "qwen3:8b",
        baseUrl: "http://127.0.0.1:11434",
        supportsTools: true,
        download: { state: "downloading", percent: 42 },
      },
      updates: { count: 3, security: 1, checkedAt: 1_760_000_000_000 },
    });
    expect(snapshot.model).toEqual({
      kind: "ollama",
      model: "qwen3:8b",
      local: true,
      supportsTools: true,
      download: { state: "downloading", percent: 42 },
    });
    expect(snapshot.updates).toEqual({ count: 3, security: 1, checkedAt: 1_760_000_000_000 });
  });

  it("is not online with limited or portal connectivity", () => {
    const limited = parseNetStatus({ ...wifiUp, connectivity: "limited" });
    if (limited === undefined) throw new Error("did not parse");
    expect(buildSysSnapshot({ net: limited, failedUnits: [], model: null }).online).toBe(false);
  });
});

describe("parsers", () => {
  it("parse sys.health field by field and failed unit names", () => {
    expect(parseSysHealth({ ...health, memTotalBytes: "8" })).toBeUndefined();
    expect(parseFailedUnitNames({ units: [{ unit: "cups.service" }, { unit: 4 }, "x"] })).toEqual([
      "cups.service",
    ]);
    expect(parseFailedUnitNames(null)).toEqual([]);
  });
});

describe("isLocalBaseUrl", () => {
  it("knows which providers keep data on the user's machines", () => {
    for (const url of [
      "http://localhost:11434",
      "http://127.0.0.1:11434",
      "http://192.168.1.20:11434",
      "http://10.0.0.2:8000/v1",
      "http://172.20.0.5:1234/v1",
      "http://ollama.local:11434",
      "http://[::1]:11434",
      "http://[fd00::5]:11434",
    ]) {
      expect(isLocalBaseUrl(url), url).toBe(true);
    }
    for (const url of [
      "https://api.anthropic.com",
      "https://api.openai.com/v1",
      "http://172.32.0.1",
      "https://fdroid.example.org",
      "nonsense",
    ]) {
      expect(isLocalBaseUrl(url), url).toBe(false);
    }
  });
});

describe("isLoopbackBaseUrl", () => {
  it("is true only for loopback, not LAN", () => {
    for (const url of [
      "http://localhost:11434",
      "http://127.0.0.1:1",
      "http://127.1.2.3",
      "http://[::1]:11434",
    ]) {
      expect(isLoopbackBaseUrl(url), url).toBe(true);
    }
    for (const url of [
      "http://192.168.1.20:11434",
      "http://10.0.0.2",
      "http://172.20.0.5",
      "http://169.254.1.1",
      "http://[fd00::5]",
      "http://[fe80::1]",
      "http://ollama.local:11434",
      "https://api.openai.com/v1",
      "nonsense",
    ]) {
      expect(isLoopbackBaseUrl(url), url).toBe(false);
    }
  });
});

describe("sys:snapshot M3 parts", () => {
  it("defaults to unlocked with no voice", () => {
    const snapshot = buildSysSnapshot({ failedUnits: [], model: null });
    expect(snapshot.locked).toBe(false);
    expect(snapshot.undo).toEqual({ available: false, title: null });
    expect(snapshot.voice).toEqual(NO_VOICE);
    expect(NO_VOICE).toEqual({ available: false, stt: null, tts: null, speak: false });
  });
  it("carries the lock state and voice availability it is given", () => {
    const voice = { available: true, stt: "ggml-base", tts: "en_US-amy-medium", speak: true };
    const snapshot = buildSysSnapshot({
      failedUnits: [],
      model: null,
      locked: true,
      voice,
      undo: { available: true, title: "Brightness" },
    });
    expect(snapshot.locked).toBe(true);
    expect(snapshot.undo).toEqual({ available: true, title: "Brightness" });
    expect(snapshot.voice).toEqual(voice);
    expect(snapshot.voice).not.toBe(voice);
  });
});
