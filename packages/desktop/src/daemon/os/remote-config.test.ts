import { describe, expect, it } from "vitest";
import type { ConfigIo } from "./provider-config.js";
import {
  DEFAULT_OS_REMOTE,
  parseOsRemoteSection,
  readOsRemoteConfig,
  toBridgeConfig,
  writeOsRemoteSection,
} from "./remote-config.js";

function io(initial?: string): ConfigIo & { text(): string | undefined } {
  let text = initial;
  return {
    readFile: async () => {
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    },
    writeFile: async (_path, next) => {
      text = next;
    },
    text: () => text,
  };
}

describe("jarvis.yaml remote: for the OS bridge", () => {
  it("defaults to off on loopback", async () => {
    await expect(readOsRemoteConfig("/c.yaml", io())).resolves.toEqual(DEFAULT_OS_REMOTE);
    expect(DEFAULT_OS_REMOTE).toEqual({
      enabled: false,
      bindAddress: "127.0.0.1",
      port: 7717,
      idleDisableMinutes: 0,
      tls: {},
    });
  });

  it("reads a configured section and refuses hostnames and bad values", () => {
    expect(
      parseOsRemoteSection({
        enabled: true,
        bindAddress: "100.64.0.5",
        port: 7800,
        idleDisableMinutes: 30,
      }),
    ).toEqual({
      enabled: true,
      bindAddress: "100.64.0.5",
      port: 7800,
      idleDisableMinutes: 30,
      tls: {},
    });
    expect(() => parseOsRemoteSection({ bindAddress: "laptop.local" })).toThrow(/IP address/);
    expect(() => parseOsRemoteSection({ enabled: "yes" })).toThrow();
    expect(() => parseOsRemoteSection({ port: 70_000 })).toThrow();
    expect(() => parseOsRemoteSection({ tls: { certPath: "/c.pem" } })).toThrow(/together/);
  });

  it("writes only the keys it was given, keeping comments and other sections", async () => {
    const file = io("# mine\nos:\n  memory: { enabled: true }\nremote:\n  port: 7800 # chosen\n");
    await writeOsRemoteSection("/c.yaml", { enabled: true, bindAddress: "0.0.0.0" }, file);
    const text = file.text() ?? "";
    expect(text).toContain("# mine");
    expect(text).toContain("# chosen");
    expect(text).toContain("memory: { enabled: true }");
    await expect(readOsRemoteConfig("/c.yaml", file)).resolves.toMatchObject({
      enabled: true,
      bindAddress: "0.0.0.0",
      port: 7800,
    });
  });

  it("maps to a bridge config with no sidecar proxy and no web client", () => {
    expect(toBridgeConfig({ ...DEFAULT_OS_REMOTE, enabled: true })).toEqual({
      enabled: true,
      bindAddress: "127.0.0.1",
      port: 7717,
      tls: {},
      sidecarProxy: false,
      idleDisableMinutes: 0,
      web: { enabled: false, port: 7718 },
    });
  });
});
