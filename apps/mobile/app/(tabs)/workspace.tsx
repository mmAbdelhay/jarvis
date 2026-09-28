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
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  I18nManager,
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
import { splitLayout } from "@/lib/session-nav";
import { sessionRouteId } from "@/lib/session-screen";
import { openTerminal } from "@/lib/terminal-open";
import { theme } from "@/lib/theme";
import { usePhoneBack } from "@/lib/use-phone-back";
import { useLayoutClass } from "@/lib/use-layout-class";
import type { WorkspaceProjectView, WorkspaceView } from "@/lib/workspace-store";
import type { WorkspaceTabItem, WorkspaceToolKind } from "@/lib/workspace-tabs";
import {
  activeTab,
  openToolsWith,
  openWorkspaceTab,
  terminalPaneFor,
  toolTabId,
  withoutTool,
  workspaceHostKey,
  workspaceLayout,
  workspaceTabsFrom,
  workspaceTarget,
} from "@/lib/workspace-tabs";
import { ApiScreen } from "@/screens/ApiScreen";
import { ChangesScreen } from "@/screens/ChangesScreen";
import { DockerScreen } from "@/screens/DockerScreen";
import { TerminalPane } from "@/screens/TerminalPane";
import { ProjectPicker, type WorkspaceTool, WorkspaceTools } from "@/screens/WorkspaceTools";
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
  const [openTools, setOpenTools] = useState<WorkspaceToolKind[]>([]);
  const insets = useSafeAreaInsets();
  const { kind } = useLayoutClass();
  const wide = kind === "wide";
  const params = useLocalSearchParams<{ tab?: string; pane?: string }>();
  const tabParam = sessionRouteId(params.tab);
  const paneParam = sessionRouteId(params.pane);
  const split = splitLayout({ language, platformRtl: I18nManager.getConstants().isRTL });

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
    // The tab param names the old project's tab: drop it, or the effect
    // below would switch straight back to that project.
    if (tabParam !== undefined) router.setParams({ tab: undefined, pane: undefined });
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
  // screen. A freshly opened tab's main pane key is its own tab id. A phone
  // pushes the pane; a wide screen selects its tab in place.
  async function handleNewTerminal(project: string): Promise<void> {
    setNotice(undefined);
    setTerminalBusy(true);
    const outcome = await openTerminal(client, project);
    setTerminalBusy(false);
    if (outcome.ok) {
      openWorkspaceTab(
        router,
        workspaceTarget(kind, { id: outcome.tabId, kind: "terminal", paneKey: outcome.tabId }),
      );
      return;
    }
    setNotice(outcome.text);
  }

  const selected = view.projects.find((p) => p.name === view.selectedProject);
  const panesForSelectedTerminal =
    selected !== undefined && view.panesTabId !== undefined ? view.panes : undefined;

  // Wide (and a phone that inherited a tab from a rotation): the tab strip
  // and the active tab's inline content.
  const tools = openToolsWith(openTools, tabParam);
  const tabs = workspaceTabsFrom({ tabs: selected?.tabs ?? [] }, tools, language);
  const activeId = wide
    ? activeTab(tabs, tabParam)
    : tabs.some((tab) => tab.inline && tab.id === tabParam)
      ? tabParam
      : undefined;
  const active = tabs.find((tab) => tab.id === activeId);
  const activeTerminal = active?.kind === "terminal" ? active.id : undefined;
  const paneKey =
    activeTerminal === undefined
      ? undefined
      : terminalPaneFor({
          tabId: activeTerminal,
          panes: view.panes,
          panesTabId: view.panesTabId,
          pane: paneParam,
        });
  const project = view.selectedProject ?? "";
  // The inline content's React key: the pane, or the tab and project,
  // never the layout, so crossing the breakpoint keeps it mounted.
  const layout = workspaceLayout(kind, workspaceHostKey(active, paneKey, project));
  const backToList = useCallback(
    () => router.setParams({ tab: undefined, pane: undefined }),
    [router],
  );
  // Android's hardware Back on an inherited tab returns to the list, like
  // the back chip.
  usePhoneBack(layout.showBack, backToList);

  // A tab param from another project (a redirected deep link) selects
  // that project.
  const owner = view.projects.find((p) => p.tabs.some((tab) => tab.id === tabParam))?.name;
  useEffect(() => {
    if (owner !== undefined && owner !== view.selectedProject) store.selectProject(owner);
  }, [owner, view.selectedProject, store]);

  // Wide with no tab param: make the first tab the explicit selection, so
  // a rotation to the phone layout keeps showing it (and its one attach).
  // Only while focused: `setParams` acts on the focused route, and this
  // tab stays mounted behind the others.
  const focused = useIsFocused();
  useEffect(() => {
    if (focused && wide && tabParam === undefined && activeId !== undefined) {
      router.setParams({ tab: activeId, pane: undefined });
    }
  }, [focused, wide, tabParam, activeId, router]);

  // The active terminal tab's pane inventory.
  useEffect(() => {
    if (focused && activeTerminal !== undefined) store.readPanes(activeTerminal);
  }, [focused, activeTerminal, store]);

  function selectTab(tab: WorkspaceTabItem): void {
    if (!tab.inline) {
      // A web page, chat or sidecar: exactly what the phone's row does.
      const laptopTab = selected?.tabs.find((candidate) => candidate.id === tab.id);
      if (selected !== undefined && laptopTab !== undefined) openTab(selected.name, laptopTab);
      return;
    }
    openWorkspaceTab(router, workspaceTarget(kind, { id: tab.id, kind: tab.kind, project }));
  }

  function closeTab(tab: WorkspaceTabItem): void {
    setOpenTools(withoutTool(tools, tab.id));
    if (tab.id === activeId) router.setParams({ tab: undefined, pane: undefined });
  }

  function pickTool(tool: WorkspaceTool): void {
    if (selected === undefined) return;
    if (tool === "terminal") {
      void handleNewTerminal(selected.name);
      return;
    }
    if (tool === "chat") {
      void loadChatNames(selected.name);
      return;
    }
    if (tool === "editor" || tool === "database" || tool === "cluster") {
      // Sidecars keep their own screen: a new browser tab on web, the
      // sidecar view on native.
      router.push(`/sidecars/${encodeURIComponent(selected.name)}`);
      return;
    }
    setOpenTools(openToolsWith(tools, toolTabId(tool)));
    selectTab({ id: toolTabId(tool), kind: tool, inline: true, title: "", closable: true });
  }

  const errorText =
    view.error === undefined
      ? undefined
      : view.error.kind === "remote"
        ? view.error.text
        : t(language, "workspace.loadFailed");

  const statusLines = (
    <>
      {view.stale && <Text style={styles.warning}>{t(language, "common.stale")}</Text>}
      {view.liveUpdatesUnsupported && (
        <Text style={styles.warning}>{t(language, "workspace.subscribeUnsupported")}</Text>
      )}
      {errorText !== undefined && <Text style={styles.error}>{errorText}</Text>}
    </>
  );

  const list = (
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

      {statusLines}

      {view.projects.length === 0 && !view.loading ? (
        <Text style={styles.empty}>{t(language, "dashboard.noProjects")}</Text>
      ) : (
        <ProjectPicker
          projects={view.projects}
          selected={view.selectedProject}
          onSelect={selectProject}
        />
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

  return (
    // One tree for both layouts: the inline content sits in the same slot
    // whether the wide header or the phone's back chip is above it, so
    // crossing the breakpoint never remounts it (Review Focus 2).
    <View style={styles.root}>
      <View style={styles.column}>
        {layout.showTools && (
          // Mirrored like the top bar: the reading direction, never a
          // reversed row (native already forces RTL).
          <View style={[styles.wideHeader, { direction: split.direction }]}>
            <WorkspaceTools
              language={language}
              projects={view.projects}
              selectedProject={view.selectedProject}
              onSelectProject={selectProject}
              terminalBusy={terminalBusy}
              onTool={pickTool}
              chatNames={chatNames}
              chatBusy={chatBusy}
              onOpenChat={(name) => {
                if (selected !== undefined) void openChat(selected.name, name);
              }}
              tabs={tabs}
              activeId={activeId}
              onSelectTab={selectTab}
              onCloseTab={closeTab}
              panes={
                activeTerminal !== undefined && view.panesTabId === activeTerminal
                  ? view.panes.map((pane) => pane.paneKey)
                  : []
              }
              activePane={paneKey}
              onSelectPane={(pane) => {
                if (activeTerminal === undefined) return;
                openWorkspaceTab(
                  router,
                  workspaceTarget(kind, { id: activeTerminal, kind: "terminal", paneKey: pane }),
                );
              }}
            />
            {statusLines}
            {notice !== undefined && (
              <Text selectable style={styles.error}>
                {isMessageKey(notice) ? t(language, notice) : notice}
              </Text>
            )}
          </View>
        )}
        {layout.showBack && (
          <TouchableOpacity
            style={[styles.back, { paddingTop: insets.top + 10 }]}
            onPress={backToList}
            accessibilityRole="button"
          >
            <Text style={styles.backText}>
              {language === "ar" ? "›" : "‹"} {t(language, "workspace.back")}
            </Text>
          </TouchableOpacity>
        )}
        {layout.showList && list}
        {layout.paneKey !== undefined && active !== undefined && (
          <View style={[styles.paneHost, { direction: split.paneDirection }]}>
            <InlineTab
              key={layout.paneKey}
              tab={active}
              paneKey={paneKey}
              project={project}
              language={language}
            />
          </View>
        )}
        {layout.showEmpty && (
          <View style={styles.emptyPane}>
            <Text style={styles.empty}>
              {view.loading && view.projects.length === 0
                ? t(language, "workspace.loading")
                : view.projects.length === 0
                  ? t(language, "dashboard.noProjects")
                  : t(language, "workspace.pickTab")}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

/** The active tab's content, inline. A terminal tab waits for its pane
 *  inventory before it mounts the pane (and its one attach). */
function InlineTab(props: {
  tab: WorkspaceTabItem;
  paneKey: string | undefined;
  project: string;
  language: Language;
}) {
  const { tab } = props;
  if (tab.kind === "terminal") {
    if (props.paneKey === undefined) {
      return <Text style={styles.status}>{t(props.language, "session.attaching")}</Text>;
    }
    return <TerminalPane paneKey={props.paneKey} tabId={tab.id} embedded />;
  }
  if (tab.kind === "docker") return <DockerScreen project={props.project} embedded />;
  if (tab.kind === "api") return <ApiScreen project={props.project} embedded />;
  return <ChangesScreen sessionId={undefined} embedded />;
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
  root: { flex: 1, backgroundColor: theme.colors.background },
  // The desktop's content measure; a phone is narrower than it anyway.
  column: { flex: 1, width: "100%", maxWidth: 1180, alignSelf: "center" },
  wideHeader: { paddingHorizontal: 20, paddingTop: 14, gap: 8 },
  paneHost: { flex: 1, minHeight: 0 },
  emptyPane: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  back: { paddingHorizontal: 14, paddingBottom: 10, backgroundColor: theme.colors.ground },
  backText: { color: theme.colors.primary, fontFamily: theme.font.semibold, fontSize: 14 },
  status: { color: theme.colors.warning, padding: theme.spacing.sm },
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 20, gap: 18 },
  title: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 26 },
  center: { alignItems: "center", padding: theme.spacing.lg },
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
