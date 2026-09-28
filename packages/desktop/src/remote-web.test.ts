import { describe, expect, it } from "vitest";
import type { RemoteStatus } from "@jarvis/remote";
import { remoteDeviceClient, remoteWebState, remoteWebUrl } from "./remote-web.js";

const ORIGIN = "https://laptop.tail1234.ts.net:7718";
const PAIR_URL = `${ORIGIN}/pair#v=2&host=100.64.0.1`;

function status(overrides: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    enabled: true,
    listening: undefined,
    pairing: { kind: "closed" },
    devices: [],
    problem: undefined,
    sidecarProxy: "off",
    ...overrides,
  };
}

const ON: RemoteStatus["web"] = { kind: "on", port: 7718, origin: ORIGIN };

describe("remoteWebState", () => {
  it.each<[RemoteStatus["web"], string]>([
    [undefined, "off"],
    [{ kind: "off" }, "off"],
    [{ kind: "off", reason: "port-conflict" }, "port-conflict"],
    [{ kind: "off", reason: "listen-failed" }, "listen-failed"],
    [{ kind: "needs-certificate" }, "needs-certificate"],
    [{ kind: "needs-owner-password" }, "needs-owner-password"],
    [{ kind: "not-built" }, "not-built"],
    [ON, "on"],
  ])("%j → %s", (web, expected) => {
    expect(remoteWebState(status(web === undefined ? {} : { web }))).toBe(expected);
  });
});

describe("remoteWebUrl", () => {
  it("is the root URL while web is on and no pairing window is open", () => {
    expect(remoteWebUrl(status({ web: ON }))).toBe(`${ORIGIN}/`);
  });

  it("is the browser pairing link while a pairing window is open", () => {
    const pairing = {
      kind: "open" as const,
      uri: "jarvis://pair?x",
      expiresAt: 1,
      webUri: PAIR_URL,
    };
    expect(remoteWebUrl(status({ web: ON, pairing }))).toBe(PAIR_URL);
  });

  it("falls back to the root URL for an open window with no browser link", () => {
    const pairing = { kind: "open" as const, uri: "jarvis://pair?x", expiresAt: 1 };
    expect(remoteWebUrl(status({ web: ON, pairing }))).toBe(`${ORIGIN}/`);
  });

  it.each<RemoteStatus["web"]>([undefined, { kind: "off" }, { kind: "not-built" }])(
    "is undefined while web is %j, even with a browser link in the pairing status",
    (web) => {
      const pairing = {
        kind: "open" as const,
        uri: "jarvis://pair?x",
        expiresAt: 1,
        webUri: PAIR_URL,
      };
      expect(
        remoteWebUrl(status({ pairing, ...(web === undefined ? {} : { web }) })),
      ).toBeUndefined();
    },
  );
});

describe("remoteDeviceClient", () => {
  const device = { id: "a", name: "A", pairedAt: 1, lastSeenAt: undefined, connected: false };

  it('is "web" for a browser-paired device', () => {
    expect(remoteDeviceClient({ ...device, client: "web" })).toBe("web");
  });

  it('is "app" when the record has no client (every device paired before Phase 1)', () => {
    expect(remoteDeviceClient(device)).toBe("app");
  });
});
