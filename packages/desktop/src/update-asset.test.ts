import { describe, expect, it } from "vitest";
import type { ReleaseAsset } from "./update-check.js";
import { isAllowedDownloadUrl, isAllowedRedirect, pickAsset, SUMS_NAME } from "./update-asset.js";

const DOWNLOAD = "https://github.com/mmAbdelhay/jarvis/releases/download/v0.1.9/";
const asset = (name: string, url = DOWNLOAD + name): ReleaseAsset => ({ name, url, size: 1 });
const release = [
  asset("Jarvis-0.1.9-arm64.dmg"),
  asset("Jarvis-0.1.9.AppImage"),
  asset("Jarvis-Setup-0.1.9.exe"),
  asset(SUMS_NAME),
];

describe("pickAsset", () => {
  it("picks the dmg on an Apple-silicon Mac and nothing on an Intel one", () => {
    expect(pickAsset(release, "0.1.9", "darwin", "arm64")?.name).toBe("Jarvis-0.1.9-arm64.dmg");
    expect(pickAsset(release, "0.1.9", "darwin", "x64")).toBeUndefined();
  });

  it("picks the AppImage on x64 Linux and nothing on arm64 Linux", () => {
    expect(pickAsset(release, "0.1.9", "linux", "x64")?.name).toBe("Jarvis-0.1.9.AppImage");
    expect(pickAsset(release, "0.1.9", "linux", "arm64")).toBeUndefined();
  });

  it("picks the Windows installer when the release has one", () => {
    expect(pickAsset(release, "0.1.9", "win32", "x64")?.name).toBe("Jarvis-Setup-0.1.9.exe");
    expect(pickAsset([], "0.1.9", "win32", "x64")).toBeUndefined();
  });

  it("matches the version exactly, with or without a leading v", () => {
    expect(pickAsset(release, "v0.1.9", "darwin", "arm64")?.name).toBe("Jarvis-0.1.9-arm64.dmg");
    expect(pickAsset(release, "0.1.10", "darwin", "arm64")).toBeUndefined();
  });

  it("drops an asset whose URL points anywhere but the project's downloads", () => {
    const foreign = [
      asset("Jarvis-0.1.9-arm64.dmg", "https://evil.example/Jarvis-0.1.9-arm64.dmg"),
    ];
    expect(pickAsset(foreign, "0.1.9", "darwin", "arm64")).toBeUndefined();
    const both = [foreign[0] as ReleaseAsset, asset("Jarvis-0.1.9-arm64.dmg")];
    expect(pickAsset(both, "0.1.9", "darwin", "arm64")?.url).toBe(
      `${DOWNLOAD}Jarvis-0.1.9-arm64.dmg`,
    );
  });

  it("drops an asset whose URL is under another release's tag or name", () => {
    const base = "https://github.com/mmAbdelhay/jarvis/releases/download/";
    for (const url of [
      `${base}v0.1.8/Jarvis-0.1.9-arm64.dmg`,
      `${base}v0.1.9/Jarvis-0.1.8-arm64.dmg`,
      `${base}0.1.9/Jarvis-0.1.9-arm64.dmg`,
      `${base}v0.1.9/sub/Jarvis-0.1.9-arm64.dmg`,
    ]) {
      expect(
        pickAsset([asset("Jarvis-0.1.9-arm64.dmg", url)], "0.1.9", "darwin", "arm64"),
        url,
      ).toBeUndefined();
    }
    expect(pickAsset(release, "v0.1.9", "darwin", "arm64")?.url).toBe(
      `${DOWNLOAD}Jarvis-0.1.9-arm64.dmg`,
    );
  });

  it("accepts any path on the local test origin", () => {
    const local = [
      asset("Jarvis-0.1.9-arm64.dmg", "http://127.0.0.1:4567/files/Jarvis-0.1.9-arm64.dmg"),
    ];
    expect(
      pickAsset(local, "0.1.9", "darwin", "arm64", { testOrigin: "http://127.0.0.1:4567" })?.name,
    ).toBe("Jarvis-0.1.9-arm64.dmg");
  });

  it("accepts a local test origin only when one is given", () => {
    const local = [asset("Jarvis-0.1.9-arm64.dmg", "http://127.0.0.1:4567/Jarvis-0.1.9-arm64.dmg")];
    expect(pickAsset(local, "0.1.9", "darwin", "arm64")).toBeUndefined();
    expect(
      pickAsset(local, "0.1.9", "darwin", "arm64", { testOrigin: "http://127.0.0.1:4567" })?.name,
    ).toBe("Jarvis-0.1.9-arm64.dmg");
  });
});

describe("isAllowedDownloadUrl", () => {
  it("allows the project's release downloads over https", () => {
    expect(isAllowedDownloadUrl(`${DOWNLOAD}Jarvis-0.1.9.AppImage`)).toBe(true);
  });

  it("rejects http, another repo, another host and look-alikes", () => {
    for (const url of [
      `http://github.com/mmAbdelhay/jarvis/releases/download/v0.1.9/x`,
      "https://github.com/someone/jarvis/releases/download/v0.1.9/x",
      "https://github.com/mmAbdelhay/jarvis-fork/releases/download/v0.1.9/x",
      "https://evil.example/mmAbdelhay/jarvis/releases/download/v0.1.9/x",
      "https://github.com.evil.example/mmAbdelhay/jarvis/releases/download/v0.1.9/x",
      "https://github.com:8443/mmAbdelhay/jarvis/releases/download/v0.1.9/x",
      "https://user@github.com/mmAbdelhay/jarvis/releases/download/v0.1.9/x",
      "https://github.com/mmAbdelhay/jarvis/releases/download/../../../evil/x",
      "https://github.com/mmAbdelhay/jarvis/releases/tag/v0.1.9",
      "not a url",
    ]) {
      expect(isAllowedDownloadUrl(url), url).toBe(false);
    }
  });

  it("additionally allows the test origin, and only that origin", () => {
    const opts = { testOrigin: "http://127.0.0.1:4567" };
    expect(isAllowedDownloadUrl("http://127.0.0.1:4567/Jarvis-0.1.9.AppImage", opts)).toBe(true);
    expect(isAllowedDownloadUrl("http://127.0.0.1:4568/Jarvis-0.1.9.AppImage", opts)).toBe(false);
    expect(isAllowedDownloadUrl("http://127.0.0.1:4567/Jarvis-0.1.9.AppImage")).toBe(false);
    expect(isAllowedDownloadUrl(`${DOWNLOAD}x`, opts)).toBe(true);
    expect(isAllowedDownloadUrl("file:///tmp/x", { testOrigin: "file:///tmp" })).toBe(false);
  });
});

describe("isAllowedRedirect", () => {
  it("accepts GitHub's two asset hosts over https and nothing else", () => {
    expect(isAllowedRedirect("https://objects.githubusercontent.com/github-production/x")).toBe(
      true,
    );
    expect(isAllowedRedirect("https://release-assets.githubusercontent.com/x?sig=1")).toBe(true);
    for (const url of [
      "http://objects.githubusercontent.com/x",
      "https://raw.githubusercontent.com/x",
      "https://objects.githubusercontent.com.evil.example/x",
      "https://objects.githubusercontent.com:444/x",
      "https://evil.example/x",
      "not a url",
    ]) {
      expect(isAllowedRedirect(url), url).toBe(false);
    }
  });
});
