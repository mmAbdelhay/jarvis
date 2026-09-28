// The connection-state banner (Task 6, rule 2): renders nothing when the
// connection is `open` and not stale; otherwise one bilingual line, mounted
// once in `_layout.tsx` above the `Stack` so every screen shows it.
//
// M11 (task-5-brief.md rule 5): a latched pin mismatch also shows a "Pair
// again" button. `bannerModel` (banner-model.ts) is the pure, tested
// decision of which key and whether that button shows — this file stays
// layout: it only renders the model and confirms the tap with a native
// dialog (lib/dialog) before calling `onPairAgain`.
import { useEffect, useState } from "react";
import { Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { dialogs } from "@/lib/dialog";
import { bannerModel } from "@/lib/banner-model";
import type { ConnectionStore, ConnectionView } from "@/lib/connection-store";
import { clientPlatformFor } from "@/lib/client-platform";
import { platformKey, t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { theme } from "@/lib/theme";

export function ConnectionBanner({
  store,
  onRetry,
  onPairAgain,
}: {
  store: ConnectionStore;
  onRetry: () => void;
  onPairAgain: () => void;
}) {
  const language = useLanguage();
  const [view, setView] = useState<ConnectionView>(store.get());

  useEffect(() => store.subscribe(setView), [store]);

  const model = bannerModel(view);
  if (model === undefined) {
    return null;
  }

  function confirmPairAgain(): void {
    dialogs.confirm({
      title: t(language, "conn.pairAgainConfirmTitle"),
      message: t(language, "conn.pairAgainConfirmBody"),
      cancelText: t(language, "common.cancel"),
      confirmText: t(language, "common.ok"),
      destructive: true,
      onConfirm: onPairAgain,
    });
  }

  const content = (
    <>
      <Text style={styles.text}>
        {t(language, platformKey(model.key, clientPlatformFor(Platform.OS)))}
      </Text>
      {view.state === "closed" && <Text style={styles.retry}>{t(language, "common.retry")}</Text>}
      {model.pairAgain && (
        <TouchableOpacity onPress={confirmPairAgain}>
          <Text style={styles.retry}>{t(language, "conn.pairAgain")}</Text>
        </TouchableOpacity>
      )}
    </>
  );

  // N6: the copy says "Tap to retry" — make the whole banner the tap
  // target while it's showing that copy, not just the small "Retry" word,
  // instead of the two disagreeing.
  if (view.state === "closed") {
    return (
      <TouchableOpacity style={styles.banner} onPress={onRetry}>
        {content}
      </TouchableOpacity>
    );
  }

  return <View style={styles.banner}>{content}</View>;
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.sm,
    backgroundColor: theme.colors.surfaceAlt,
    borderBottomColor: theme.colors.border,
    borderBottomWidth: 1,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
  },
  text: {
    color: theme.colors.text,
    fontSize: theme.font.size.sm,
    textAlign: "center",
  },
  retry: {
    color: theme.colors.primary,
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.bold,
  },
});
