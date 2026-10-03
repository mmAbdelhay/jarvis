import { Pressable, StyleSheet, Text, View } from "react-native";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { theme } from "@/lib/theme";
import type { PlanProgressView, PlanStep } from "@/plan/plan-progress";

/**
 * The wide Session aside's plan card: progress and the plan's steps (done
 * struck through, the current one bright). Tapping it opens the plan sheet.
 */
export function PlanSummaryCard(props: {
  progress: PlanProgressView | undefined;
  steps: PlanStep[];
  onPress(): void;
}) {
  const language = useLanguage();
  const { progress } = props;
  const fraction = progress === undefined ? 0 : progress.done / progress.total;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(language, "plans.openPlan")}
      onPress={props.onPress}
      style={styles.card}
    >
      <View style={styles.top}>
        <Text style={styles.heading}>{t(language, "plans.stripTitle")}</Text>
        {progress !== undefined && (
          <Text style={styles.count}>
            {t(language, "plans.ofTotal", { done: progress.done, total: progress.total })}
          </Text>
        )}
      </View>
      {progress !== undefined && (
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${Math.round(fraction * 100)}%` }]} />
        </View>
      )}
      {props.steps.map((step, index) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: two steps may share text; the list is positional.
          key={index}
          style={[
            styles.step,
            step.state === "done" && styles.stepDone,
            step.state === "current" && styles.stepCurrent,
          ]}
        >
          {step.text}
        </Text>
      ))}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 14,
    gap: 8,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  heading: {
    color: theme.colors.textDim,
    fontFamily: theme.font.bold,
    fontSize: 12,
    letterSpacing: 0.6,
  },
  count: { color: theme.colors.textMuted, fontFamily: theme.font.body, fontSize: 12 },
  track: {
    height: 6,
    overflow: "hidden",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.ringTrack,
  },
  fill: { height: 6, borderRadius: theme.radius.full, backgroundColor: theme.colors.success },
  step: { color: theme.colors.textSecondary, fontFamily: theme.font.body, fontSize: 13 },
  stepDone: { color: theme.colors.textDim, textDecorationLine: "line-through" },
  stepCurrent: { color: theme.colors.text, fontFamily: theme.font.semibold },
});
