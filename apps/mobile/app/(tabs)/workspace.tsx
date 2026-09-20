// The Workspace screen (M9 Task 7): the laptop's open tabs, by project,
// plus the phone's own entry points into each project's content. All
// decision logic — parsing, generation guards, URL validation — lives in
// workspace-store.ts; this file is layout and navigation only, the same
// split sidecars/[project].tsx and docker/[project].tsx already follow.
//
// Controller ruling (a): M11's sidecar route is already merged, so
// Editor/Database/Cluster rows here link straight to the existing
// `/sidecars/[project]` screen rather than rendering a placeholder.
// Controller ruling (c): a phone never rearranges the laptop's own tabs —
// every row below either opens the phone's own route/browser or reads a
// row that already exists; nothing here calls a workspace:*/terminal:open
// mutation.
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { MobileWorkspaceTab } from "@jarvis/wire";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { STRINGS, t } from "@/lib/i18n";
import type { Language, MessageKey } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import { openTerminal } from "@/lib/terminal-open";
import { theme } from "@/lib/theme";
import type { WorkspaceProjectView, WorkspaceView } from "@/lib/workspace-store";
import {
  createWorkspaceStore,
  listChatNames,
  resolveChatUrl,
  safeExternalUrl,
} from "@/lib/workspace-store";

/** Routes that already exist on the phone for a kind of laptop tab — the
 *  rest (`api`, `chat` handled separately below) have none yet and render
 *  as read-only rows. */
function sidecarKind(kind: MobileWorkspaceTab["kind"]): boolean {
  return kind === "editor" || kind === "database" || kind === "cluster";
}

function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(STRINGS, value);
}

