import type { ClientPlatform } from "./client-platform";
import type { MessageKey } from "./i18n";

export type SettingsSection = {
  id: string;
  labelKey: MessageKey;
};

const NATIVE_SECTIONS = [
  { id: "general", labelKey: "settings.section.general" },
  { id: "voice", labelKey: "settings.speakReplies" },
  { id: "notifications", labelKey: "settings.notifications" },
  { id: "paired-computer", labelKey: "settings.pairedLaptop" },
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

export function settingsSections(platform: ClientPlatform): SettingsSection[] {
  return [...(platform === "web" ? WEB_SECTIONS : NATIVE_SECTIONS), REMOTE_ACCESS];
}
