import { ScrollView, StyleSheet, Text, TouchableOpacity } from "react-native";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { KEY_CAPS, KEY_LABEL_KEYS } from "@/lib/session-screen";
import { KEY_BAR, type KeyName } from "@/lib/terminal-keys";
import { theme } from "@/lib/theme";

export function KeyBar(props: {
  disabled: boolean;
  armed: boolean;
  onKey(key: KeyName | "ctrl"): void;
}) {
  const language = useLanguage();
  return (
    <ScrollView horizontal style={styles.row} contentContainerStyle={styles.content}>
      {KEY_BAR.map((key) => (
        <TouchableOpacity
          key={key}
          disabled={props.disabled}
          accessibilityRole="button"
          accessibilityLabel={t(language, KEY_LABEL_KEYS[key])}
          accessibilityHint={
            key === "ctrl" && props.armed ? t(language, "session.ctrlArmed") : undefined
          }
          accessibilityState={{ disabled: props.disabled, selected: key === "ctrl" && props.armed }}
          onPress={() => props.onKey(key)}
          style={[
            styles.cap,
            key === "enter" && styles.enter,
            key === "ctrl" && props.armed && styles.armed,
            props.disabled && styles.disabled,
          ]}
        >
          <Text style={styles.text}>{KEY_CAPS[key]}</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: {
    flexGrow: 0,
    direction: "ltr",
    backgroundColor: theme.colors.ground,
    borderTopColor: theme.colors.hairlineSoft,
    borderTopWidth: 1,
  },
  content: { gap: 6, paddingVertical: 8, paddingHorizontal: 12 },
  cap: {
    height: 44,
    minWidth: 44,
    alignItems: "center",
    borderRadius: theme.radius.sm,
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
  },
  enter: {
    minWidth: 56,
    borderWidth: 1.5,
    borderColor: theme.colors.textSecondary,
    backgroundColor: theme.colors.ground,
  },
  armed: { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accent },
  disabled: { opacity: 0.4 },
  text: { color: theme.colors.textSecondary, fontFamily: theme.font.monoSemibold, fontSize: 12 },
});
