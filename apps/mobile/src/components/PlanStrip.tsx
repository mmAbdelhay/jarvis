import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Icon } from "@/components/Icon";
import { ProgressRing } from "@/components/ProgressRing";
import { t, type Language } from "@/lib/i18n";
import { theme } from "@/lib/theme";
import type { PlanProgressView } from "@/plan/plan-progress";

/**
 * The plan, always in view above the terminal's keys: how far along it is,
 * the step it is on, and how many notes wait to be sent. Tapping it opens
 * the plan sheet. Drawn only when there is a plan to show.
 */
export function PlanStrip(props: {
  language: Language;
  progress: PlanProgressView | undefined;
  step: string | undefined;
  queuedNotes: number;
  onOpen(): void;
}) {
  const { progress } = props;
  const fraction = progress === undefined ? 0 : progress.done / progress.total;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={t(props.language, "plans.openPlan")}
      onPress={props.onOpen}
      style={styles.strip}
    >
      {progress !== undefined && <ProgressRing fraction={fraction} size={34} />}
      <View style={styles.text}>
        <Text style={styles.kicker}>
          {progress === undefined
            ? t(props.language, "plans.stripTitle")
            : t(props.language, "plans.stripProgress", {
                done: progress.done,
                total: progress.total,
              })}
        </Text>
        <Text style={styles.step} numberOfLines={1}>
          {props.step === undefined
            ? t(props.language, "plans.stripOpen")
            : t(props.language, "plans.stripNow", { step: props.step })}
        </Text>
      </View>
      {props.queuedNotes > 0 && (
        <Text style={styles.notes}>
          {t(props.language, "plans.notesCount", { count: props.queuedNotes })}
        </Text>
      )}
      <Icon name="chevronUp" size={16} color={theme.colors.textMuted} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  strip: {
    marginHorizontal: 10,
    marginBottom: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  text: { flex: 1, minWidth: 0, gap: 2 },
  kicker: {
    color: theme.colors.textDim,
    fontFamily: theme.font.bold,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  step: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 14 },
  notes: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: "hidden",
    color: theme.colors.accentText,
    backgroundColor: theme.colors.accentSoft,
    fontFamily: theme.font.bold,
    fontSize: 12,
  },
});
