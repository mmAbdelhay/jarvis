import Constants from "expo-constants";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  I18nManager,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WideShell } from "@/components/WideShell";
import { realClock } from "@/lib/clock";
import { clientPlatformFor } from "@/lib/client-platform";
import { connectFromStoredPairing } from "@/lib/connect-stored";
import { dialogs } from "@/lib/dialog";
import { platformKey, t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { clearPairing, loadPairing } from "@/lib/pairing-record";
import { filePrefsStore } from "@/lib/prefs-file";
import { usePushRegistration } from "@/lib/push-context";
import { useAuthSession, useConnectionStore, useRpcClient } from "@/lib/rpc-context";
import { expoSecureStore } from "@/lib/secure-store";
import { SETTINGS_SCOPES, type SettingsScope, settingsWideLayout } from "@/lib/settings-sections";
import { createSettingsStore, type SettingsView } from "@/lib/settings-store";
import { theme } from "@/lib/theme";
import { useLayoutClass } from "@/lib/use-layout-class";
import { useVoiceController } from "@/lib/voice-context";
import { SegmentTabs } from "@/components/SegmentTabs";
import { SettingsSections } from "@/screens/SettingsSections";

const APP_VERSION = Constants.expoConfig?.version ?? "0.0.0";
const PLATFORM = clientPlatformFor(Platform.OS);

// Wide layout: Settings is a root stack screen, so it draws the WideShell
// itself to open inside the shell (on a phone the shell adds nothing).
export default function SettingsRoute() {
  return (
    <WideShell>
      <SettingsScreen />
    </WideShell>
  );
}

function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const layout = useLayoutClass();
  const language = useLanguage();
  const router = useRouter();
  const client = useRpcClient();
  const connection = useConnectionStore();
  const voiceController = useVoiceController();
  const push = usePushRegistration();
  const authSession = useAuthSession();
  const [scope, setScope] = useState<SettingsScope>("browser");
  const wide = layout.kind === "wide";
  const wideLayout = settingsWideLayout({
    language,
    platformRtl: I18nManager.getConstants().isRTL,
  });

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
          // The stored refresh token belongs to the pairing it was issued under.
          await authSession.forget();
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
        auth: authSession,
      }),
    [client, connection, router, push, authSession],
  );

  const [view, setView] = useState<SettingsView>(store.get());
  useFocusEffect(
    useCallback(() => {
      setView(store.get());
      return store.subscribe(setView);
    }, [store]),
  );

  function handleUnpair(): void {
    dialogs.confirm({
      title: t(language, platformKey("settings.unpair", PLATFORM)),
      message: t(language, platformKey("settings.unpairConfirm", PLATFORM)),
      cancelText: t(language, "common.cancel"),
      confirmText: t(language, "common.ok"),
      destructive: true,
      onConfirm: () => {
        void store.unpair();
      },
    });
  }

  function handleLogout(): void {
    dialogs.confirm({
      title: t(language, "settings.logout"),
      message: t(language, platformKey("settings.logoutConfirm", PLATFORM)),
      cancelText: t(language, "common.cancel"),
      confirmText: t(language, "common.ok"),
      destructive: true,
      onConfirm: () => {
        void store.logout();
      },
    });
  }

  const content = (
    <SettingsSections
      language={language}
      platform={PLATFORM}
      view={view}
      store={store}
      wide={wide}
      scope={wide ? scope : undefined}
      onSpeakReplies={(on) => {
        // Prefs first, controller only once the write actually lands —
        // `store.setSpeakReplies` leaves its own view unchanged on a
        // rejected write, and since the switch is bound to that view
        // (not local state), a failed write reverts the switch on its
        // own without the controller ever having heard about the
        // change (fix round 1, Minor 1).
        void store
          .setSpeakReplies(on)
          .then(() => voiceController.setSpeakReplies(on))
          // M6: a rejected write already leaves the store's view (and
          // so the switch, bound to it) unchanged on its own — this
          // only keeps that rejection from surfacing as an unhandled
          // promise rejection (a RN LogBox warning in dev).
          .catch(() => {});
      }}
      onValueChange={(on) => void store.setNotifications(on)}
      onLogout={handleLogout}
      onUnpair={handleUnpair}
    />
  );

  if (wide) {
    return (
      <ScrollView
        style={[styles.container, { direction: wideLayout.direction }]}
        contentContainerStyle={styles.wideContent}
      >
        <Text style={styles.wideTitle} accessibilityRole="header">
          {t(language, "settings.title")}
        </Text>
        <SegmentTabs
          variant="inline"
          label={t(language, "settings.scopeTabs")}
          tabs={SETTINGS_SCOPES.map((key) => ({
            key,
            label: t(
              language,
              key === "browser"
                ? platformKey("settings.thisDevice", PLATFORM)
                : "settings.theLaptop",
            ),
            selected: scope === key,
            onPress: () => setScope(key),
          }))}
        />
        {content}
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.phoneContent, { paddingTop: insets.top + 8 }]}
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
      {content}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  wideContent: { paddingHorizontal: 32, paddingVertical: 28, paddingBottom: 40, gap: 20 },
  wideTitle: { color: theme.colors.text, fontSize: 26, fontFamily: theme.font.extrabold },
  phoneContent: { paddingHorizontal: 20, paddingBottom: 34, gap: 8 },
  header: { flexDirection: "row", alignItems: "center", marginStart: -8, marginBottom: 4 },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  backText: { color: theme.colors.textSecondary, fontSize: 34, lineHeight: 36 },
  title: { color: theme.colors.text, fontSize: 22, fontFamily: theme.font.bold },
});
