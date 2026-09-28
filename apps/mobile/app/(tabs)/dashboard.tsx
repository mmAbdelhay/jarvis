import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ConnectionView } from "@/lib/connection-store";
import { connectionPillModel } from "@/lib/connection-pill";
import { type DashboardPanel, dashboardColumns } from "@/lib/dashboard-grid";
import type { DashboardView } from "@/lib/dashboard-store";
import { createDashboardStore } from "@/lib/dashboard-store";
import { STRINGS, t } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { loadPairing } from "@/lib/pairing-record";
import { useConnectionStore, useRpcClient } from "@/lib/rpc-context";
import { expoSecureStore } from "@/lib/secure-store";
import { openSession, sessionTarget } from "@/lib/session-nav";
import { theme } from "@/lib/theme";
import { useLayoutClass } from "@/lib/use-layout-class";
import { WIDE_PANEL_MAX_WIDTH } from "@/lib/wide-panel";
import {
  DashboardGrid,
  type ProjectActions,
  ProjectsPanel,
  SessionsPanel,
  SystemPanel,
} from "@/screens/DashboardPanels";

function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(STRINGS, value);
}

export default function DashboardScreen() {
  const language = useLanguage();
  const router = useRouter();
  const client = useRpcClient();
  const connectionStore = useConnectionStore();
  const store = useMemo(() => createDashboardStore({ client }), [client]);
  const [view, setView] = useState<DashboardView>(store.get());
  const [connection, setConnection] = useState<ConnectionView>(connectionStore.get());
  // The paired computer's display name — read from the same
  // `loadPairing(expoSecureStore)` source `settings.tsx` uses (item 3):
  // there is no store dedicated to this, only the Settings screen's own
  // read, so the Dashboard's connection pill reads it directly rather than
  // standing up a second `SettingsStore` just for one field.
  const [laptopName, setLaptopName] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalError, setTerminalError] = useState<string | undefined>(undefined);
  const insets = useSafeAreaInsets();
  // Wide: the WideShell top bar replaces the phone header (brand,
  // connection pill, History and Settings buttons) and the panels sit in a
  // grid; phone keeps today's stacked screen unchanged.
  const layout = useLayoutClass();
  const wide = layout.kind === "wide";
  const { width } = useWindowDimensions();
  useFocusEffect(
    useCallback(() => {
      setView(store.get());
      const unsubscribe = store.subscribe(setView);
      store.focus();
      setConnection(connectionStore.get());
      const unsubscribeConnection = connectionStore.subscribe(setConnection);
      let cancelled = false;
      void loadPairing(expoSecureStore).then((loaded) => {
        if (!cancelled) setLaptopName(loaded?.record.laptopName);
      });
      return () => {
        unsubscribe();
        store.blur();
        unsubscribeConnection();
        cancelled = true;
      };
    }, [store, connectionStore]),
  );
  const refresh = useCallback(() => {
    setRefreshing(true);
    void store.refresh().finally(() => setRefreshing(false));
  }, [store]);
  const openProjectTerminal = useCallback(
    async (projectName: string) => {
      setTerminalError(undefined);
      setTerminalBusy(true);
      const outcome = await store.openTerminal(projectName);
      setTerminalBusy(false);
      if (outcome.ok) {
        router.push({
          pathname: "/terminal/[paneKey]",
          params: { paneKey: outcome.tabId, tabId: outcome.tabId },
        });
        return;
      }
      setTerminalError(isMessageKey(outcome.text) ? t(language, outcome.text) : outcome.text);
    },
    [store, router, language],
  );
  const pill = connectionPillModel(connection);
  const pillColor = theme.colors[pill.tone];
  const now = Date.now();
  const projectActions: ProjectActions = {
    openTerminal: (projectName) => void openProjectTerminal(projectName),
    openWorkspace: () => router.push("/workspace"),
    openDocker: (projectName) => router.push(`/docker/${encodeURIComponent(projectName)}`),
    openVoice: () => router.push("/voice"),
    openSidecars: (projectName) => router.push(`/sidecars/${encodeURIComponent(projectName)}`),
  };
  const renderPanel = (panel: DashboardPanel) => {
    if (panel === "system") {
      return <SystemPanel language={language} metrics={view.metrics} wide={wide} />;
    }
    if (panel === "sessions") {
      return (
        <SessionsPanel
          language={language}
          sessions={view.sessions}
          now={now}
          wide={wide}
          onOpenSession={(id) => openSession(router, sessionTarget(layout.kind, id, "elsewhere"))}
          onAllSessions={() => router.push("/sessions")}
          onHistory={() => router.push("/history")}
        />
      );
    }
    return (
      <ProjectsPanel
        language={language}
        projects={view.projects}
        wide={wide}
        terminalDisabled={connection.state !== "open" || terminalBusy}
        terminalBusy={terminalBusy}
        terminalError={terminalError}
        actions={projectActions}
      />
    );
  };
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.content,
        wide ? styles.contentWide : { paddingTop: insets.top + 8 },
      ]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refresh}
          tintColor={theme.colors.accent}
        />
      }
    >
      {!wide && (
        <View style={styles.header}>
          <Text style={styles.brand}>JARVIS</Text>
          <View style={styles.connection}>
            <View style={[styles.liveDot, { backgroundColor: pillColor }]} />
            <Text style={styles.connectionText}>{t(language, pill.key)}</Text>
            {laptopName !== undefined && laptopName.length > 0 && (
              <Text style={styles.connectionName} numberOfLines={1}>
                {laptopName}
              </Text>
            )}
          </View>
          <View style={styles.spacer} />
          <TouchableOpacity
            style={styles.gear}
            onPress={() => router.push("/history")}
            accessibilityRole="button"
            accessibilityLabel={t(language, "dashboard.history")}
          >
            <Text style={styles.gearText}>◷</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.gear}
            onPress={() => router.push("/settings")}
            accessibilityRole="button"
            accessibilityLabel={t(language, "nav.settings")}
          >
            <Text style={styles.gearText}>⚙</Text>
          </TouchableOpacity>
        </View>
      )}
      {wide ? (
        <DashboardGrid
          language={language}
          columns={dashboardColumns(width)}
          renderPanel={renderPanel}
        />
      ) : (
        <>
          {renderPanel("system")}
          {renderPanel("sessions")}
          {renderPanel("projects")}
        </>
      )}
      {view.error?.kind === "remote" && (
        <Text style={[styles.error, wide && styles.errorWide]}>{view.error.text}</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.ground },
  content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24, gap: 18 },
  contentWide: { paddingTop: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48 },
  brand: {
    color: theme.colors.text,
    fontFamily: theme.font.bold,
    fontSize: 15,
    letterSpacing: 3.3,
  },
  connection: {
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    height: 30,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 999,
    backgroundColor: theme.colors.surface,
  },
  liveDot: { width: 7, height: 7, borderRadius: 999, backgroundColor: theme.colors.success },
  connectionText: {
    color: theme.colors.textSecondary,
    fontFamily: theme.font.semibold,
    fontSize: 12,
  },
  connectionName: {
    flexShrink: 1,
    color: theme.colors.textDim,
    fontFamily: theme.font.mono,
    fontSize: 11,
  },
  spacer: { flex: 1 },
  gear: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 12,
    backgroundColor: theme.colors.surface,
  },
  gearText: { color: theme.colors.textSecondary, fontSize: 19 },
  error: { color: theme.colors.danger, fontFamily: theme.font.body, fontSize: 12 },
  // Wide: under the grid, inside the same centred 1180 measure.
  errorWide: { width: "100%", maxWidth: WIDE_PANEL_MAX_WIDTH, alignSelf: "center" },
});
