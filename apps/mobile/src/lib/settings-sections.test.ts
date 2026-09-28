import { describe, expect, it } from "vitest";
import { settingsSections, settingsWideLayout } from "./settings-sections";

const nativeSections = [
  { id: "general", labelKey: "settings.section.general" },
  { id: "voice", labelKey: "settings.speakReplies" },
  { id: "notifications", labelKey: "settings.notifications" },
  { id: "paired-computer", labelKey: "settings.pairedLaptop" },
  { id: "connection", labelKey: "settings.connection" },
  { id: "security", labelKey: "settings.security" },
  { id: "remote-access", labelKey: "settings.section.remoteAccess" },
] as const;

const webSections = [
  ...nativeSections.slice(0, 2),
  ...nativeSections.slice(3, -1),
  { id: "keep-signed-in", labelKey: "auth.keepSignedIn" },
  { id: "passkeys", labelKey: "settings.section.addPasskey" },
  nativeSections.at(-1),
] as const;

describe("settingsSections", () => {
  it("keeps native settings in their screen order", () => {
    expect(settingsSections("native")).toEqual(nativeSections);
  });

  it("adds browser-only account sections in their screen order on web", () => {
    expect(settingsSections("web")).toEqual(webSections);
  });

  it("includes Add a passkey only on web", () => {
    expect(settingsSections("web").map(({ id }) => id)).toContain("passkeys");
    expect(settingsSections("native").map(({ id }) => id)).not.toContain("passkeys");
  });

  it("drops Add a passkey on web when the browser has no WebAuthn, so the rail matches the page", () => {
    const ids = settingsSections("web", { passkeysSupported: false }).map(({ id }) => id);
    expect(ids).not.toContain("passkeys");
    expect(ids).toContain("keep-signed-in");
  });

  it.each(["native", "web"] as const)("uses unique anchor ids on %s", (platform) => {
    const ids = settingsSections(platform).map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("settingsWideLayout", () => {
  it.each([
    { environment: "Arabic native forced RTL", language: "ar", platformRtl: true, side: "right" },
    { environment: "Arabic web", language: "ar", platformRtl: false, side: "right" },
    { environment: "English native", language: "en", platformRtl: false, side: "left" },
    { environment: "English web", language: "en", platformRtl: false, side: "left" },
  ] as const)(
    "puts the section rail on reading-start for $environment",
    ({ language, platformRtl, side }) => {
      expect(settingsWideLayout({ language, platformRtl }).railSide).toBe(side);
    },
  );
});
