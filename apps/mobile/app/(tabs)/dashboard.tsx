import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActiveList } from "@/components/ActiveList";
import { ActiveTable } from "@/components/ActiveTable";
import { NewSessionSheet } from "@/components/NewSessionSheet";
import { ProjectToolRow } from "@/components/ProjectToolRow";
import { Icon } from "@/components/Icon";
import { IconButton } from "@/components/IconButton";
import { MetricStrip } from "@/components/MetricStrip";
import { type ChangeCountsView, createChangeCountsStore } from "@/lib/change-counts";
import type { ConnectionView } from "@/lib/connection-store";
import { machinePillModel } from "@/lib/connection-pill";
import type { DashboardView } from "@/lib/dashboard-store";
import { createDashboardStore } from "@/lib/dashboard-store";
import { workingCount } from "@/lib/home-active";
import { createHomeStore, type HomeView } from "@/lib/home-store";
import { PROJECT_TOOLS, type ProjectTool } from "@/lib/home-wide";
import { STRINGS, t } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { loadProjectChoices } from "@/lib/new-session";
import { loadPairing } from "@/lib/pairing-record";
import { useConnectionStore, useRpcClient } from "@/lib/rpc-context";
import { expoSecureStore } from "@/lib/secure-store";
import { openSession, sessionTarget } from "@/lib/session-nav";
import { answerPrompt } from "@/lib/session-prompt";
import { theme } from "@/lib/theme";
import { useLayoutClass } from "@/lib/use-layout-class";
import { contentWidth, homeSideBySide } from "@/lib/wide-breakpoints";
import { WIDE_PANEL_MAX_WIDTH } from "@/lib/wide-panel";
import type { ProjectSummary } from "@/lib/dashboard-store";
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
  // The New terminal / New session sheet (both layouts).
  const [sheet, setSheet] = useState<"session" | "terminal" | undefined>(undefined);
  const [choices, setChoices] = useState<ProjectSummary[] | null | undefined>(undefined);
  const insets = useSafeAreaInsets();
  // Wide: the WideShell top bar replaces the phone header (brand,
  // connection pill, History and Settings buttons) and the panels sit in a
  // grid; phone stacks headline, metrics, quick actions, Active, Projects.
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
      // The phone's ActiveList and the wide Active table both read the counts.
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
    async (projectName: string): Promise<boolean> => {
      setTerminalError(undefined);
      setTerminalBusy(true);
      const outcome = await store.openTerminal(projectName);
      setTerminalBusy(false);
      if (outcome.ok) {
        router.push({
          pathname: "/terminal/[paneKey]",
          params: { paneKey: outcome.tabId, tabId: outcome.tabId },
        });
        return true;
      }
      setTerminalError(isMessageKey(outcome.text) ? t(language, outcome.text) : outcome.text);
      return false;
    },
    [store, router, language],
  );
  const pill = machinePillModel(connection, laptopName);
  const pillPalette = PILL_PALETTE[pill.tone];
  const pillText = pill.label.kind === "name" ? pill.label.name : t(language, pill.label.key);
  const now = Date.now();
  const openSheet = useCallback(
    (mode: "session" | "terminal") => {
      setTerminalError(undefined);
      setChoices(undefined);
      setSheet(mode);
      void loadProjectChoices(client).then((loaded) =>
        setChoices(loaded.ok ? loaded.projects : null),
      );
    },
    [client],
  );
  // One project: New terminal skips the sheet and opens straight into it.
  const newTerminal = () => {
    const only = view.projects.length === 1 ? view.projects[0] : undefined;
    if (only !== undefined) void openProjectTerminal(only.name);
    else openSheet("terminal");
  };
  const runTool = (project: string, tool: ProjectTool) => {
    const name = encodeURIComponent(project);
    if (tool === "terminal") void openProjectTerminal(project);
    else if (tool === "docker") router.push(`/docker/${name}`);
    else if (tool === "api") router.push(`/api/${name}`);
    else router.push(`/sidecars/${name}`);
  };
  const content = contentWidth(width, layout.compact ? "rail" : "full");
  const inner = Math.min(content - 64, WIDE_PANEL_MAX_WIDTH);
  const openById = (id: string) => openSession(router, sessionTarget(layout.kind, id, "elsewhere"));
  const answer = async (sessionId: string, index: number, label: string) => {
    const outcome = await answerPrompt(client, sessionId, index, label);
    if (outcome === "answered") homeStore.dismiss(sessionId);
    return outcome;
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
      {wide ? (
        <View style={styles.homeTopWide}>
          <HomeTop
            language={language}
            home={home}
            sessions={view.sessions}
            liveCount={liveIds.length}
            now={now}
            wide={{
              connection:
                pill.label.kind === "name"
                  ? t(language, "home.connectedTo", { name: pill.label.name })
                  : pillText,
              metrics: view.metrics,
              content,
              inner,
              onNewTerminal: newTerminal,
              onNewSession: () => openSheet("session"),
            }}
            onAnswer={answer}
            onOpen={openById}
          />
          <View style={[styles.lower, homeSideBySide(content) && styles.lowerRow]}>
            <View style={homeSideBySide(content) ? styles.activeCol : undefined}>
              <ActiveTable
                language={language}
                sessions={view.sessions}
                counts={counts}
                onOpen={openById}
                onAll={() => router.push("/sessions")}
              />
            </View>
            <View style={[styles.projectsCol, homeSideBySide(content) && styles.projectsColRow]}>
              <Text style={styles.sectionTitle}>
                {t(language, "dashboard.projects").toUpperCase()}
              </Text>
              {view.projects.length === 0 && (
                <Text style={styles.empty}>{t(language, "dashboard.noProjects")}</Text>
              )}
              {view.projects.map((project) => (
                <ProjectToolRow
                  key={project.name}
                  language={language}
                  name={project.name}
                  tools={PROJECT_TOOLS}
                  disabled={connection.state !== "open" || terminalBusy ? ["terminal"] : []}
                  onTool={(tool) => runTool(project.name, tool)}
                />
              ))}
              {terminalError !== undefined && sheet === undefined && (
                <Text style={styles.error}>{terminalError}</Text>
              )}
            </View>
          </View>
        </View>
      ) : (
        <>
          {/* Phone: the headline counts the agents found outside Jarvis too —
              they are working, even though no question can come from them. */}
          <HomeTop
            language={language}
            home={home}
            sessions={view.sessions}
            liveCount={workingCount(view.sessions)}
            now={now}
            wide={undefined}
            onAnswer={answer}
            onOpen={openById}
          />
          <MetricStrip language={language} metrics={view.metrics} />
          <View style={styles.quickActions}>
            <Pressable
              accessibilityRole="button"
              onPress={() => openSheet("session")}
              style={[styles.quickAction, styles.quickActionPrimary]}
            >
              <Icon name="plus" size={16} color={theme.colors.primaryText} />
              <Text style={[styles.quickActionText, styles.quickActionPrimaryText]}>
                {t(language, "home.newSession")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={terminalBusy}
              onPress={newTerminal}
              style={[styles.quickAction, terminalBusy && styles.quickActionBusy]}
            >
              <Icon name="terminal" size={16} color={theme.colors.text} />
              <Text style={styles.quickActionText}>{t(language, "home.newTerminal")}</Text>
            </Pressable>
          </View>
          <ActiveList
            language={language}
            sessions={view.sessions}
            counts={counts}
            now={now}
            onOpen={openById}
            onAll={() => router.push("/sessions")}
          />
          <View style={styles.projectsCol}>
            <Text style={styles.sectionTitle}>
              {t(language, "dashboard.projects").toUpperCase()}
            </Text>
            {view.projects.length === 0 && (
              <Text style={styles.empty}>{t(language, "dashboard.noProjects")}</Text>
            )}
            {view.projects.map((project) => (
              <ProjectToolRow
                key={project.name}
                language={language}
                name={project.name}
                tools={PROJECT_TOOLS}
                disabled={connection.state !== "open" || terminalBusy ? ["terminal"] : []}
                onTool={(tool) => runTool(project.name, tool)}
                stacked
              />
            ))}
            {terminalError !== undefined && sheet === undefined && (
              <Text style={styles.error}>{terminalError}</Text>
            )}
          </View>
        </>
      )}
      {view.error?.kind === "remote" && (
        <Text style={[styles.error, wide && styles.errorWide]}>{view.error.text}</Text>
      )}
      <NewSessionSheet
        language={language}
        visible={sheet !== undefined}
        mode={sheet}
        projects={choices}
        busy={terminalBusy}
        error={terminalError}
        onPick={(name) =>
          void openProjectTerminal(name).then((ok) => {
            if (ok) setSheet(undefined);
          })
        }
        onAskJarvis={() => {
          setSheet(undefined);
          router.push("/voice");
        }}
        onClose={() => setSheet(undefined)}
      />
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
  contentWide: { paddingTop: 28, paddingHorizontal: 32, paddingBottom: 28 },
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
  homeTopWide: { width: "100%", maxWidth: WIDE_PANEL_MAX_WIDTH, alignSelf: "center", gap: 22 },
  lower: { gap: 18 },
  lowerRow: { flexDirection: "row", alignItems: "flex-start" },
  activeCol: { flex: 3, minWidth: 0 },
  projectsCol: { gap: 8, minWidth: 0 },
  projectsColRow: { flex: 2 },
  sectionTitle: { ...theme.type.sectionLabelLarge, color: theme.colors.textMuted },
  empty: { ...theme.type.body, color: theme.colors.textMuted },
  // Phone: New session (primary) and New terminal, side by side.
  quickActions: { flexDirection: "row", gap: 8 },
  quickAction: {
    flex: 1,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  quickActionPrimary: { borderWidth: 0, backgroundColor: theme.colors.accent },
  quickActionBusy: { opacity: 0.5 },
  quickActionText: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 14 },
  quickActionPrimaryText: { color: theme.colors.primaryText },
});
