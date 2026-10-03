import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  I18nManager,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "@/components/Icon";
import { NewSessionSheet } from "@/components/NewSessionSheet";
import { ResumeButton } from "@/components/ResumeButton";
import { SessionRow } from "@/components/SessionRow";
import { type ChangeCountsView, createChangeCountsStore } from "@/lib/change-counts";
import type { ProjectSummary } from "@/lib/dashboard-store";
import { createHistoryStore, type HistoryState } from "@/lib/history-store";
import { createHomeStore, type HomeView } from "@/lib/home-store";
import type { Language, MessageKey } from "@/lib/i18n";
import { STRINGS, t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { loadProjectChoices } from "@/lib/new-session";
import { useRpcClient } from "@/lib/rpc-context";
import type { SessionDateGroup } from "@/lib/session-date-groups";
import { groupByDay } from "@/lib/session-date-groups";
import {
  openSession,
  sessionTarget,
  sessionPresence,
  sessionsSplit,
  splitLayout,
} from "@/lib/session-nav";
import { isSearchHotkey, sessionRouteId } from "@/lib/session-screen";
import { filterRows, projectsOf, type StatusFilter, statusCounts } from "@/lib/sessions-filter";
import {
  firstOpenableRow,
  isActiveRow,
  type MergedRow,
  mergeSessions,
  selectedRow,
} from "@/lib/sessions-merge";
import { resumable, rowCounts, rowSubtitle, rowTimeLabel, rowVariant } from "@/lib/sessions-row";
import { usePhoneBack } from "@/lib/use-phone-back";
import type { SessionsView } from "@/lib/sessions-store";
import { createSessionsStore } from "@/lib/sessions-store";
import { openTerminal } from "@/lib/terminal-open";
import { theme } from "@/lib/theme";
import { useLayoutClass } from "@/lib/use-layout-class";
import { contentWidth, sessionsListWidth } from "@/lib/wide-breakpoints";
import { SessionDetail } from "@/screens/SessionDetail";
import { TranscriptBody } from "@/screens/TranscriptView";

/** A search reaches the saved history once typing pauses, not on every key. */
const SEARCH_DELAY_MS = 300;

const STATUS_CHIPS: { status: StatusFilter; label: MessageKey }[] = [
  { status: "all", label: "sessions.filterAll" },
  { status: "waiting", label: "sessions.filterWaiting" },
  { status: "running", label: "sessions.filterRunning" },
  { status: "done", label: "sessions.filterDone" },
];

function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(STRINGS, value);
}

/** The ended-group section header text (item 7): a real date label instead
 *  of a hardcoded "TODAY" — `groupEndedByDate` (session-date-groups.ts)
 *  already buckets rows by calendar day; this just turns a bucket's label
 *  into display text. A day older than yesterday shows a short localized
 *  date rather than a third bilingual key, the same "no new STRINGS entry
 *  for open-ended data" approach session/[id].tsx and settings.tsx already
 *  take for dates (`toLocaleDateString`).
 */
function dateGroupLabelText(label: SessionDateGroup["label"], language: Language): string {
  if (label.kind === "today") return t(language, "sessions.today");
  if (label.kind === "yesterday") return t(language, "sessions.yesterday");
  return new Date(label.ms)
    .toLocaleDateString(language === "ar" ? "ar" : "en-US", { month: "short", day: "numeric" })
    .toUpperCase();
}