export default function WorkspaceScreen() {
  const language = useLanguage();
  const router = useRouter();
  const client = useRpcClient();
  const store = useMemo(() => createWorkspaceStore({ client }), [client]);
  const [view, setView] = useState<WorkspaceView>(store.get());
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [chatNames, setChatNames] = useState<string[] | undefined>(undefined);
  const [chatBusy, setChatBusy] = useState(false);
  const [terminalBusy, setTerminalBusy] = useState(false);
  const insets = useSafeAreaInsets();

  useFocusEffect(
    useCallback(() => {
      setView(store.get());
      const unsubscribe = store.subscribe(setView);
      store.open();
      return () => {
        unsubscribe();
        store.close();
      };
    }, [store]),
  );

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    store.refresh();
    setTimeout(() => setRefreshing(false), 250);
  }, [store]);

  function selectProject(name: string): void {
    setChatNames(undefined);
    setNotice(undefined);
    store.selectProject(name);
  }

  async function openExternal(url: string): Promise<void> {
    const safe = safeExternalUrl(url);
    if (safe === undefined) {
      setNotice(t(language, "workspace.unsafeUrl"));
      return;
    }
    try {
      await Linking.openURL(safe);
    } catch {
      setNotice(t(language, "workspace.openFailed"));
    }
  }

  function openTab(project: string, tab: MobileWorkspaceTab): void {
    if (tab.kind === "terminal") {
      store.readPanes(tab.id);
      return;
    }
    if (sidecarKind(tab.kind)) {
      router.push(`/sidecars/${encodeURIComponent(project)}`);
      return;
    }
    if (tab.kind === "docker") {
      router.push(`/docker/${encodeURIComponent(project)}`);
      return;
    }
    if (tab.kind === "web" || tab.kind === "chat") {
      void openExternal(tab.url);
      return;
    }
    if (tab.kind === "api") {
      // M9 Task 5: the API pane now has a phone route — one per project,
      // same as Docker/Sidecars, since a collection tree is a view of the
      // filesystem, not a per-tab session.
      router.push(`/api/${encodeURIComponent(project)}`);
    }
  }

  async function openChat(project: string, name: string): Promise<void> {
    setChatBusy(true);
    const url = await resolveChatUrl(client, project, name);
    setChatBusy(false);
    if (url === undefined) {
      setNotice(t(language, "workspace.openFailed"));
      return;
    }
    void openExternal(url);
  }

  async function loadChatNames(project: string): Promise<void> {
    setChatBusy(true);
    const names = await listChatNames(client, project);
    setChatBusy(false);
    setChatNames(names);
  }

  function openPane(tabId: string, paneKey: string): void {
    router.push({ pathname: "/terminal/[paneKey]", params: { paneKey, tabId } });
  }

  // "New terminal" (OPEN ON THE LAPTOP header): opens a tab, not read here
  // — ruling (c)'s own "workspace-store.ts never calls a tab-mutating
  // channel" stays true; this goes through terminal-open.ts, the same
  // shared call the Dashboard's Terminal tile uses, straight from the
  // screen. A freshly opened tab's main pane key is its own tab id.
  async function handleNewTerminal(project: string): Promise<void> {
    setNotice(undefined);
    setTerminalBusy(true);
    const outcome = await openTerminal(client, project);
    setTerminalBusy(false);
    if (outcome.ok) {
      router.push({
        pathname: "/terminal/[paneKey]",
        params: { paneKey: outcome.tabId, tabId: outcome.tabId },
      });
      return;
    }
    setNotice(outcome.text);
  }

  const selected = view.projects.find((p) => p.name === view.selectedProject);
  const panesForSelectedTerminal =
    selected !== undefined && view.panesTabId !== undefined ? view.panes : undefined;

  const errorText =
    view.error === undefined
      ? undefined
      : view.error.kind === "remote"
        ? view.error.text
        : t(language, "workspace.loadFailed");

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 8 }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={handleRefresh}
          tintColor={theme.colors.primary}
        />
      }
    >
      <Text style={styles.title}>{t(language, "workspace.title")}</Text>
      {view.loading && view.projects.length === 0 && (
        <View style={styles.center}>
          <ActivityIndicator
            color={theme.colors.primary}
            accessibilityLabel={t(language, "workspace.loading")}
          />
        </View>
      )}

      {view.stale && <Text style={styles.warning}>{t(language, "common.stale")}</Text>}
      {view.liveUpdatesUnsupported && (
        <Text style={styles.warning}>{t(language, "workspace.subscribeUnsupported")}</Text>
      )}
      {errorText !== undefined && <Text style={styles.error}>{errorText}</Text>}

      {view.projects.length === 0 && !view.loading ? (
        <Text style={styles.empty}>{t(language, "dashboard.noProjects")}</Text>
      ) : (
        <View style={styles.projectRow}>
          {view.projects.map((project) => (
            <TouchableOpacity
              key={project.name}
              style={[
                styles.projectChip,
                project.name === view.selectedProject && styles.projectChipSelected,
              ]}
              onPress={() => selectProject(project.name)}
              accessibilityRole="button"
            >
              <Text style={styles.projectChipText}>{project.name}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {selected !== undefined && (
        <ProjectSection
          project={selected}
          language={language}
          panes={panesForSelectedTerminal}
          panesTabId={view.panesTabId}
          chatNames={chatNames}
          chatBusy={chatBusy}
          notice={notice}
          onOpenTab={(tab) => openTab(selected.name, tab)}
          onOpenPane={openPane}
          onNewTerminal={() => void handleNewTerminal(selected.name)}
          terminalBusy={terminalBusy}
          onOpenDocker={() => router.push(`/docker/${encodeURIComponent(selected.name)}`)}
          onOpenApi={() => router.push(`/api/${encodeURIComponent(selected.name)}`)}
          onOpenSidecars={() => router.push(`/sidecars/${encodeURIComponent(selected.name)}`)}
          onLoadChat={() => void loadChatNames(selected.name)}
          onOpenChat={(name) => void openChat(selected.name, name)}
          // Fix round item 2: `Workspace.dc.html`'s "Changes" row. The old
          // Dashboard's own `dashboard.changes` quick-link (removed in the
          // redesign) pushed to the same global `/changes` route with no
          // session id and did no fetch of its own for +/- counts — there
          // is no per-project git-counts RPC to pull them from here either
          // (git:counts/git:changes are both keyed by session id, not
          // project — changes-store.ts, workspace-store.ts), so this row
          // matches that: no counts, same route.
          onOpenChanges={() => router.push("/changes")}
        />
      )}
    </ScrollView>
  );
}

function tabLabel(tab: MobileWorkspaceTab): string {
  // Server-originated text — displayed verbatim (global constraint 7).
  return tab.title;
}

function ProjectSection(props: {
  project: WorkspaceProjectView;
  language: Language;
  panes: { paneKey: string; exited: boolean }[] | undefined;
  panesTabId: string | undefined;
  chatNames: string[] | undefined;
  chatBusy: boolean;
  notice: string | undefined;
  onOpenTab: (tab: MobileWorkspaceTab) => void;
  onOpenPane: (tabId: string, paneKey: string) => void;
  onNewTerminal: () => void;
  terminalBusy: boolean;
  onOpenDocker: () => void;
  onOpenApi: () => void;
  onOpenSidecars: () => void;
  onLoadChat: () => void;
  onOpenChat: (name: string) => void;
  onOpenChanges: () => void;
}) {
  const { language } = props;
  return (
    <View style={styles.section}>
      {props.notice !== undefined && (
        <Text selectable style={styles.error}>
          {isMessageKey(props.notice) ? t(language, props.notice) : props.notice}
        </Text>
      )}

      <View style={styles.tabsHeader}>
        <Text style={styles.sectionTitle}>{t(language, "workspace.openOnLaptop")}</Text>
        <View style={styles.tabsHeaderSpacer} />
        <TouchableOpacity
          style={styles.newTerminalButton}
          disabled={props.terminalBusy}
          onPress={props.onNewTerminal}
          accessibilityRole="button"
        >
          <Text style={styles.newTerminalText}>
            {props.terminalBusy
              ? t(language, "workspace.openingTerminal")
              : t(language, "workspace.newTerminal")}
          </Text>
        </TouchableOpacity>
      </View>

      {props.project.tabs.length === 0 ? (
        <Text style={styles.empty}>{t(language, "workspace.noTabs")}</Text>
      ) : (
        <View style={styles.list}>
          {props.project.tabs.map((tab) => (
            <View key={tab.id}>
              <TouchableOpacity
                style={styles.row}
                onPress={() => props.onOpenTab(tab)}
                accessibilityRole="button"
              >
                <Text style={styles.rowLabel}>{tabLabel(tab)}</Text>
                <Text style={styles.rowKind}>{tab.kind}</Text>
              </TouchableOpacity>
              {tab.kind === "terminal" && props.panesTabId === tab.id && (
                <View style={styles.paneList}>
                  <Text style={styles.sectionTitle}>{t(language, "workspace.panes.title")}</Text>
                  {props.panes === undefined || props.panes.length === 0 ? (
                    <Text style={styles.empty}>{t(language, "workspace.panes.empty")}</Text>
                  ) : (
                    props.panes.map((pane) => (
                      <TouchableOpacity
                        key={pane.paneKey}
                        style={styles.paneRow}
                        onPress={() => props.onOpenPane(tab.id, pane.paneKey)}
                        accessibilityRole="button"
                      >
                        <Text style={styles.rowLabel}>{pane.paneKey}</Text>
                        <Text style={styles.rowKind}>
                          {t(
                            language,
                            pane.exited ? "workspace.panes.exited" : "workspace.panes.live",
                          )}
                        </Text>
                      </TouchableOpacity>
                    ))
                  )}
                </View>
              )}
            </View>
          ))}
        </View>
      )}

      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.actionButton}
          onPress={props.onOpenDocker}
          accessibilityRole="button"
        >
          <Text style={styles.actionButtonText}>{t(language, "docker.title")}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionButton}
          onPress={props.onOpenApi}
          accessibilityRole="button"
        >
          <Text style={styles.actionButtonText}>{t(language, "api.title")}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionButton}
          onPress={props.onOpenSidecars}
          accessibilityRole="button"
        >
          <Text style={styles.actionButtonText}>{t(language, "sidecars.title")}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionButton}
          disabled={props.chatBusy}
          onPress={props.onLoadChat}
          accessibilityRole="button"
        >
          <Text style={styles.actionButtonText}>{t(language, "workspace.chat")}</Text>
        </TouchableOpacity>
      </View>

      {props.chatNames !== undefined && (
        <View style={styles.list}>
          {props.chatNames.length === 0 ? (
            <Text style={styles.empty}>{t(language, "workspace.chatUnavailable")}</Text>
          ) : (
            props.chatNames.map((name) => (
              <TouchableOpacity
                key={name}
                style={styles.row}
                disabled={props.chatBusy}
                onPress={() => props.onOpenChat(name)}
                accessibilityRole="button"
              >
                <Text style={styles.rowLabel}>{name}</Text>
              </TouchableOpacity>
            ))
          )}
        </View>
      )}

      <TouchableOpacity
        style={styles.changesRow}
        onPress={props.onOpenChanges}
        accessibilityRole="button"
      >
        <Text style={styles.changesIcon}>⎇</Text>
        <Text style={styles.changesLabel}>{t(language, "dashboard.changes")}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 20, gap: 18 },
  title: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 26 },
  center: { alignItems: "center", padding: theme.spacing.lg },
  projectRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.sm },
  projectChip: {
    height: 36,
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 14,
  },
  projectChipSelected: {
    backgroundColor: theme.colors.accentSoft,
    borderColor: theme.colors.accent,
  },
  projectChipText: {
    color: theme.colors.textSecondary,
    fontFamily: theme.font.semibold,
    fontSize: 13,
  },
  section: { gap: theme.spacing.md },
  sectionTitle: {
    color: theme.colors.textDim,
    fontFamily: theme.font.bold,
    fontSize: 12,
    letterSpacing: 1.2,
  },
  tabsHeader: { flexDirection: "row", alignItems: "baseline", gap: theme.spacing.sm },
  tabsHeaderSpacer: { flex: 1 },
  newTerminalButton: {
    height: 32,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.small,
    backgroundColor: theme.colors.surface,
  },
  newTerminalText: { color: theme.colors.accent, fontFamily: theme.font.semibold, fontSize: 12 },
  list: { gap: theme.spacing.sm },
  row: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderWidth: 1,
    borderRadius: theme.radius.card,
    padding: theme.spacing.md,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  rowLabel: { color: theme.colors.text, fontFamily: theme.font.semibold, fontSize: 14 },
  rowKind: { color: theme.colors.textDim, fontFamily: theme.font.mono, fontSize: 11 },
  paneList: { paddingStart: theme.spacing.md, gap: theme.spacing.sm, marginTop: theme.spacing.sm },
  paneRow: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.sm,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  actionButton: {
    width: "48%",
    minHeight: 92,
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    padding: 14,
    alignItems: "flex-start",
  },
  actionButtonText: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 15 },
  changesRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.card,
    backgroundColor: theme.colors.surface,
  },
  changesIcon: { color: theme.colors.textSecondary, fontFamily: theme.font.mono, fontSize: 18 },
  changesLabel: { flex: 1, color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 15 },
  empty: { color: theme.colors.textMuted, fontSize: theme.font.size.sm },
  warning: { color: theme.colors.warning, fontSize: theme.font.size.sm },
  error: { color: theme.colors.danger, fontSize: theme.font.size.sm },
});
