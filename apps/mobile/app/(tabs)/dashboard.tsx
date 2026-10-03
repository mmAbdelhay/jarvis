import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActiveList } from "@/components/ActiveList";
import { Icon } from "@/components/Icon";
import { IconButton } from "@/components/IconButton";
import { type ChangeCountsView, createChangeCountsStore } from "@/lib/change-counts";
import type { ConnectionView } from "@/lib/connection-store";
import { machinePillModel } from "@/lib/connection-pill";
import { type DashboardPanel, dashboardColumns } from "@/lib/dashboard-grid";
import type { DashboardView } from "@/lib/dashboard-store";
import { createDashboardStore } from "@/lib/dashboard-store";
import { createHomeStore, type HomeView } from "@/lib/home-store";
import { STRINGS, t } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { loadPairing } from "@/lib/pairing-record";
import { useConnectionStore, useRpcClient } from "@/lib/rpc-context";
import { expoSecureStore } from "@/lib/secure-store";
import { openSession, sessionTarget } from "@/lib/session-nav";
import { answerPrompt } from "@/lib/session-prompt";
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
import { HomeTop } from "@/screens/HomeTop";

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
  const homeStore = useMemo(() => createHomeStore({ client }), [client]);
  const [home, setHome] = useState<HomeView>(homeStore.get());
  const countsStore = useMemo(() => createChangeCountsStore({ client }), [client]);
  const [counts, setCounts] = useState<ChangeCountsView>(countsStore.get());
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
      setHome(homeStore.get());
      const unsubscribeHome = homeStore.subscribe(setHome);
      homeStore.focus();
      setCounts(countsStore.get());
      const unsubscribeCounts = countsStore.subscribe(setCounts);
      countsStore.focus();
      setConnection(connectionStore.get());
      const unsubscribeConnection = connectionStore.subscribe(setConnection);
      let cancelled = false;
      void loadPairing(expoSecureStore).then((loaded) => {
        if (!cancelled) setLaptopName(loaded?.record.laptopName);
      });
      return () => {
        unsubscribe();
        store.blur();
        unsubscribeHome();
        homeStore.blur();
        unsubscribeCounts();
        countsStore.blur();
        unsubscribeConnection();
        cancelled = true;
      };
    }, [store, homeStore, countsStore, connectionStore]),
  );
  // The sessions a question could be waiting in: Jarvis's own live ones.
  // A row found by the process scan has no terminal to answer through.
  const liveIds = view.sessions
    .filter(
      (session) =>
        session.origin !== "external" &&
        (session.state === "running" || session.state === "waiting"),
    )
    .map((session) => session.id);
  const liveKey = liveIds.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the id list's contents, not its identity.
  useEffect(() => {
    homeStore.setLiveSessions(liveIds);
  }, [homeStore, liveKey]);
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
  const pill = machinePillModel(connection, laptopName);
  const pillPalette = PILL_PALETTE[pill.tone];
  const pillText = pill.label.kind === "name" ? pill.label.name : t(language, pill.label.key);
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
        wide ? styles.contentWide : { paddingTop: insets.top },
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
          <View style={styles.brandGroup}>
            <View
              style={styles.brandMark}
              accessibilityElementsHidden
              importantForAccessibility="no"
            >
              <Icon name="brand" size={16} color={theme.colors.primaryText} />
            </View>
            <Text style={styles.brand}>Jarvis</Text>
          </View>
          <View style={styles.headerEnd}>
            <View style={[styles.connection, { backgroundColor: pillPalette.ground }]}>
              <View style={[styles.liveDot, { backgroundColor: theme.colors[pill.tone] }]} />
              <Text style={[styles.connectionText, { color: pillPalette.text }]} numberOfLines={1}>
                {pillText}
              </Text>
            </View>
            <IconButton
              icon="settings"
              iconSize={18}
              label={t(language, "nav.settings")}
              onPress={() => router.push("/settings")}
            />
          </View>
        </View>
      )}
      <View style={wide ? styles.homeTopWide : undefined}>
        <HomeTop
          language={language}
          home={home}
          sessions={view.sessions}
          liveCount={liveIds.length}
          now={now}
          wide={wide}
          onAnswer={async (sessionId, index, label) => {
            const outcome = await answerPrompt(client, sessionId, index, label);
            if (outcome === "answered") homeStore.dismiss(sessionId);
            return outcome;
          }}
          onOpen={(id) => openSession(router, sessionTarget(layout.kind, id, "elsewhere"))}
        />
      </View>
      {wide ? (
        <DashboardGrid
          language={language}
          columns={dashboardColumns(width)}
          renderPanel={renderPanel}
        />
      ) : (
        <ActiveList
          language={language}
          sessions={view.sessions}
          counts={counts}
          now={now}
          onOpen={(id) => openSession(router, sessionTarget(layout.kind, id, "elsewhere"))}
          onAll={() => router.push("/sessions")}
        />
      )}
      {view.error?.kind === "remote" && (
        <Text style={[styles.error, wide && styles.errorWide]}>{view.error.text}</Text>
      )}
    </ScrollView>
  );
}

// The pill's ground and text per tone: success, warning and danger palettes.
const PILL_PALETTE = {
  success: { ground: theme.colors.successSurface, text: theme.colors.successText },
  warning: { ground: theme.colors.warningSurface, text: theme.colors.warningText },
  danger: { ground: theme.colors.dangerSurface, text: theme.colors.dangerText },
} as const;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.ground },
  content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16, gap: 16 },
  contentWide: { paddingTop: 16 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 18,
    paddingBottom: 10,
    // The content gap (16) already separates the header from the body; the
    // mockup's header-to-body distance is 10 + 6.
    marginBottom: -10,
  },
  brandGroup: { flexDirection: "row", alignItems: "center", gap: 10 },
  headerEnd: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  brandMark: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  brand: { ...theme.type.brand, color: theme.colors.text },
  connection: {
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.radius.pill,
  },
  liveDot: { width: 7, height: 7, borderRadius: 999 },
  connectionText: { flexShrink: 1, fontFamily: theme.font.semibold, fontSize: 12 },
  error: { color: theme.colors.danger, fontFamily: theme.font.body, fontSize: 12 },
  // Wide: under the grid, inside the same centred 1180 measure.
  errorWide: { width: "100%", maxWidth: WIDE_PANEL_MAX_WIDTH, alignSelf: "center" },
  homeTopWide: { width: "100%", maxWidth: WIDE_PANEL_MAX_WIDTH, alignSelf: "center" },
});
