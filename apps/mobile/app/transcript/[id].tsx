import { useLocalSearchParams } from "expo-router";
import { StyleSheet, Text } from "react-native";
import { WidePanel } from "@/components/WidePanel";
import { WideShell } from "@/components/WideShell";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { theme } from "@/lib/theme";
import { TranscriptBody } from "@/screens/TranscriptView";

function routeId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Wide layout: drawn inside the shell as a centred panel (see history.tsx).
export default function TranscriptRoute() {
  const language = useLanguage();
  return (
    <WideShell>
      <WidePanel title={t(language, "history.transcript")}>
        <TranscriptScreen />
      </WidePanel>
    </WideShell>
  );
}

function TranscriptScreen() {
  const id = routeId(useLocalSearchParams().id);
  const language = useLanguage();
  if (id === undefined) return <Text style={styles.empty}>{t(language, "history.notFound")}</Text>;
  return <TranscriptBody id={id} />;
}

const styles = StyleSheet.create({
  empty: { color: theme.colors.textMuted, padding: theme.spacing.lg },
});
