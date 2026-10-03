import { useMemo } from "react";
import { LaptopSettingsSection } from "./LaptopSettingsSection";
import { Linking, Platform, StyleSheet, Switch, Text, TouchableOpacity, View } from "react-native";
import { PasskeyRegisterForm } from "@/components/PasskeyRegisterForm";
import { SETTINGS_CARD, SETTINGS_CARD_TITLE } from "@/components/SettingsCard";
import type { ClientPlatform } from "@/lib/client-platform";
import { platformKey, t, type Language } from "@/lib/i18n";
import { passkeys } from "@/lib/passkey";
import { IDLE_LOCK_MINUTES } from "@/lib/prefs";
import {
  notificationsStatusKey,
  notificationsSwitchValue,
  showsNotificationsSetting,
} from "@/lib/push-screen";
import { type SettingsScope, sectionScope } from "@/lib/settings-sections";
import { connectionStateKey, type SettingsStore, type SettingsView } from "@/lib/settings-store";
import { theme } from "@/lib/theme";
import { textDirection } from "@/lib/voice-screen";

// Wraps the fingerprint tail's Latin hex characters so they don't reorder
// under Arabic bidi — U+2066 LEFT-TO-RIGHT ISOLATE and U+2069 POP
// DIRECTIONAL ISOLATE, written as `\u` escapes (not the raw invisible
// characters) so they survive an edit or a formatter pass intact.
const LRI = "\u2066";
const PDI = "\u2069";

type Props = {
  language: Language;
  platform: ClientPlatform;
  view: SettingsView;
  store: SettingsStore;
  wide: boolean;
  /** Wide layout: only one scope's sections, drawn as cards. */
  scope?: SettingsScope;
  onSpeakReplies(on: boolean): void;
  onValueChange(on: boolean): void;
  onLogout(): void;
  onUnpair(): void;
};

