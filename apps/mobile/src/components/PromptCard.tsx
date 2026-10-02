import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { PhonePrompt } from "@/lib/session-prompt";
import { theme } from "@/lib/theme";

/**
 * What the session is waiting on, above the compose bar: the agent's own
 * question, and one button per option it offers. The text is the agent's
 * — shown as written, in whatever language it wrote it — so it is laid out
 * by its own content direction rather than the app's.
 */
export function PromptCard(props: {
  prompt: PhonePrompt;
  busy: boolean;
  note: string | undefined;
  onAnswer(index: number, label: string): void;
}) {
  return (
    <View style={styles.card} accessibilityRole="summary">
      <Text style={styles.question}>{props.prompt.question}</Text>
      <View style={styles.options}>
        {props.prompt.options.map((label, index) => (
          <TouchableOpacity
            // The index is the option's identity: the laptop answers by it.
            // biome-ignore lint/suspicious/noArrayIndexKey: options are positional, and two may share a label.
            key={index}
            accessibilityRole="button"
            accessibilityState={{ disabled: props.busy }}
            disabled={props.busy}
            onPress={() => props.onAnswer(index, label)}
            style={[styles.option, props.busy && styles.disabled]}
          >
            <Text style={styles.optionText} numberOfLines={2}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {props.note !== undefined && <Text style={styles.note}>{props.note}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface,
  },
  question: { color: theme.colors.text, fontSize: 14, marginBottom: 8 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  option: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    maxWidth: "100%",
  },
  optionText: { color: theme.colors.text, fontSize: 13 },
  disabled: { opacity: 0.5 },
  note: { marginTop: 8, color: theme.colors.accentText, fontSize: 12 },
});
