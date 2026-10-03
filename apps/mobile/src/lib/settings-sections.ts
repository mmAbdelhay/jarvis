import type { ClientPlatform } from "./client-platform";
import type { Language, MessageKey } from "./i18n";
import { firstChildSide, splitLayout, type SplitLayout } from "./session-nav";

export type SettingsSection = {
  id: string;
  labelKey: MessageKey;
};

const NATIVE_SECTIONS = [
  { id: "general", labelKey: "settings.section.general" },
  { id: "voice", labelKey: "settings.speakReplies" },
  { id: "notifications", labelKey: "settings.notifications" },
  { id: "paired-computer", labelKey: "settings.pairedLaptop" },
  { id: "laptop", labelKey: "laptopSettings.title" },
  { id: "connection", labelKey: "settings.connection" },
  { id: "security", labelKey: "settings.security" },
] as const satisfies readonly SettingsSection[];

const WEB_SECTIONS = [
  ...NATIVE_SECTIONS.slice(0, 2),
  ...NATIVE_SECTIONS.slice(3),
  { id: "keep-signed-in", labelKey: "auth.keepSignedIn" },
  { id: "passkeys", labelKey: "settings.section.addPasskey" },
] as const satisfies readonly SettingsSection[];

const REMOTE_ACCESS = {
  id: "remote-access",
  labelKey: "settings.section.remoteAccess",
} as const satisfies SettingsSection;

/** The sections the screen renders, in order. `passkeysSupported` mirrors
 *  the screen's own `passkeys.isSupported()` gate, so a browser without
 *  WebAuthn gets no rail link to a section that isn't there. */
export function settingsSections(
  platform: ClientPlatform,
  options: { passkeysSupported: boolean } = { passkeysSupported: true },
): SettingsSection[] {
  const sections: SettingsSection[] = platform === "web" ? [...WEB_SECTIONS] : [...NATIVE_SECTIONS];
  return [
    ...sections.filter((section) => options.passkeysSupported || section.id !== "passkeys"),
    REMOTE_ACCESS,
  ];
}

export function settingsWideLayout(input: {
  language: Language;
  platformRtl: boolean;
}): SplitLayout & { railSide: "left" | "right" } {
  const layout = splitLayout(input);
  return { ...layout, railSide: firstChildSide(layout.direction) };
}