export function SettingsSections(props: Props): React.JSX.Element {
  // M10 Task 6, rule 3: the "error" phase's status line shows the
  // laptop's own bilingual text verbatim, in its own direction, when
  // present — same discipline as voice.tsx's server-text notice — and
  // falls back to the plain i18n key text (or nothing) otherwise.
  const notificationsKey = notificationsStatusKey(props.view.notifications);
  const notificationsServerText =
    props.view.notifications.phase === "error" ? props.view.notifications.serverText : undefined;
  const notificationsText =
    notificationsServerText !== undefined
      ? notificationsServerText
      : notificationsKey !== undefined
        ? t(props.language, notificationsKey)
        : undefined;
  const notificationsWritingDirection =
    notificationsServerText !== undefined && props.view.notifications.language !== undefined
      ? textDirection(props.view.notifications.language)
      : undefined;
  const lastFrameSeconds =
    props.view.lastFrameAgoMs === undefined
      ? undefined
      : Math.max(0, Math.round(props.view.lastFrameAgoMs / 1000));
  // M3: the paired-at date is formatted in the app's own chosen language,
  // not whatever the device's ambient locale happens to be.
  const pairedAtDate = useMemo(
    () =>
      props.view.laptop === undefined
        ? undefined
        : new Date(props.view.laptop.pairedAt).toLocaleDateString(
            props.language === "ar" ? "ar" : "en-US",
            { dateStyle: "medium" },
          ),
    [props.language, props.view.laptop],
  );
  const wide = props.wide;
  const shown = (id: string) => props.scope === undefined || sectionScope(id) === props.scope;
  const section = (id: string) => ({
    nativeID: id,
    style: wide ? [styles.section, SETTINGS_CARD] : styles.section,
  });
  const sectionTitle = wide ? SETTINGS_CARD_TITLE : styles.sectionTitle;

  return (
    <View style={[styles.sections, wide && styles.sectionsWide]}>
      {shown("general") && (
        <View {...section("general")}>
          <Text style={sectionTitle}>{t(props.language, "settings.language")}</Text>
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.langButton, props.view.language === "en" && styles.langButtonActive]}
              onPress={() => void props.store.setLanguage("en")}
            >
              <Text style={styles.langButtonText}>{t(props.language, "settings.language.en")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.langButton, props.view.language === "ar" && styles.langButtonActive]}
              onPress={() => void props.store.setLanguage("ar")}
            >
              <Text style={styles.langButtonText}>{t(props.language, "settings.language.ar")}</Text>
            </TouchableOpacity>
          </View>
          {props.view.restartRequired && props.view.language !== undefined && (
            <Text style={styles.notice}>
              {t(props.language, "settings.restartToApply", {
                app: t(props.language, "app.title"),
                language: t(
                  props.language,
                  props.view.language === "ar" ? "settings.language.ar" : "settings.language.en",
                ),
              })}
            </Text>
          )}
        </View>
      )}

      {shown("voice") && (
        <View {...section("voice")}>
          <Text style={sectionTitle}>{t(props.language, "settings.speakReplies")}</Text>
          <View style={styles.switchRow}>
            <Text style={styles.switchHint}>
              {t(props.language, platformKey("settings.speakRepliesHint", props.platform))}
            </Text>
            <Switch
              value={props.view.speakReplies}
              accessibilityLabel={t(props.language, "settings.speakReplies")}
              onValueChange={props.onSpeakReplies}
            />
          </View>
        </View>
      )}

      {showsNotificationsSetting(props.platform) && shown("notifications") && (
        <View {...section("notifications")}>
          <Text style={sectionTitle}>{t(props.language, "settings.notifications")}</Text>
          <View style={styles.switchRow}>
            <Text style={styles.switchHint}>{t(props.language, "settings.notificationsHint")}</Text>
            <Switch
              value={notificationsSwitchValue(props.view.notifications)}
              accessibilityLabel={t(props.language, "settings.notifications")}
              onValueChange={props.onValueChange}
            />
          </View>
          {notificationsText !== undefined && (
            <Text
              style={[
                styles.cardLine,
                notificationsWritingDirection !== undefined && {
                  writingDirection: notificationsWritingDirection,
                },
              ]}
            >
              {notificationsText}
            </Text>
          )}
          {props.view.notifications.phase === "blocked" && (
            <TouchableOpacity style={styles.button} onPress={() => void Linking.openSettings()}>
              <Text style={styles.buttonText}>
                {t(props.language, "settings.notifications.openSettings")}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {shown("paired-computer") && (
        <View {...section("paired-computer")}>
          <Text style={sectionTitle}>{t(props.language, "settings.pairedLaptop")}</Text>
          {props.view.laptop === undefined ? (
            <Text style={styles.empty}>{t(props.language, "settings.notPaired")}</Text>
          ) : (
            <View style={styles.card}>
              <Text style={styles.cardLine}>
                {t(props.language, "settings.address", {
                  value: `${props.view.laptop.host}:${props.view.laptop.port}`,
                })}
              </Text>
              {props.view.fingerprintTail !== undefined && (
                <Text style={styles.cardLine}>
                  {t(props.language, "settings.fingerprintTail", {
                    tail: `${LRI}${props.view.fingerprintTail}${PDI}`,
                  })}
                </Text>
              )}
              <Text style={styles.cardLine}>
                {t(props.language, "settings.deviceId", { value: props.view.laptop.deviceId })}
              </Text>
              {pairedAtDate !== undefined && (
                <Text style={styles.cardLine}>
                  {t(props.language, "settings.pairedAt", { date: pairedAtDate })}
                </Text>
              )}
            </View>
          )}
        </View>
      )}

      {shown("laptop") &&
        (wide ? (
          <LaptopSettingsSection language={props.language} variant="cards" />
        ) : (
          <View {...section("laptop")}>
            <Text style={sectionTitle}>{t(props.language, "laptopSettings.title")}</Text>
            <LaptopSettingsSection language={props.language} variant="list" />
          </View>
        ))}

      {shown("connection") && (
        <View {...section("connection")}>
          <Text style={sectionTitle}>{t(props.language, "settings.connection")}</Text>
          <View style={styles.card}>
            <Text style={styles.cardLine}>
              {t(
                props.language,
                platformKey(connectionStateKey(props.view.connection), props.platform),
              )}
            </Text>
            {lastFrameSeconds !== undefined && (
              <Text style={styles.cardLine}>
                {t(props.language, "settings.lastFrame", { seconds: lastFrameSeconds })}
              </Text>
            )}
            <TouchableOpacity style={styles.button} onPress={() => props.store.reconnect()}>
              <Text style={styles.buttonText}>{t(props.language, "settings.reconnect")}</Text>
            </TouchableOpacity>
            {props.view.reconnectError && (
              <Text style={styles.errorText}>{t(props.language, "settings.reconnectFailed")}</Text>
            )}
          </View>
        </View>
      )}

      {shown("security") && (
        <View {...section("security")}>
          <Text style={sectionTitle}>{t(props.language, "settings.security")}</Text>
          <Text style={styles.switchHint}>{t(props.language, "settings.idleLock")}</Text>
          <View style={styles.row}>
            {IDLE_LOCK_MINUTES.map((minutes) => (
              <TouchableOpacity
                key={minutes}
                style={[
                  styles.langButton,
                  props.view.idleLockMinutes === minutes && styles.langButtonActive,
                ]}
                onPress={() => void props.store.setIdleLockMinutes(minutes).catch(() => {})}
              >
                <Text style={styles.langButtonText}>
                  {t(props.language, "settings.idleLock.minutes", { minutes })}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      {Platform.OS === "web" && shown("keep-signed-in") && (
        <>
          <View {...section("keep-signed-in")}>
            <Text style={wide ? sectionTitle : styles.cardLine}>
              {t(props.language, "auth.keepSignedIn")}
            </Text>
            <View style={styles.switchRow}>
              <Text style={styles.switchHint}>{t(props.language, "auth.keepSignedInHint")}</Text>
              <Switch
                value={props.view.keepSignedIn}
                accessibilityLabel={t(props.language, "auth.keepSignedIn")}
                // Bound to the store's view: a failed write leaves it as it was.
                onValueChange={(on) => void props.store.setKeepSignedIn(on).catch(() => {})}
              />
            </View>
          </View>
          {passkeys.isSupported() && (
            <View {...section("passkeys")}>
              <Text style={sectionTitle}>{t(props.language, "settings.passkeys")}</Text>
              <Text style={styles.switchHint}>{t(props.language, "settings.passkeysHint")}</Text>
              <PasskeyRegisterForm />
            </View>
          )}
        </>
      )}

      {shown("remote-access") && (
        <View {...section("remote-access")}>
          {props.wide && (
            <Text style={sectionTitle}>{t(props.language, "settings.section.remoteAccess")}</Text>
          )}
          <TouchableOpacity style={styles.dangerButton} onPress={props.onLogout}>
            <Text style={styles.dangerButtonText}>{t(props.language, "settings.logout")}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.dangerButton} onPress={props.onUnpair}>
            <Text style={styles.dangerButtonText}>
              {t(props.language, platformKey("settings.unpair", props.platform))}
            </Text>
          </TouchableOpacity>
          {props.view.unpairError && (
            <Text style={styles.errorText}>
              {t(props.language, platformKey("settings.unpairFailed", props.platform))}
            </Text>
          )}
          <Text style={styles.version}>
            {t(props.language, "settings.appVersion", { version: props.view.appVersion })}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionNav: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: 18,
    gap: 2,
  },
  navTitle: {
    color: theme.colors.text,
    fontFamily: theme.font.bold,
    fontSize: 15,
    paddingHorizontal: 10,
    paddingBottom: 10,
  },
  navLink: { minHeight: 36, justifyContent: "center", paddingHorizontal: 10, borderRadius: 8 },
  navLinkText: {
    color: theme.colors.textSecondary,
    fontFamily: theme.font.semibold,
    fontSize: 13,
  },
  sections: { flex: 1, gap: 8 },
  sectionsWide: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 20 },
  section: { gap: 8 },
  sectionTitle: {
    color: theme.colors.textDim,
    fontSize: 12,
    fontFamily: theme.font.bold,
    letterSpacing: 1.2,
    marginTop: 10,
  },
  row: { flexDirection: "row", gap: theme.spacing.sm },
  langButton: {
    flex: 1,
    borderColor: theme.colors.border,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    borderRadius: 9,
    alignItems: "center",
  },
  langButtonActive: { backgroundColor: theme.colors.selected, borderColor: theme.colors.selected },
  langButtonText: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 14 },
  notice: { color: theme.colors.warning, fontSize: theme.font.size.sm },
  empty: { color: theme.colors.textMuted, fontSize: theme.font.size.sm },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  switchHint: { flex: 1, color: theme.colors.textMuted, fontSize: theme.font.size.sm },
  card: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderWidth: 1,
    borderRadius: theme.radius.card,
    padding: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  cardLine: { color: theme.colors.textDim, fontFamily: theme.font.mono, fontSize: 11 },
  button: {
    backgroundColor: theme.colors.primary,
    minHeight: 44,
    borderRadius: theme.radius.small,
    paddingHorizontal: 12,
    justifyContent: "center",
    alignItems: "center",
    marginTop: theme.spacing.xs,
  },
  buttonText: {
    color: theme.colors.primaryText,
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.medium,
  },
  dangerButton: {
    borderColor: theme.colors.danger,
    borderWidth: 1,
    minHeight: 48,
    borderRadius: theme.radius.card,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: theme.spacing.md,
  },
  dangerButtonText: {
    color: theme.colors.danger,
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.medium,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: theme.font.size.sm,
    textAlign: "center",
    marginTop: theme.spacing.xs,
  },
  version: {
    color: theme.colors.textFaint,
    fontFamily: theme.font.mono,
    fontSize: 11,
    textAlign: "center",
    marginTop: theme.spacing.lg,
  },
});
