import { useFocusEffect, useRouter } from "expo-router";
import type { Session } from "@jarvis/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { ActionSheet } from "@/components/ActionSheet";
import { Icon } from "@/components/Icon";
import { WidePanel } from "@/components/WidePanel";
import { WideShell } from "@/components/WideShell";
import {
  agentsOf,
  filterHistory,
  historyListDisplay,
  historyRowSub,
  historyRowTime,
  projectsOf,
} from "@/lib/history-screen";
import { formatSessionElapsed } from "@/lib/format";
import { createHistoryStore, type HistoryState } from "@/lib/history-store";
import { type Language, t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import { type SessionDateLabel, sessionDateLabel } from "@/lib/session-date-groups";
import { theme } from "@/lib/theme";
import { useLayoutClass } from "@/lib/use-layout-class";
import { contentWidth, historyListWidth } from "@/lib/wide-breakpoints";
import { textDirection } from "@/lib/voice-screen";
import { TranscriptBody } from "@/screens/TranscriptView";

/** A search is sent once typing pauses, not on every key. */
const SEARCH_DELAY_MS = 300;

function dayTitle(label: SessionDateLabel, language: Language): string {
  if (label.kind === "today") return t(language, "sessions.today");
  if (label.kind === "yesterday") return t(language, "sessions.yesterday");
  return new Date(label.ms)
    .toLocaleDateString(language === "ar" ? "ar" : "en-US", { month: "short", day: "numeric" })
    .toUpperCase();
}

/** Consecutive sessions by the day of their last activity (the list is
 *  already newest first). */
function byDay(
  sessions: readonly Session[],
  now: number,
): { key: string; label: SessionDateLabel; rows: Session[] }[] {
  const groups: { key: string; label: SessionDateLabel; rows: Session[] }[] = [];
  for (const session of sessions) {
    const label = sessionDateLabel(session.lastActivityAt, now);
    const key = label.kind === "date" ? String(label.ms) : label.kind;
    const last = groups.at(-1);
    if (last !== undefined && last.key === key) last.rows.push(session);
    else groups.push({ key, label, rows: [session] });
  }
  return groups;
}

function timeOfDay(ms: number, language: Language): string {
  return new Date(ms).toLocaleTimeString(language === "ar" ? "ar" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Wide layout: a root stack screen, so it draws the WideShell itself and
// sits in a centred panel under the top bar (a phone gets the page as is).
export default function HistoryRoute() {
  const language = useLanguage();
  const layout = useLayoutClass();
  const { width: windowWidth } = useWindowDimensions();
  const listWidth = historyListWidth(contentWidth(windowWidth, layout.compact ? "rail" : "full"));
  const [selected, setSelected] = useState<string | undefined>(undefined);
  if (layout.kind === "wide") {
    // Wide: the list and the open transcript side by side, the way the
    // Sessions tab lays out a session — no navigating away to read one.
    return (
      <WideShell>
        <View style={[styles.split, { direction: textDirection(language) }]}>
          <View style={[styles.listPane, { width: listWidth, direction: textDirection(language) }]}>
            <HistoryScreen wide selectedId={selected} onOpen={setSelected} />
          </View>
          <View style={styles.divider} />
          <View style={[styles.detailPane, { direction: "ltr" }]}>
            {selected === undefined ? (
              <Text style={[styles.empty, styles.pick]}>{t(language, "history.pick")}</Text>
            ) : (
              <TranscriptBody key={selected} id={selected} embedded variant="chat" />
            )}
          </View>
        </View>
      </WideShell>
    );
  }
  return (
    <WideShell>
      <WidePanel title={t(language, "history.title")}>
        <HistoryScreen />
      </WidePanel>
    </WideShell>
  );
}

function HistoryScreen(props: {
  wide?: boolean;
  selectedId?: string;
  onOpen?: (id: string) => void;
}) {
  const wide = props.wide === true;
  const language = useLanguage();
  const router = useRouter();
  const client = useRpcClient();
  const store = useMemo(() => createHistoryStore({ client }), [client]);
  const [view, setView] = useState<HistoryState>(store.get());
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState<string | undefined>(undefined);
  const [agent, setAgent] = useState<string | undefined>(undefined);
  const [sheet, setSheet] = useState<"project" | "agent" | undefined>(undefined);
  useEffect(() => {
    const handle = setTimeout(() => store.search(query), SEARCH_DELAY_MS);
    return () => clearTimeout(handle);
  }, [store, query]);

  useFocusEffect(
    useCallback(() => {
      const unsubscribe = store.subscribe(setView);
      store.open();
      setView(store.get());
      return () => {
        unsubscribe();
        store.close();
      };
    }, [store]),
  );

  const refresh = useCallback(() => {
    setRefreshing(true);
    store.refresh();
    setTimeout(() => setRefreshing(false), 250);
  }, [store]);

  // Fix round 1 (Important 3): `sessions.length === 0` used to always mean
  // "No saved sessions." — including when a timeout or offline refusal was
  // why nothing loaded. `historyListDisplay` tells a real empty account
  // apart from a failed fetch (state.stale).
  const display = historyListDisplay(view, language);
  // Wide only: the project and agent filters narrow the loaded rows; the
  // search itself is still the server's.
  const shown = wide ? filterHistory(view.sessions, project, agent) : view.sessions;
  const filterActions = (
    kind: "project" | "agent",
  ): { key: string; label: string; onPress(): void }[] => {
    const all = kind === "project" ? projectsOf(view.sessions) : agentsOf(view.sessions);
    const set = kind === "project" ? setProject : setAgent;
    return [
      {
        key: "all",
        label: t(language, kind === "project" ? "history.allProjects" : "history.allAgents"),
        onPress: () => set(undefined),
      },
      ...all.map((name) => ({ key: name, label: name, onPress: () => set(name) })),
    ];
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={wide ? styles.wideContent : styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refresh}
          tintColor={theme.colors.primary}
        />
      }
    >
      {wide && <Text style={styles.wideTitle}>{t(language, "history.title")}</Text>}
      {wide ? (
        <View style={styles.filters}>
          <View style={styles.wideSearch}>
            <Icon name="search" size={16} color={theme.colors.textMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t(language, "history.searchPlaceholder")}
              placeholderTextColor={theme.colors.textDim}
              accessibilityLabel={t(language, "history.search")}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              style={styles.wideSearchInput}
            />
          </View>
          {(["project", "agent"] as const).map((kind) => {
            const value = kind === "project" ? project : agent;
            return (
              <TouchableOpacity
                key={kind}
                onPress={() => setSheet(kind)}
                accessibilityRole="button"
                accessibilityLabel={t(
                  language,
                  kind === "project" ? "history.projectFilter" : "history.agentFilter",
                )}
                style={styles.filterButton}
              >
                <Text style={styles.filterText} numberOfLines={1}>
                  {value ??
                    t(language, kind === "project" ? "history.allProjects" : "history.allAgents")}
                </Text>
                <Icon name="chevronDown" size={14} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            );
          })}
        </View>
      ) : (
        <View style={styles.search}>
          <Text
            style={styles.searchGlyph}
            accessibilityElementsHidden
            importantForAccessibility="no"
          >
            ⌕
          </Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t(language, "history.searchPlaceholder")}
            placeholderTextColor={theme.colors.textDim}
            accessibilityLabel={t(language, "history.search")}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={styles.searchInput}
          />
        </View>
      )}
      {display.kind === "loading" && (
        <Text style={styles.empty}>{t(language, "history.loading")}</Text>
      )}
      {display.kind === "empty" && <Text style={styles.empty}>{t(language, "history.empty")}</Text>}
      {display.kind === "failed" && (
        <View style={styles.failedBlock}>
          <Text selectable style={styles.error}>
            {display.text}
          </Text>
          <TouchableOpacity onPress={() => store.refresh()}>
            <Text style={styles.retry}>{t(language, "common.retry")}</Text>
          </TouchableOpacity>
        </View>
      )}
      {display.kind === "list" && shown.length === 0 && (
        <Text style={styles.empty}>{t(language, "history.empty")}</Text>
      )}
      {display.kind === "list" &&
        byDay(shown, Date.now()).map((group) => (
          <View key={group.key} style={wide ? styles.wideList : styles.list}>
            <Text style={styles.day}>{dayTitle(group.label, language)}</Text>
            {group.rows.map((session) => (
              <TouchableOpacity
                key={session.id}
                style={[
                  wide ? styles.wideRow : styles.row,
                  props.selectedId === session.id &&
                    (wide ? styles.wideRowSelected : styles.rowSelected),
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: props.selectedId === session.id }}
                onPress={() =>
                  props.onOpen !== undefined
                    ? props.onOpen(session.id)
                    : router.push({ pathname: "/transcript/[id]", params: { id: session.id } })
                }
              >
                {wide ? (
                  <>
                    <View style={styles.rowTop}>
                      <Text
                        style={[
                          styles.wideTitleText,
                          props.selectedId === session.id && styles.wideTitleOn,
                        ]}
                        numberOfLines={2}
                      >
                        {session.summary}
                      </Text>
                      <Text
                        style={[
                          styles.wideTime,
                          props.selectedId === session.id && styles.wideMetaOn,
                        ]}
                      >
                        {historyRowTime(session)}
                      </Text>
                    </View>
                    <Text
                      style={[styles.wideSub, props.selectedId === session.id && styles.wideMetaOn]}
                      numberOfLines={1}
                    >
                      {historyRowSub(session, t(language, "sessions.imported"))}
                    </Text>
                  </>
                ) : (
                  <>
                    <View style={styles.rowTop}>
                      <Text style={styles.title} numberOfLines={2}>
                        {session.summary}
                      </Text>
                      <Text style={styles.time}>{timeOfDay(session.lastActivityAt, language)}</Text>
                    </View>
                    <Text style={styles.meta} numberOfLines={1}>
                      {[
                        session.project ?? undefined,
                        session.agentId,
                        formatSessionElapsed(
                          Math.max(
                            0,
                            (session.endedAt ?? session.lastActivityAt) - session.startedAt,
                          ),
                        ),
                      ]
                        .filter((part): part is string => part !== undefined && part !== "")
                        .join(" · ")}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            ))}
          </View>
        ))}
      {display.kind === "list" && view.more && (
        <TouchableOpacity
          style={wide ? styles.wideMore : styles.more}
          accessibilityRole="button"
          disabled={view.loadingMore}
          onPress={() => store.loadMore()}
        >
          <Text style={wide ? styles.wideMoreText : styles.moreText}>
            {t(language, view.loadingMore ? "history.loadingMore" : "history.loadMore")}
          </Text>
        </TouchableOpacity>
      )}
      {display.kind === "list" && view.stale && view.notice === undefined && (
        <Text style={styles.empty}>{t(language, "common.stale")}</Text>
      )}
      {display.kind === "list" && view.notice && (
        <Text selectable style={styles.error}>
          {view.notice}
        </Text>
      )}
      {wide && sheet !== undefined && (
        <ActionSheet
          visible
          title={t(language, sheet === "project" ? "history.projectFilter" : "history.agentFilter")}
          actions={filterActions(sheet)}
          onClose={() => setSheet(undefined)}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  split: { flex: 1, flexDirection: "row", backgroundColor: theme.colors.background },
  listPane: { flexShrink: 0 },
  wideTitle: { color: theme.colors.text, fontFamily: theme.font.extrabold, fontSize: 22 },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  wideSearch: {
    flexGrow: 1,
    flexBasis: 200,
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: theme.radius.small,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  wideSearchInput: {
    flex: 1,
    minHeight: 38,
    color: theme.colors.text,
    fontFamily: theme.font.body,
    fontSize: 14,
  },
  filterButton: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    borderRadius: theme.radius.small,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  filterText: { color: theme.colors.textSecondary, fontFamily: theme.font.semibold, fontSize: 13 },
  wideList: { gap: 4 },
  wideRow: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: theme.radius.small,
    borderWidth: 1,
    borderColor: "transparent",
    gap: 4,
  },
  wideRowSelected: {
    borderColor: theme.colors.accentBorder,
    backgroundColor: theme.colors.surfaceAlt,
  },
  wideTitleText: {
    flexShrink: 1,
    color: theme.colors.textSecondary,
    fontFamily: theme.font.semibold,
    fontSize: 14,
  },
  wideTitleOn: { color: theme.colors.text, fontFamily: theme.font.bold },
  wideTime: { color: theme.colors.textDim, fontFamily: theme.font.body, fontSize: 12 },
  wideSub: { color: theme.colors.textDim, fontFamily: theme.font.body, fontSize: 12 },
  wideMetaOn: { color: theme.colors.textMuted },
  wideMore: {
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.small,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  wideMoreText: { color: theme.colors.accentText, fontFamily: theme.font.bold, fontSize: 13 },
  divider: { width: 1, backgroundColor: theme.colors.hairlineSoft },
  detailPane: { flex: 1, minWidth: 0 },
  pick: { padding: theme.spacing.xl },
  rowSelected: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surfaceAlt },
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
  wideContent: { paddingVertical: 20, paddingHorizontal: 16, gap: 12 },
  list: { gap: theme.spacing.sm },
  row: {
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  rowTop: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing.sm },
  title: {
    flexShrink: 1,
    color: theme.colors.text,
    fontFamily: theme.font.semibold,
    fontSize: theme.font.size.md,
  },
  time: { color: theme.colors.textDim, fontFamily: theme.font.body, fontSize: 12 },
  meta: {
    color: theme.colors.textMuted,
    fontFamily: theme.font.body,
    fontSize: theme.font.size.sm,
  },
  day: {
    marginTop: theme.spacing.sm,
    color: theme.colors.textDim,
    fontFamily: theme.font.bold,
    fontSize: 12,
    letterSpacing: 0.6,
  },
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
  searchGlyph: { color: theme.colors.textMuted, fontSize: 18 },
  searchInput: {
    flex: 1,
    minHeight: 44,
    color: theme.colors.text,
    fontFamily: theme.font.body,
    fontSize: 15,
  },
  more: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  moreText: { color: theme.colors.accentText, fontFamily: theme.font.bold, fontSize: 13 },
  empty: { color: theme.colors.textMuted },
  error: { color: theme.colors.danger },
  failedBlock: { gap: theme.spacing.xs },
  retry: { color: theme.colors.primary, fontWeight: theme.font.weight.bold },
});
