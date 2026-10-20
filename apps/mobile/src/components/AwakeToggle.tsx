import { StyleSheet, Switch, Text, View } from "react-native";
import { awakeHintKey, type AwakeStatus } from "@/lib/awake-store";
import { type Language, t } from "@/lib/i18n";
import { theme } from "@/lib/theme";

/** Keep awake (Task 18): the laptop's stay-awake, one switch on Home. On
 *  means any mode but off; the hint says whether it is holding now. Drawn
 *  only once the laptop has answered. */
export function AwakeToggle(props: {
  language: Language;
  status: AwakeStatus | undefined;
  busy: boolean;
  onToggle(): void;
}) {
  const { status } = props;
  if (status === undefined) return null;
  const warn = status.simulateInput && status.inputState === "needs-permission";
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={styles.title}>{t(props.language, "awake.title")}</Text>
        <Text style={[styles.hint, warn && styles.hintWarn]}>
          {t(props.language, awakeHintKey(status))}
        </Text>
      </View>
      <Switch
        value={status.mode !== "off"}
        disabled={props.busy}
        accessibilityLabel={t(props.language, "awake.title")}
        onValueChange={props.onToggle}
        trackColor={{ true: status.active ? theme.colors.success : theme.colors.warning }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  text: { flex: 1, gap: 2 },
  title: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 14 },
  hint: { color: theme.colors.textMuted, fontFamily: theme.font.body, fontSize: 12 },
  hintWarn: { color: theme.colors.warningText },
});
