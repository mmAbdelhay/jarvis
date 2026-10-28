import { describe, expect, it, vi } from "vitest";
import { appVersion } from "../../app.config";
import { installedVersion } from "./app-version";

const constants = vi.hoisted(() => ({
  expoConfig: { version: "1.2.3" } as { version?: string } | null,
}));
vi.mock("expo-constants", () => ({ default: constants }));

describe("appVersion", () => {
  it.each([
    ["0.1.11", 111],
    ["1.2.3", 10203],
    ["2.0.0", 20000],
  ])("maps %s to Android versionCode %i", (version, versionCode) => {
    expect(appVersion(JSON.stringify({ version }))).toEqual({ version, versionCode });
  });

  it.each([
    "not json",
    "null",
    "{}",
    '{"version":123}',
    ...[
      "",
      "1.2",
      "v1.2.3",
      "01.2.3",
      "1.2.3-beta.1",
      "1.2.3\n",
      "1.100.0",
      "1.0.100",
      "999999999999.0.0",
      "0.0.0",
    ].map((version) => JSON.stringify({ version })),
  ])("rejects malformed or unencodable desktop metadata: %s", (text) => {
    expect(() => appVersion(text)).toThrow();
  });
});

describe("installedVersion", () => {
  it("reads the installed Expo config version", () => {
    expect(installedVersion()).toBe("1.2.3");
    constants.expoConfig = { version: "0.1.11" };
    expect(installedVersion()).toBe("0.1.11");
  });

  it("falls back when the Expo config or version is unavailable", () => {
    constants.expoConfig = {};
    expect(installedVersion()).toBe("0.0.0");
    constants.expoConfig = null;
    expect(installedVersion()).toBe("0.0.0");
  });
});
