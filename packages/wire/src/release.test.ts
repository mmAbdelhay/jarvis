import { describe, expect, it } from "vitest";
import { isNewer, isReleaseDownloadUrl, parseReleaseList, parseSums } from "./index.js";

const base = "https://github.com/mmAbdelhay/jarvis/releases/";
const asset = (version: string, name: string) => ({
  name,
  browser_download_url: `${base}download/v${version}/${name}`,
  size: 123,
});
const release = (version: string) => ({
  tag_name: `v${version}`,
  html_url: `${base}tag/v${version}`,
  body: "Release notes",
  draft: false,
  prerelease: false,
  assets: [asset(version, `jarvis-mobile-${version}.apk`), asset(version, "SHA256SUMS")],
});

describe("shared release helpers", () => {
  it("compares numeric versions using the desktop rule", () => {
    expect(isNewer("v0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("0.1.9-beta.2", "0.1.9")).toBe(false);
    expect(isNewer("invalid", "0.1.9")).toBe(false);
  });

  it("parses checksums and drops conflicting names", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(
      parseSums(`${a.toUpperCase()} *good\r\ninvalid\n${a}  bad\n${b}  bad\n${a}  bad`),
    ).toEqual(new Map([["good", a]]));
  });

  it("accepts only this release's download URL", () => {
    const url = `${base}download/v0.1.9/SHA256SUMS`;
    expect(isReleaseDownloadUrl(url, "0.1.9", "SHA256SUMS")).toBe(true);
    for (const bad of [
      url.replace("v0.1.9", "v0.1.8"),
      url.replace("https:", "http:"),
      url.replace("github.com", "github.com.evil.example"),
      url.replace("github.com", "user@github.com"),
      url.replace("github.com", "github.com:8443"),
      url.replace("SHA256SUMS", "other"),
      "not a URL",
    ]) {
      expect(isReleaseDownloadUrl(bad, "0.1.9", "SHA256SUMS"), bad).toBe(false);
    }
  });
});

describe("parseReleaseList", () => {
  it("selects the newest eligible release and returns trusted assets", () => {
    const chosen = release("0.1.10");
    expect(parseReleaseList([release("0.1.9"), chosen], "0.1.8")).toEqual({
      kind: "newer",
      version: "0.1.10",
      notes: "Release notes",
      pageUrl: chosen.html_url,
      apk: { name: chosen.assets[0]?.name, url: chosen.assets[0]?.browser_download_url, size: 123 },
      sums: { name: "SHA256SUMS", url: chosen.assets[1]?.browser_download_url, size: 123 },
    });
  });

  it("skips a newer release without an APK or without SUMS", () => {
    for (const assets of [
      [asset("0.1.11", "SHA256SUMS")],
      [asset("0.1.11", "jarvis-mobile-0.1.11.apk")],
    ]) {
      expect(
        parseReleaseList([{ ...release("0.1.11"), assets }, release("0.1.10")], "0.1.9"),
      ).toMatchObject({ kind: "newer", version: "0.1.10" });
    }
  });

  it("skips draft and prerelease entries", () => {
    expect(
      parseReleaseList(
        [
          { ...release("0.1.12"), draft: true },
          { ...release("0.1.11"), prerelease: true },
          release("0.1.10"),
        ],
        "0.1.9",
      ),
    ).toMatchObject({ kind: "newer", version: "0.1.10" });
  });

  it("refuses assets pointing at another tag, for either required file", () => {
    for (const index of [0, 1]) {
      const wrong = release("0.1.11");
      const entry = wrong.assets[index];
      if (entry)
        entry.browser_download_url = entry.browser_download_url.replace("v0.1.11", "v0.1.8");
      expect(parseReleaseList([wrong], "0.1.9")).toEqual({ kind: "current" });
    }
  });

  it("returns current for equal, older or absent eligible releases", () => {
    for (const raw of [[release("0.1.9")], [release("0.1.8")], []]) {
      expect(parseReleaseList(raw, "0.1.9")).toEqual({ kind: "current" });
    }
  });

  it("fails for a non-array response", () => {
    for (const raw of [null, undefined, {}, "releases"]) {
      expect(parseReleaseList(raw, "0.1.9")).toEqual({ kind: "failed" });
    }
  });

  it("skips malformed entries, unsafe pages and invalid asset sizes", () => {
    for (const bad of [
      null,
      "release",
      {},
      { ...release("0.1.10"), html_url: "https://evil.example/" },
      { ...release("0.1.10"), assets: null },
      {
        ...release("0.1.10"),
        assets: [
          asset("0.1.10", "SHA256SUMS"),
          { ...asset("0.1.10", "jarvis-mobile-0.1.10.apk"), size: -1 },
        ],
      },
    ]) {
      expect(parseReleaseList([bad], "0.1.9")).toEqual({ kind: "current" });
    }
  });

  it("cuts notes at 4000 characters and defaults missing notes to empty", () => {
    expect(
      parseReleaseList([{ ...release("0.1.10"), body: "x".repeat(5000) }], "0.1.9"),
    ).toMatchObject({ notes: "x".repeat(4000) });
    expect(parseReleaseList([{ ...release("0.1.10"), body: null }], "0.1.9")).toMatchObject({
      notes: "",
    });
  });
});
