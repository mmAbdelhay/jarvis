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
  View,
} from "react-native";
import { WidePanel } from "@/components/WidePanel";
import { WideShell } from "@/components/WideShell";
import { historyListDisplay } from "@/lib/history-screen";
import { createHistoryStore, type HistoryState } from "@/lib/history-store";
import { formatSessionElapsed } from "@/lib/format";
import { type Language, t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import { type SessionDateLabel, sessionDateLabel } from "@/lib/session-date-groups";
import { theme } from "@/lib/theme";

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
  return (
    <WideShell>
      <WidePanel title={t(language, "history.title")}>
        <HistoryScreen />
      </WidePanel>
    </WideShell>
  );
}

function HistoryScreen() {
  const language = useLanguage();
  const router = useRouter();
  const client = useRpcClient();
  const store = useMemo(() => createHistoryStore({ client }), [client]);
  const [view, setView] = useState<HistoryState>(store.get());
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
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

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refresh}
          tintColor={theme.colors.primary}
        />
      }
    >
      <View style={styles.search}>
        <Text style={styles.searchGlyph} accessibilityElementsHidden importantForAccessibility="no">
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
      {display.kind === "list" &&
        byDay(view.sessions, Date.now()).map((group) => (
          <View key={group.key} style={styles.list}>
            <Text style={styles.day}>{dayTitle(group.label, language)}</Text>
            {group.rows.map((session) => (
              <TouchableOpacity
                key={session.id}
                style={styles.row}
                accessibilityRole="button"
                onPress={() =>
                  router.push({ pathname: "/transcript/[id]", params: { id: session.id } })
                }
              >
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
                      Math.max(0, (session.endedAt ?? session.lastActivityAt) - session.startedAt),
                    ),
                  ]
                    .filter((part): part is string => part !== undefined && part !== "")
                    .join(" · ")}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        ))}
      {display.kind === "list" && view.more && (
        <TouchableOpacity
          style={styles.more}
          accessibilityRole="button"
          disabled={view.loadingMore}
          onPress={() => store.loadMore()}
        >
          <Text style={styles.moreText}>
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
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
