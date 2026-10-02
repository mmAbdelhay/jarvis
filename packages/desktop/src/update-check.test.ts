import { describe, expect, it, vi } from "vitest";
import { checkForUpdate, isNewer, RELEASES_API } from "./update-check.js";

const reply = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }));

describe("isNewer", () => {
  it("compares release versions part by part", () => {
    expect(isNewer("0.1.6", "0.1.5")).toBe(true);
    expect(isNewer("v0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("0.1.5", "0.1.5")).toBe(false);
    expect(isNewer("0.1.4", "0.1.5")).toBe(false);
    expect(isNewer("nonsense", "0.1.5")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  it("asks GitHub's releases API once, and names a newer release with its page", async () => {
    const fetch = reply({
      tag_name: "v0.1.6",
      html_url: "https://github.com/mmAbdelhay/jarvis/releases/tag/v0.1.6",
    });
    expect(await checkForUpdate({ current: "0.1.5", fetch })).toEqual({
      kind: "newer",
      current: "0.1.5",
      latest: "0.1.6",
      url: "https://github.com/mmAbdelhay/jarvis/releases/tag/v0.1.6",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(RELEASES_API, expect.anything());
  });

  it("says current when the latest release is this one", async () => {
    const fetch = reply({
      tag_name: "v0.1.5",
      html_url: "https://github.com/mmAbdelhay/jarvis/releases/tag/v0.1.5",
    });
    expect(await checkForUpdate({ current: "0.1.5", fetch })).toEqual({
      kind: "current",
      current: "0.1.5",
    });
  });

  it("fails rather than offering a link anywhere but the project's release pages", async () => {
    const elsewhere = reply({ tag_name: "v9.0.0", html_url: "https://evil.example/releases/x" });
    expect((await checkForUpdate({ current: "0.1.5", fetch: elsewhere })).kind).toBe("failed");
    expect((await checkForUpdate({ current: "0.1.5", fetch: reply({}, false) })).kind).toBe(
      "failed",
    );
    const offline = vi.fn(async () => {
      throw new Error("offline");
    });
    expect((await checkForUpdate({ current: "0.1.5", fetch: offline })).kind).toBe("failed");
  });
});
