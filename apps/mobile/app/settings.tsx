import Constants from "expo-constants";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  I18nManager,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { ScrollView as ScrollViewType } from "react-native";
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
import { settingsWideLayout } from "@/lib/settings-sections";
import { createSettingsStore, type SettingsView } from "@/lib/settings-store";
import { theme } from "@/lib/theme";
import { useLayoutClass } from "@/lib/use-layout-class";
import { useVoiceController } from "@/lib/voice-context";
import { SettingsSectionNav, SettingsSections } from "@/screens/SettingsSections";

const APP_VERSION = Constants.expoConfig?.version ?? "0.0.0";
const PLATFORM = clientPlatformFor(Platform.OS);

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
  const scrollRef = useRef<ScrollViewType>(null);
  const sectionOffsets = useRef<Record<string, number>>({});
  const wide = layout.kind === "wide";
  const wideLayout = settingsWideLayout({
    language,
    platformRtl: I18nManager.getConstants().isRTL,
  });
  const paneDirection = { direction: wideLayout.paneDirection };

  const store = useMemo(
    () =>
      createSettingsStore({
        prefs: filePrefsStore,
        localeTag: Intl.DateTimeFormat().resolvedOptions().locale,
        loadRecord: async () => (await loadPairing(expoSecureStore))?.record,
        connectFromStored: (shouldConnect) =>
          connectFromStoredPairing({ secureStore: expoSecureStore, client, shouldConnect }),
        connection,
        client,
        clock: realClock,
        appVersion: APP_VERSION,
        unpair: async () => {
          await clearPairing(expoSecureStore);
          await authSession.forget();
        },
        navigateToPair: () => {
          router.replace("/pair");
        },
        log: console.log,
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
      onSectionLayout={
        wide
          ? (id, y) => {
              sectionOffsets.current[id] = y;
            }
          : undefined
      }
      onSpeakReplies={(on) => {
        void store
          .setSpeakReplies(on)
          .then(() => voiceController.setSpeakReplies(on))
          .catch(() => {});
      }}
      onValueChange={(on) => void store.setNotifications(on)}
      onLogout={handleLogout}
      onUnpair={handleUnpair}
    />
  );

  if (wide) {
    return (
      <View style={[styles.wideRoot, { direction: wideLayout.direction }]}>
        <View style={[styles.navPane, paneDirection]}>
          <SettingsSectionNav
            language={language}
            platform={PLATFORM}
            scrollRef={scrollRef}
            sectionOffsets={sectionOffsets}
          />
        </View>
        <View style={styles.divider} />
        <ScrollView
          ref={scrollRef}
          style={[styles.container, paneDirection]}
          contentContainerStyle={styles.wideContent}
        >
          {content}
        </ScrollView>
      </View>
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
  wideRoot: { flex: 1, flexDirection: "row", backgroundColor: theme.colors.background },
  navPane: { width: 220, flexShrink: 0 },
  divider: { width: 1, backgroundColor: theme.colors.hairlineSoft },
  wideContent: {
    width: "100%",
    maxWidth: 820,
    alignSelf: "center",
    padding: 24,
    paddingBottom: 40,
  },
  phoneContent: { paddingHorizontal: 20, paddingBottom: 34, gap: 8 },
  header: { flexDirection: "row", alignItems: "center", marginStart: -8, marginBottom: 4 },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  backText: { color: theme.colors.textSecondary, fontSize: 34, lineHeight: 36 },
  title: { color: theme.colors.text, fontSize: 22, fontFamily: theme.font.bold },
});
