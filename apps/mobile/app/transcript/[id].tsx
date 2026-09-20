import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { transcriptDisplay, withLrmPrefixes } from "@/lib/history-screen";
import { createHistoryStore, type HistoryState } from "@/lib/history-store";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import { theme } from "@/lib/theme";

function routeId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export default function TranscriptScreen() {
  const id = routeId(useLocalSearchParams().id);
  const language = useLanguage();
  if (id === undefined) return <Text style={styles.empty}>{t(language, "history.notFound")}</Text>;
  return <TranscriptBody id={id} />;
}

function TranscriptBody({ id }: { id: string }) {
  const language = useLanguage();
  const client = useRpcClient();
  const store = useMemo(() => createHistoryStore({ client }), [client]);
  const [view, setView] = useState<HistoryState>(store.get());
  const [refreshing, setRefreshing] = useState(false);

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

  useEffect(() => {
    if (view.sessions.some((session) => session.id === id) && view.selectedId !== id) {
      store.select(id);
    }
  }, [id, store, view.sessions, view.selectedId]);

  const selected = view.sessions.find((session) => session.id === id);

  const refresh = useCallback(() => {
    setRefreshing(true);
    store.refresh();
    setTimeout(() => setRefreshing(false), 250);
  }, [store]);

  // Fix round 1 (Important 3): distinguishes "genuinely no such session",
  // "genuinely empty transcript", "still loading" and "the fetch failed" —
  // before this, a `session:transcript` timeout left `transcript: []` with
  // `loading: false`, which rendered the same "No transcript entries."
  // copy as a real empty transcript, and a `history:list` failure before
  // any session loaded rendered a false "Session not found."
  const display = transcriptDisplay(view, id, language);

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
      <Stack.Screen options={{ title: selected?.summary ?? t(language, "history.transcript") }} />
      {display.kind === "loading" && (
        <Text style={styles.empty}>{t(language, "history.loading")}</Text>
      )}
      {display.kind === "notFound" && (
        <Text style={styles.empty}>{t(language, "history.notFound")}</Text>
      )}
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
      {display.kind === "empty" && (
        <Text style={styles.empty}>{t(language, "history.emptyTranscript")}</Text>
      )}
      {display.kind === "entries" && (
        <View style={styles.list}>
          {view.transcript.map((entry, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: entries carry no id; the list is replaced wholesale per selection, never reordered or spliced.
            <View key={`${entry.role}:${index}`} style={styles.turn}>
              <Text style={styles.role}>
                {entry.role === "user"
                  ? t(language, "history.user")
                  : t(language, "history.assistant")}
              </Text>
              {entry.text !== "" && (
                // M12 Task 8, rule 10: a transcript entry carries no
                // per-turn language tag (unlike TurnList.tsx's voice
                // turns) — each line is prefixed with U+200E when the UI
                // is RTL and that line is LTR code/diff content, instead
                // of the iOS-only `writingDirection` style (history-
                // screen.ts's `withLrmPrefixes`).
                <Text selectable style={styles.body}>
                  {withLrmPrefixes(entry.text, language)}
                </Text>
              )}
              {entry.tools.length > 0 && (
                <Text selectable style={styles.tools}>
                  {entry.tools.join(", ")}
                </Text>
              )}
            </View>
          ))}
        </View>
      )}
      {display.kind === "entries" && view.notice && (
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
  list: { gap: theme.spacing.md },
  turn: {
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  role: { color: theme.colors.primary, fontWeight: theme.font.weight.bold },
  body: { color: theme.colors.text, lineHeight: 22 },
  tools: { color: theme.colors.textMuted, fontSize: theme.font.size.sm },
  empty: { color: theme.colors.textMuted, padding: theme.spacing.lg },
  error: { color: theme.colors.danger },
  failedBlock: { gap: theme.spacing.xs, padding: theme.spacing.lg },
  retry: { color: theme.colors.primary, fontWeight: theme.font.weight.bold },
});
