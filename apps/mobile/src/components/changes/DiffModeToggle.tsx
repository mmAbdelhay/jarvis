import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { type Language, t } from "@/lib/i18n";
import type { DiffMode } from "@/lib/prefs";
import { theme } from "@/lib/theme";

/** The wide diff header's "Unified / Split" switch. */
export function DiffModeToggle(props: {
  language: Language;
  mode: DiffMode;
  onChange(mode: DiffMode): void;
}) {
  const modes: { key: DiffMode; label: string }[] = [
    { key: "unified", label: t(props.language, "changes.unified") },
    { key: "split", label: t(props.language, "changes.split") },
  ];
  return (
    <View
      style={styles.group}
      accessibilityRole="tablist"
      accessibilityLabel={t(props.language, "changes.diffView")}
    >
      {modes.map((mode) => {
        const on = props.mode === mode.key;
        return (
          <TouchableOpacity
            key={mode.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={[styles.button, on && styles.buttonOn]}
            onPress={() => props.onChange(mode.key)}
          >
            <Text style={[styles.label, on && styles.labelOn]}>{mode.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    flexDirection: "row",
    gap: 4,
    padding: 3,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surface,
  },
  button: {
    minHeight: 30,
    paddingHorizontal: 12,
    justifyContent: "center",
    borderRadius: 8,
  },
  buttonOn: { backgroundColor: theme.colors.selected },
  label: { fontFamily: theme.font.semibold, fontSize: 12, color: theme.colors.textMuted },
  labelOn: { fontFamily: theme.font.bold, color: theme.colors.text },
});
