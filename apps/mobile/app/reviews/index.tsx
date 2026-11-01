import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { ReviewCard } from "@/components/ReviewsSection";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SegmentTabs } from "@/components/SegmentTabs";
import { WidePanel } from "@/components/WidePanel";
import { WideShell } from "@/components/WideShell";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import {
  createReviewsStore,
  type ReviewsState,
  reviewRoute,
  sortReviewItems,
} from "@/lib/reviews-store";
import { useRpcClient } from "@/lib/rpc-context";
import { theme } from "@/lib/theme";
import { useLayoutClass } from "@/lib/use-layout-class";

type Tab = "mine" | "review-requested";

// The PRs the laptop watches, split into the user's own and the ones they
// were asked to review. A card opens the PR's thread.
export default function ReviewsRoute() {
  const language = useLanguage();
  const router = useRouter();
  const client = useRpcClient();
  const wide = useLayoutClass().kind === "wide";
  const store = useMemo(() => createReviewsStore({ client }), [client]);
  const [state, setState] = useState<ReviewsState>({ ...store.state });
  const [tab, setTab] = useState<Tab>("mine");
  const [refreshing, setRefreshing] = useState(false);
  useFocusEffect(
    useCallback(() => {
      const unsubscribe = store.subscribe(() => setState({ ...store.state }));
      void store.load();
      return unsubscribe;
    }, [store]),
  );
  const refresh = useCallback(() => {
    setRefreshing(true);
    void store.load().finally(() => setRefreshing(false));
  }, [store]);
  const items = state.items ?? [];
  const mine = items.filter((item) => item.pr.role === "mine");
  const requests = items.filter((item) => item.pr.role === "review-requested");
  const shown = sortReviewItems(tab === "mine" ? mine : requests);
  const now = Date.now();
  return (
    <WideShell>
      <WidePanel title={t(language, "reviews.title")}>
        <View style={styles.root}>
          {!wide && (
            <ScreenHeader
              title={t(language, "reviews.title")}
              size="page"
              bordered={false}
              onBack={router.canGoBack() ? router.back : undefined}
            />
          )}
          <ScrollView
            contentContainerStyle={styles.content}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={refresh}
                tintColor={theme.colors.accent}
              />
            }
          >
            <SegmentTabs
              label={t(language, "reviews.tabs")}
              tabs={[
                {
                  key: "mine",
                  label: `${t(language, "reviews.myPrs")} · ${mine.length}`,
                  selected: tab === "mine",
                  onPress: () => setTab("mine"),
                },
                {
                  key: "requests",
                  label: `${t(language, "reviews.requests")} · ${requests.length}`,
                  selected: tab === "review-requested",
                  onPress: () => setTab("review-requested"),
                },
              ]}
            />
            {state.error?.code === "loadFailed" && (
              <Text style={styles.error}>{t(language, "reviews.loadFailed")}</Text>
            )}
            {state.items !== undefined && shown.length === 0 && (
              <Text style={styles.empty}>
                {t(language, tab === "mine" ? "reviews.noPrs" : "reviews.noRequests")}
              </Text>
            )}
            {shown.map((item) => (
              <ReviewCard
                key={item.key}
                language={language}
                item={item}
                now={now}
                onPress={() => router.push(reviewRoute(item.key))}
              />
            ))}
          </ScrollView>
        </View>
      </WidePanel>
    </WideShell>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.ground },
  content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24, gap: 12 },
  error: { ...theme.type.body, color: theme.colors.danger },
  empty: { ...theme.type.body, color: theme.colors.textMuted },
});
