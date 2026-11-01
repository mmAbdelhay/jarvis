import { Pressable, StyleSheet, Text, View } from "react-native";
import { type Language, t } from "@/lib/i18n";
import { theme } from "@/lib/theme";
import type { ClaudePrompt } from "@jarvis/wire";

/**
 * What Claude is asking right now, above the compose bar: the question as
 * the pane shows it and one 48-dp button per option, numbered as Claude
 * numbers them, the first one primary. Every button is off while an answer
 * is on its way. Claude's text is laid out left to right, as written.
 */
export function ClaudePromptCard(props: {
  language: Language;
  prompt: ClaudePrompt;
  answering: boolean;
  onAnswer(index: number, label: string): void;
}) {
  return (
    <View
      style={styles.card}
      accessibilityRole="summary"
      accessibilityLabel={t(props.language, "claude.asking")}
    >
      <Text style={styles.heading}>{t(props.language, "claude.asking")}</Text>
      <Text style={styles.question}>{props.prompt.question}</Text>
      {props.prompt.options.map((option, index) => {
        const primary = index === 0;
        return (
          <Pressable
            // biome-ignore lint/suspicious/noArrayIndexKey: options are positional, and two may share a label.
            key={index}
            accessibilityRole="button"
            accessibilityState={{ disabled: props.answering }}
            disabled={props.answering}
            onPress={() => props.onAnswer(index, option.label)}
            style={[styles.option, primary && styles.primary, props.answering && styles.disabled]}
          >
            <View style={[styles.number, primary && styles.numberPrimary]}>
              <Text style={[styles.numberText, primary && styles.primaryText]}>{index + 1}</Text>
            </View>
            <Text style={[styles.label, primary && styles.primaryText]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    direction: "ltr",
    marginHorizontal: 12,
    marginBottom: 10,
    padding: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    borderRadius: theme.radius.card16,
    backgroundColor: theme.colors.claudeAskGround,
  },
  heading: { ...theme.type.sectionLabel, color: theme.colors.accent },
  question: {
    fontFamily: theme.font.semibold,
    fontSize: 15,
    lineHeight: 21,
    color: theme.colors.text,
  },
  option: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  primary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
  disabled: { opacity: 0.5 },
  number: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.textMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  numberPrimary: { borderColor: theme.colors.primaryText },
  numberText: { fontFamily: theme.font.monoSemibold, fontSize: 12, color: theme.colors.text },
  label: { flex: 1, fontFamily: theme.font.semibold, fontSize: 14, color: theme.colors.text },
  primaryText: { color: theme.colors.primaryText },
});
