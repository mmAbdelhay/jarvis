import type { RemoteStatus } from "@jarvis/remote";
import { describe, expect, it } from "vitest";
import { isBridgeWebUrl, openBridgeWebUrl, urlForLog } from "./open-external-guard.js";

function status(overrides: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    enabled: true,
    listening: {
      host: "100.64.0.1",
      port: 7717,
      fingerprint: "ab",
      certificate: { source: "configured", hostname: "mac.tail.ts.net" },
    },
    pairing: { kind: "closed" },
    devices: [],
    problem: undefined,
    sidecarProxy: "on",
    web: { kind: "on", port: 7718, origin: "https://mac.tail.ts.net:7718" },
    ...overrides,
  } as RemoteStatus;
}

describe("isBridgeWebUrl", () => {
  it("accepts https on the certificate's host at the web or the bridge port", () => {
    expect(isBridgeWebUrl("https://mac.tail.ts.net:7718/", status())).toBe(true);
    expect(isBridgeWebUrl("https://MAC.tail.ts.net:7718/pair#secret", status())).toBe(true);
    expect(isBridgeWebUrl("https://mac.tail.ts.net:7717/", status())).toBe(true);
  });

  it.each([
    ["file:///etc/passwd"],
    ["javascript:alert(1)"],
    ["smb://mac.tail.ts.net:7718/"],
    ["http://mac.tail.ts.net:7718/"],
    ["https://evil.test:7718/"],
    ["https://mac.tail.ts.net/"],
    ["https://mac.tail.ts.net:9999/"],
    ["https://user:pw@mac.tail.ts.net:7718/"],
    ["not a url"],
  ])("refuses %s", (url) => {
    expect(isBridgeWebUrl(url, status())).toBe(false);
  });

  it("refuses everything when the bridge has no certificate name or isn't listening", () => {
    const url = "https://mac.tail.ts.net:7718/";
    expect(
      isBridgeWebUrl(
        url,
        status({
          listening: {
            host: "h",
            port: 7717,
            fingerprint: "ab",
            certificate: { source: "self-signed", hostname: undefined },
          },
        }),
      ),
    ).toBe(false);
    expect(isBridgeWebUrl(url, status({ listening: undefined, web: { kind: "off" } }))).toBe(false);
  });
});

describe("openBridgeWebUrl", () => {
  it("opens the bridge's web client and drops anything else, logging only scheme and host", async () => {
    const opened: string[] = [];
    const logs: string[] = [];
    const deps = {
      status: async () => status(),
      open: async (url: string) => {
        opened.push(url);
      },
      log: (line: string) => logs.push(line),
    };
    await openBridgeWebUrl("https://mac.tail.ts.net:7718/pair#k=SECRET", deps);
    await openBridgeWebUrl("https://evil.test/path?token=SECRET#x", deps);
    await openBridgeWebUrl("file:///Users/me/.ssh/id_rsa", deps);

    expect(opened).toEqual(["https://mac.tail.ts.net:7718/pair#k=SECRET"]);
    expect(logs).toEqual([
      "refused to open https://evil.test (not the bridge's web client)",
      "refused to open file: (not the bridge's web client)",
    ]);
    expect(logs.join("\n")).not.toMatch(/SECRET|token|id_rsa/);
  });

  it("names an unparseable URL without echoing it", () => {
    expect(urlForLog("::: secret")).toBe("an unparseable URL");
  });
});
