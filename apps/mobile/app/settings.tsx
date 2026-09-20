import Constants from "expo-constants";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { connectFromStoredPairing } from "@/lib/connect-stored";
import { realClock } from "@/lib/clock";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { clearPairing, loadPairing } from "@/lib/pairing-record";
import { filePrefsStore } from "@/lib/prefs-file";
import { usePushRegistration } from "@/lib/push-context";
import { notificationsStatusKey, notificationsSwitchValue } from "@/lib/push-screen";
import { useConnectionStore, useRpcClient } from "@/lib/rpc-context";
import { expoSecureStore } from "@/lib/secure-store";
import type { SettingsView } from "@/lib/settings-store";
import { connectionStateKey, createSettingsStore } from "@/lib/settings-store";
import { theme } from "@/lib/theme";
import { textDirection } from "@/lib/voice-screen";
import { useVoiceController } from "@/lib/voice-context";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const APP_VERSION = Constants.expoConfig?.version ?? "0.0.0";
// Wraps the fingerprint tail's Latin hex characters so they don't reorder
// under Arabic bidi — U+2066 LEFT-TO-RIGHT ISOLATE and U+2069 POP
// DIRECTIONAL ISOLATE, written as `\u` escapes (not the raw invisible
// characters) so they survive an edit or a formatter pass intact.
const LRI = "\u2066";
const PDI = "\u2069";

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const language = useLanguage();
  const router = useRouter();
  const client = useRpcClient();
  const connection = useConnectionStore();
  const voiceController = useVoiceController();
  const push = usePushRegistration();

  const store = useMemo(
    () =>
      createSettingsStore({
        prefs: filePrefsStore,
        localeTag: Intl.DateTimeFormat().resolvedOptions().locale,
        loadRecord: async () => (await loadPairing(expoSecureStore))?.record,
        // The same shared read+connect function `_layout.tsx` uses on
        // entry — one `loadPairing` path in the app.
        connectFromStored: (shouldConnect) =>
          connectFromStoredPairing({ secureStore: expoSecureStore, client, shouldConnect }),
        connection,
        client,
        clock: realClock,
        appVersion: APP_VERSION,
        unpair: async () => {
          await clearPairing(expoSecureStore);
        },
        navigateToPair: () => {
          router.replace("/pair");
        },
        log: console.log,
        // M10 Task 6, rule 10 of settings-store.ts: this store only relays
        // `push`'s own view and forwards `setNotifications` to it — the
        // one `PushRegistration` `PushProvider` built for the whole app
        // (push-context.tsx), never a second instance built here.
        push,
      }),
    [client, connection, router, push],
  );

  const [view, setView] = useState<SettingsView>(store.get());

  useFocusEffect(
    useCallback(() => {
      setView(store.get());
      return store.subscribe(setView);
    }, [store]),
  );

  function handleUnpair(): void {
    Alert.alert(t(language, "settings.unpair"), t(language, "settings.unpairConfirm"), [
      { text: t(language, "common.cancel"), style: "cancel" },
      {
        text: t(language, "common.ok"),
        style: "destructive",
        onPress: () => {
          void store.unpair();
        },
      },
    ]);
  }

  // M10 Task 6, rule 3: the "error" phase's status line shows the
  // laptop's own bilingual text verbatim, in its own direction, when
  // present — same discipline as voice.tsx's server-text notice — and
  // falls back to the plain i18n key text (or nothing) otherwise.
  const notificationsKey = notificationsStatusKey(view.notifications);
  const notificationsServerText =
    view.notifications.phase === "error" ? view.notifications.serverText : undefined;
  const notificationsText =
    notificationsServerText !== undefined
      ? notificationsServerText
      : notificationsKey !== undefined
        ? t(language, notificationsKey)
        : undefined;
  const notificationsWritingDirection =
    notificationsServerText !== undefined && view.notifications.language !== undefined
      ? textDirection(view.notifications.language)
      : undefined;

  const laptop = view.laptop;
  const lastFrameSeconds =
    view.lastFrameAgoMs === undefined
      ? undefined
      : Math.max(0, Math.round(view.lastFrameAgoMs / 1000));
  // M3: the paired-at date is formatted in the app's own chosen language,
  // not whatever the device's ambient locale happens to be.
  const pairedAtDate =
    laptop === undefined
      ? undefined
      : new Date(laptop.pairedAt).toLocaleDateString(language === "ar" ? "ar" : "en-US", {
          dateStyle: "medium",
        });

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 8 }]}
    >
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.back}
          onPress={() => router.back()}
          accessibilityLabel={t(language, "common.back")}
        >
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{t(language, "settings.title")}</Text>
      </View>

      <Text style={styles.sectionTitle}>{t(language, "settings.language")}</Text>
      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.langButton, view.language === "en" && styles.langButtonActive]}
          onPress={() => void store.setLanguage("en")}
        >
          <Text style={styles.langButtonText}>{t(language, "settings.language.en")}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.langButton, view.language === "ar" && styles.langButtonActive]}
          onPress={() => void store.setLanguage("ar")}
        >
          <Text style={styles.langButtonText}>{t(language, "settings.language.ar")}</Text>
        </TouchableOpacity>
      </View>
      {view.restartRequired && view.language !== undefined && (
        <Text style={styles.notice}>
          {t(language, "settings.restartToApply", {
            app: t(language, "app.title"),
            language: t(
              language,
              view.language === "ar" ? "settings.language.ar" : "settings.language.en",
            ),
          })}
        </Text>
      )}

      <Text style={styles.sectionTitle}>{t(language, "settings.speakReplies")}</Text>
      <View style={styles.switchRow}>
        <Text style={styles.switchHint}>{t(language, "settings.speakRepliesHint")}</Text>
        <Switch
          value={view.speakReplies}
          accessibilityLabel={t(language, "settings.speakReplies")}
          onValueChange={(on) => {
            // Prefs first, controller only once the write actually lands —
            // `store.setSpeakReplies` leaves its own view unchanged on a
            // rejected write, and since the switch is bound to that view
            // (not local state), a failed write reverts the switch on its
            // own without the controller ever having heard about the
            // change (fix round 1, Minor 1).
            void store
              .setSpeakReplies(on)
              .then(() => {
                voiceController.setSpeakReplies(on);
              })
              // M6: a rejected write already leaves the store's view (and
              // so the switch, bound to it) unchanged on its own — this
              // only keeps that rejection from surfacing as an unhandled
              // promise rejection (a RN LogBox warning in dev).
              .catch(() => {});
          }}
        />
      </View>

      <Text style={styles.sectionTitle}>{t(language, "settings.notifications")}</Text>
      <View style={styles.switchRow}>
        <Text style={styles.switchHint}>{t(language, "settings.notificationsHint")}</Text>
        <Switch
          value={notificationsSwitchValue(view.notifications)}
          accessibilityLabel={t(language, "settings.notifications")}
          onValueChange={(on) => void store.setNotifications(on)}
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
      {view.notifications.phase === "blocked" && (
        <TouchableOpacity style={styles.button} onPress={() => void Linking.openSettings()}>
          <Text style={styles.buttonText}>
            {t(language, "settings.notifications.openSettings")}
          </Text>
        </TouchableOpacity>
      )}

      <Text style={styles.sectionTitle}>{t(language, "settings.pairedLaptop")}</Text>
      {laptop === undefined ? (
        <Text style={styles.empty}>{t(language, "settings.notPaired")}</Text>
      ) : (
        <View style={styles.card}>
          <Text style={styles.cardLine}>
            {t(language, "settings.address", { value: `${laptop.host}:${laptop.port}` })}
          </Text>
          {view.fingerprintTail !== undefined && (
            <Text style={styles.cardLine}>
              {t(language, "settings.fingerprintTail", {
                tail: `${LRI}${view.fingerprintTail}${PDI}`,
              })}
            </Text>
          )}
          <Text style={styles.cardLine}>
            {t(language, "settings.deviceId", { value: laptop.deviceId })}
          </Text>
          {pairedAtDate !== undefined && (
            <Text style={styles.cardLine}>
              {t(language, "settings.pairedAt", { date: pairedAtDate })}
            </Text>
          )}
        </View>
      )}

      <Text style={styles.sectionTitle}>{t(language, "settings.connection")}</Text>
      <View style={styles.card}>
        <Text style={styles.cardLine}>{t(language, connectionStateKey(view.connection))}</Text>
        {lastFrameSeconds !== undefined && (
          <Text style={styles.cardLine}>
            {t(language, "settings.lastFrame", { seconds: lastFrameSeconds })}
          </Text>
        )}
        <TouchableOpacity style={styles.button} onPress={() => store.reconnect()}>
          <Text style={styles.buttonText}>{t(language, "settings.reconnect")}</Text>
        </TouchableOpacity>
        {view.reconnectError && (
          <Text style={styles.errorText}>{t(language, "settings.reconnectFailed")}</Text>
        )}
      </View>

      <TouchableOpacity style={styles.dangerButton} onPress={handleUnpair}>
        <Text style={styles.dangerButtonText}>{t(language, "settings.unpair")}</Text>
      </TouchableOpacity>
      {view.unpairError && (
        <Text style={styles.errorText}>{t(language, "settings.unpairFailed")}</Text>
      )}

      <Text style={styles.version}>
        {t(language, "settings.appVersion", { version: view.appVersion })}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 34,
    gap: 8,
  },
  header: { flexDirection: "row", alignItems: "center", marginStart: -8, marginBottom: 4 },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  backText: { color: theme.colors.textSecondary, fontSize: 34, lineHeight: 36 },
  title: {
    color: theme.colors.text,
    fontSize: 22,
    fontFamily: theme.font.bold,
  },
  sectionTitle: {
    color: theme.colors.textDim,
    fontSize: 12,
    fontFamily: theme.font.bold,
    letterSpacing: 1.2,
    marginTop: 10,
  },
  row: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  langButton: {
    flex: 1,
    borderColor: theme.colors.border,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    borderRadius: 9,
    alignItems: "center",
  },
  langButtonActive: {
    backgroundColor: theme.colors.selected,
    borderColor: theme.colors.selected,
  },
  langButtonText: {
    color: theme.colors.text,
    fontFamily: theme.font.bold,
    fontSize: 14,
  },
  notice: {
    color: theme.colors.warning,
    fontSize: theme.font.size.sm,
  },
  empty: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.sm,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  switchHint: {
    flex: 1,
    color: theme.colors.textMuted,
    fontSize: theme.font.size.sm,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderWidth: 1,
    borderRadius: theme.radius.card,
    padding: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  cardLine: {
    color: theme.colors.textDim,
    fontFamily: theme.font.mono,
    fontSize: 11,
  },
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