// The full session table: the laptop's live sessions and its saved history
// as one list (sessions-merge.ts), grouped by day with the active rows
// first. Screen logic (subscribing on focus, parsing, merging, grouping)
// lives in the stores and src/lib; this file is layout only.
//
// Wide layout (2026-09-28 spec §3): the list (360px) and the `?id=`
// session's detail side by side, the list on the right in Arabic. The
// detail is keyed by id only (session-nav.ts `sessionsSplit`), so crossing
// the breakpoint keeps it mounted with its one subscription; a phone that
// inherits a selection from a rotation shows that detail with a way back.
// A session that is only in the saved history shows its transcript there.
export default function SessionsScreen() {
  const language = useLanguage();
  const router = useRouter();
  const client = useRpcClient();
  const store = useMemo(() => createSessionsStore({ client }), [client]);
  const historyStore = useMemo(() => createHistoryStore({ client }), [client]);
  const countsStore = useMemo(() => createChangeCountsStore({ client }), [client]);
  const homeStore = useMemo(() => createHomeStore({ client }), [client]);
  const [view, setView] = useState<SessionsView>(store.get());
  const [history, setHistory] = useState<HistoryState>(historyStore.get());
  const [counts, setCounts] = useState<ChangeCountsView>(countsStore.get());
  const [home, setHome] = useState<HomeView>(homeStore.get());
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [project, setProject] = useState<string | undefined>(undefined);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [resumeErrors, setResumeErrors] = useState<Record<string, string | undefined>>({});
  const [newOpen, setNewOpen] = useState(false);
  const [choices, setChoices] = useState<ProjectSummary[] | null | undefined>(undefined);
  const [newBusy, setNewBusy] = useState(false);
  const [newError, setNewError] = useState<string | undefined>(undefined);
  const insets = useSafeAreaInsets();
  const { kind, compact } = useLayoutClass();
  const wide = kind === "wide";
  const { width: windowWidth } = useWindowDimensions();
  const listWidth = sessionsListWidth(contentWidth(windowWidth, compact ? "rail" : "full"));
  const searchRef = useRef<TextInput>(null);
  const selectedId = sessionRouteId(useLocalSearchParams().id);
  // Set once a `sessions:list` has answered since mount: until then an
  // empty list says nothing about whether the selected session exists.
  const [listed, setListed] = useState(false);
  const loadingSeen = useRef(false);

  const rows = useMemo(
    () => mergeSessions([...view.active, ...view.ended], history.sessions),
    [view.active, view.ended, history.sessions],
  );
  // A selected history-only row stays on screen when a search drops it from
  // the loaded history (the wide pane would read "not found" otherwise).
  const rememberedRow = useRef<MergedRow | undefined>(undefined);
  const selected = selectedRow(rows, selectedId, rememberedRow.current);
  rememberedRow.current = selected;
  const presence = sessionPresence({
    listed,
    loading: view.loading || history.loading,
    failed: view.error !== undefined,
    found: selected !== undefined,
  });
  const split = sessionsSplit(kind, selectedId, presence);
  const layout = splitLayout({ language, platformRtl: I18nManager.getConstants().isRTL });
  const paneDirection = { direction: layout.paneDirection };
  const clearSelection = useCallback(() => router.setParams({ id: undefined }), [router]);
  // Android's hardware Back on an inherited selection returns to the list,
  // like the back chip, instead of leaving the tab.
  usePhoneBack(split.showBack, clearSelection);

  useFocusEffect(
    useCallback(() => {
      setView(store.get());
      const unsubscribe = store.subscribe((next) => {
        setView(next);
        if (next.loading) loadingSeen.current = true;
        else if (loadingSeen.current) setListed(true);
      });
      store.focus();
      const unsubscribeHistory = historyStore.subscribe(setHistory);
      historyStore.open();
      setHistory(historyStore.get());
      const unsubscribeCounts = countsStore.subscribe(setCounts);
      countsStore.focus();
      setCounts(countsStore.get());
      // The "Asks:" line: the laptop reports a waiting question only when
      // asked, so this polls, and only while this screen is on.
      const unsubscribeHome = homeStore.subscribe(setHome);
      homeStore.focus({ capacity: false });
      setHome(homeStore.get());
      return () => {
        unsubscribe();
        store.blur();
        unsubscribeHistory();
        historyStore.close();
        unsubscribeCounts();
        countsStore.blur();
        unsubscribeHome();
        homeStore.blur();
      };
    }, [store, historyStore, countsStore, homeStore]),
  );

  // Wide has no Project chip, so a project filter set on the phone layout
  // would be invisible there: entering wide shows every project.
  useEffect(() => {
    if (!wide) return;
    setProject(undefined);
    setProjectsOpen(false);
  }, [wide]);

  // Web, wide: "/" focuses the search field unless typing somewhere already.
  // Only while focused: wide tabs stay mounted behind the others.
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused || !wide || Platform.OS !== "web" || typeof document === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      if (
        !isSearchHotkey({
          key: event.key,
          targetTag: target?.tagName,
          editable: target?.isContentEditable === true,
          modified: event.metaKey || event.ctrlKey || event.altKey,
        })
      ) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [focused, wide]);

  useEffect(() => {
    const handle = setTimeout(() => historyStore.search(query), SEARCH_DELAY_MS);
    return () => clearTimeout(handle);
  }, [historyStore, query]);

  const liveIds = rows
    .filter(
      (row) =>
        isActiveRow(row) &&
        // The wide pane's own SessionDetail already polls this session.
        !(wide && row.id === selectedId) &&
        row.origin !== "external" &&
        (row.state === "running" || row.state === "waiting"),
    )
    .map((row) => row.id);
  const liveKey = liveIds.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the id list's contents, not its identity.
  useEffect(() => {
    homeStore.setLiveSessions(liveIds);
  }, [homeStore, liveKey]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    // Pull-to-refresh asks the laptop to look again — re-import transcripts
    // and re-scan the process table for agents running outside Jarvis
    // (process-scan.ts) — never a plain re-list, which could only repeat
    // whatever the laptop already had before the pull.
    historyStore.refresh();
    void store.pullToRefresh().finally(() => setRefreshing(false));
  }, [store, historyStore]);

  const selectSession = useCallback(
    (row: MergedRow) => openSession(router, sessionTarget(kind, row.id, "sessions", row.source)),
    [router, kind],
  );

  const openNew = useCallback(() => {
    setNewError(undefined);
    setChoices(undefined);
    setNewOpen(true);
    void loadProjectChoices(client).then((loaded) =>
      setChoices(loaded.ok ? loaded.projects : null),
    );
  }, [client]);

  const pickProject = useCallback(
    async (name: string) => {
      setNewError(undefined);
      setNewBusy(true);
      const outcome = await openTerminal(client, name);
      setNewBusy(false);
      if (!outcome.ok) {
        setNewError(isMessageKey(outcome.text) ? t(language, outcome.text) : outcome.text);
        return;
      }
      setNewOpen(false);
      router.push({
        pathname: "/terminal/[paneKey]",
        params: { paneKey: outcome.tabId, tabId: outcome.tabId },
      });
    },
    [client, router, language],
  );

  const now = Date.now();
  const projects = projectsOf(rows);
  const chipCounts = statusCounts(rows, query, project);
  const shown = filterRows(rows, query, status, project);
  const groups = useMemo(() => groupByDay(shown, now), [shown, now]);

  // Wide opens on the first row (waiting first) rather than an empty pane.
  const firstId = firstOpenableRow(groups.flatMap((group) => group.rows))?.id;
  useEffect(() => {
    if (!focused || !wide || selectedId !== undefined || firstId === undefined) return;
    router.setParams({ id: firstId });
  }, [focused, wide, selectedId, firstId, router]);

  const renderRow = (row: MergedRow) => {
    const variant = rowVariant(row);
    const question =
      variant === "waiting" && !wide
        ? home.waiting.find((entry) => entry.sessionId === row.id)?.prompt.question
        : undefined;
    const resumeError = resumeErrors[row.id];
    return (
      <View key={row.id} style={styles.rowBox}>
        <SessionRow
          title={row.summary}
          subtitle={rowSubtitle(language, row)}
          time={rowTimeLabel(row, now)}
          variant={variant}
          {...(question === undefined ? {} : { asks: t(language, "sessions.asks", { question }) })}
          {...(rowCounts(row, counts) === undefined ? {} : { counts: rowCounts(row, counts) })}
          // A row outside Jarvis has no pty behind it — never navigate
          // into a terminal nothing is attached to.
          {...(row.origin === "external" ? {} : { onPress: () => selectSession(row) })}
          selected={wide && row.id === selectedId}
          {...(wide ? { density: "compact" as const } : {})}
          {...(resumable(row) && !wide
            ? {
                trailing: (
                  <ResumeButton
                    variant="inline"
                    sessionId={row.id}
                    project={row.project}
                    state={row.state}
                    onError={(text) => setResumeErrors((prev) => ({ ...prev, [row.id]: text }))}
                  />
                ),
              }
            : {})}
        />
        {!wide && resumeError !== undefined && (
          <Text selectable style={styles.error}>
            {resumeError}
          </Text>
        )}
      </View>
    );
  };

  const list = (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.content,
        wide ? styles.contentWide : { paddingTop: insets.top + 18 },
      ]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={handleRefresh}
          tintColor={theme.colors.primary}
        />
      }
    >
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={[styles.title, wide && styles.titleWide]}>
            {t(language, "sessions.title")}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={openNew}
            style={[styles.newButton, wide && styles.newButtonWide]}
          >
            {!wide && (
              <Icon name="plus" size={16} strokeWidth={2.6} color={theme.colors.primaryText} />
            )}
            <Text style={[styles.newText, wide && styles.newTextWide]}>
              {t(language, wide ? "sessions.newTitle" : "sessions.new")}
            </Text>
          </Pressable>
        </View>
        <View style={[styles.search, wide && styles.searchWide]}>
          <Icon name="search" size={wide ? 16 : 18} color={theme.colors.textMuted} />
          <TextInput
            ref={searchRef}
            value={query}
            onChangeText={setQuery}
            placeholder={t(
              language,
              wide && Platform.OS === "web" ? "sessions.searchHint" : "sessions.searchPlaceholder",
            )}
            placeholderTextColor={theme.colors.textDim}
            accessibilityLabel={t(language, "sessions.search")}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={[styles.searchInput, wide && styles.searchInputWide]}
          />
          {query !== "" && (
            <TouchableOpacity
              onPress={() => setQuery("")}
              accessibilityRole="button"
              accessibilityLabel={t(language, "sessions.clearSearch")}
              style={styles.clear}
            >
              <Icon name="close" size={16} color={theme.colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
        <ScrollView
          horizontal={!wide}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={wide ? styles.chipsWide : styles.chips}
          accessibilityRole="tablist"
        >
          {STATUS_CHIPS.map((chip) => {
            const on = status === chip.status;
            const amber = chip.status === "waiting" && chipCounts.waiting > 0;
            return (
              <TouchableOpacity
                key={chip.status}
                onPress={() => setStatus(chip.status)}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                style={[
                  styles.chip,
                  wide && styles.chipWide,
                  amber && styles.chipWaiting,
                  on && styles.chipOn,
                ]}
              >
                <Text
                  style={[
                    styles.chipText,
                    amber && styles.chipTextWaiting,
                    on && styles.chipTextOn,
                    wide && styles.chipTextWide,
                  ]}
                >
                  {t(language, chip.label)} {chipCounts[chip.status]}
                </Text>
              </TouchableOpacity>
            );
          })}
          {!wide && (projects.length > 0 || project !== undefined) && (
            <TouchableOpacity
              onPress={() => setProjectsOpen((open) => !open)}
              accessibilityRole="button"
              accessibilityState={{ expanded: projectsOpen }}
              style={[styles.chip, styles.chipWithIcon, project !== undefined && styles.chipOn]}
            >
              <Text style={[styles.chipText, project !== undefined && styles.chipTextOn]}>
                {project ?? t(language, "sessions.project")}
              </Text>
              <Icon
                name="chevronDown"
                size={14}
                color={
                  project !== undefined ? theme.colors.primaryText : theme.colors.textSecondary
                }
              />
            </TouchableOpacity>
          )}
        </ScrollView>
        {!wide && projectsOpen && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}
          >
            {[undefined, ...projects].map((name) => (
              <TouchableOpacity
                key={name ?? "all"}
                onPress={() => {
                  setProject(name);
                  setProjectsOpen(false);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: project === name }}
                style={[styles.chip, project === name && styles.chipOn]}
              >
                <Text style={[styles.chipText, project === name && styles.chipTextOn]}>
                  {name ?? t(language, "sessions.allProjects")}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>
      {rows.length === 0 ? (
        <Text style={styles.empty}>
          {t(language, view.loading || history.loading ? "history.loading" : "sessions.none")}
        </Text>
      ) : shown.length === 0 ? (
        <Text style={styles.empty}>{t(language, "sessions.noMatch")}</Text>
      ) : (
        groups.map((group: SessionDateGroup<MergedRow>, index) => (
          <Fragment key={group.rows[0]?.id ?? group.label.kind}>
            <Text style={[styles.sectionTitle, index > 0 && styles.sectionTitleNext]}>
              {dateGroupLabelText(group.label, language)}
            </Text>
            {group.rows.map(renderRow)}
          </Fragment>
        ))
      )}
      {history.more && rows.length > 0 && (
        <TouchableOpacity
          style={styles.more}
          accessibilityRole="button"
          disabled={history.loadingMore}
          onPress={() => historyStore.loadMore()}
        >
          <Text style={styles.moreText}>
            {t(language, history.loadingMore ? "history.loadingMore" : "sessions.loadMore")}
          </Text>
        </TouchableOpacity>
      )}

      {view.error?.kind === "remote" && <Text style={styles.error}>{view.error.text}</Text>}
      {history.notice !== undefined && (
        <Text selectable style={styles.error}>
          {history.notice}
        </Text>
      )}
    </ScrollView>
  );

  return (
    // Mirrored like the top bar: the container takes the reading direction
    // (a plain row, so native's forced RTL never flips it twice) and each
    // pane goes back to the platform's own direction.
    <View style={[styles.split, { direction: layout.direction }]}>
      {split.showList && (
        // Always wrapped, so a rotation never remounts the list either. The
        // pane, not the ScrollView, takes the width: on web the refresh
        // control repeats the ScrollView's style on an inner element.
        <View style={[wide ? { width: listWidth, flexShrink: 0 } : styles.fill, paneDirection]}>
          {list}
        </View>
      )}
      {wide && split.showList && <View style={styles.divider} />}
      {split.detailKey !== undefined && (
        <View style={[styles.detailPane, paneDirection, !wide && { paddingTop: insets.top }]}>
          {split.showBack && (
            <TouchableOpacity
              style={styles.back}
              onPress={clearSelection}
              accessibilityRole="button"
            >
              <Text style={styles.backText}>
                {language === "ar" ? "›" : "‹"} {t(language, "sessions.back")}
              </Text>
            </TouchableOpacity>
          )}
          {selected?.source === "history" ? (
            <TranscriptBody key={split.detailKey} id={split.detailKey} embedded />
          ) : (
            <SessionDetail key={split.detailKey} id={split.detailKey} embedded store={store} />
          )}
        </View>
      )}
      {split.showEmpty && (
        <View style={[styles.emptyPane, paneDirection]}>
          <Text style={styles.empty}>{t(language, "sessions.pick")}</Text>
        </View>
      )}
      <NewSessionSheet
        language={language}
        visible={newOpen}
        projects={choices}
        busy={newBusy}
        error={newError}
        onPick={(name) => void pickProject(name)}
        onAskJarvis={() => {
          setNewOpen(false);
          router.push("/voice");
        }}
        onClose={() => setNewOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  split: { flex: 1, flexDirection: "row", backgroundColor: theme.colors.background },
  fill: { flex: 1 },

  divider: { width: 1, backgroundColor: theme.colors.hairlineSoft },
  detailPane: { flex: 1, minWidth: 0 },
  emptyPane: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  back: { paddingHorizontal: 14, paddingVertical: 10, backgroundColor: theme.colors.ground },
  backText: { color: theme.colors.primary, fontFamily: theme.font.semibold, fontSize: 14 },
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    paddingHorizontal: theme.spacing.gutter,
    paddingBottom: 20,
    gap: 8,
  },
  contentWide: { paddingHorizontal: 16, paddingVertical: 20 },
  titleWide: { fontFamily: theme.font.extrabold, fontSize: 22, lineHeight: 28 },
  newButtonWide: { minHeight: 38, paddingHorizontal: 12, borderRadius: theme.radius.small },
  newTextWide: { fontSize: 13 },
  searchWide: { minHeight: 40, paddingHorizontal: 12, borderRadius: theme.radius.small },
  searchInputWide: { minHeight: 38, fontSize: 14 },
  chipsWide: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chipWide: { minHeight: 30, paddingHorizontal: 10 },
  chipTextWide: { fontSize: 12 },
  header: { gap: 12, paddingBottom: 4 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { ...theme.type.display, color: theme.colors.text },
  newButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    borderRadius: theme.radius.control,
    backgroundColor: theme.colors.accent,
  },
  newText: { ...theme.type.button, color: theme.colors.primaryText },
  search: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  searchInput: {
    flex: 1,
    minHeight: 44,
    color: theme.colors.text,
    fontFamily: theme.font.body,
    fontSize: 15,
  },
  clear: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  chips: { gap: 8, paddingVertical: 2 },
  chip: {
    minHeight: 36,
    paddingHorizontal: 14,
    justifyContent: "center",
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipWithIcon: { flexDirection: "row", alignItems: "center", gap: 4 },
  chipWaiting: {
    borderColor: theme.colors.warningBorder,
    backgroundColor: theme.colors.warningSurface,
  },
  chipOn: { borderColor: theme.colors.text, backgroundColor: theme.colors.text },
  chipText: { ...theme.type.chip, color: theme.colors.textSecondary },
  chipTextWaiting: { fontFamily: theme.font.bold, color: theme.colors.warning },
  chipTextOn: { ...theme.type.chipSelected, color: theme.colors.ground },
  sectionTitle: {
    ...theme.type.sectionLabel,
    color: theme.colors.textDim,
    marginTop: 6,
    marginBottom: 2,
  },
  sectionTitleNext: { marginTop: 10 },
  rowBox: { gap: 4 },
  more: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  moreText: { ...theme.type.button, fontSize: 13, color: theme.colors.accentText },
  empty: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.sm,
  },
  error: {
    color: theme.colors.danger,
    fontSize: theme.font.size.sm,
  },
});
