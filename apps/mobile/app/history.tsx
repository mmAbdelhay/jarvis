import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { historyListDisplay } from "@/lib/history-screen";
import { createHistoryStore, type HistoryState } from "@/lib/history-store";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import { theme } from "@/lib/theme";

export default function HistoryScreen() {
  const language = useLanguage();
  const router = useRouter();
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
      {display.kind === "list" && (
        <View style={styles.list}>
          {view.sessions.map((session) => (
            <TouchableOpacity
              key={session.id}
              style={styles.row}
              onPress={() =>
                router.push({ pathname: "/transcript/[id]", params: { id: session.id } })
              }
            >
              <Text style={styles.title}>{session.summary}</Text>
              <Text style={styles.meta}>{session.project}</Text>
            </TouchableOpacity>
          ))}
        </View>
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
  title: { color: theme.colors.text, fontSize: theme.font.size.md },
  meta: { color: theme.colors.textMuted, fontSize: theme.font.size.sm },
  empty: { color: theme.colors.textMuted },
  error: { color: theme.colors.danger },
  failedBlock: { gap: theme.spacing.xs },
  retry: { color: theme.colors.primary, fontWeight: theme.font.weight.bold },
});
