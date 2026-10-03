import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { PhonePrompt } from "@/lib/session-prompt";
import { theme } from "@/lib/theme";

/**
 * What a session is waiting on: the agent's own question, and one button per
 * option it offers, numbered as the agent numbers them. The text is the
 * agent's — shown as written, in whatever language it wrote it — so it is
 * laid out by its own content direction rather than the app's.
 *
 * On the session screen it sits above the compose bar; on Home it carries a
 * `heading` (which session is asking) and an Open button.
 */
export function PromptCard(props: {
  prompt: PhonePrompt;
  busy: boolean;
  note: string | undefined;
  onAnswer(index: number, label: string): void;
  /** The card's label line: "WAITING FOR YOU", or Home's session line. */
  heading: string;
  /** Home only: the session it belongs to. */
  context?: string;
  open?: { label: string; onPress(): void };
  /** "row": one row of equal buttons without numbers (Home, two options or
   *  fewer); "stacked" (default): one numbered button per line. */
  layout?: "row" | "stacked";
}) {
  const row = props.layout === "row";
  return (
    <View style={styles.card} accessibilityRole="summary">
      <View style={styles.top}>
        <View style={styles.headingRow}>
          <View style={styles.dot} />
          <Text style={styles.heading}>{props.heading}</Text>
        </View>
        {props.context !== undefined && (
          <Text style={styles.context} numberOfLines={1}>
            {props.context}
          </Text>
        )}
      </View>
      <Text style={styles.question}>{props.prompt.question}</Text>
      <View style={row ? styles.optionsRow : styles.options}>
        {props.prompt.options.map((label, index) => (
          <TouchableOpacity
            // The index is the option's identity: the laptop answers by it.
            // biome-ignore lint/suspicious/noArrayIndexKey: options are positional, and two may share a label.
            key={index}
            accessibilityRole="button"
            accessibilityState={{ disabled: props.busy }}
            disabled={props.busy}
            onPress={() => props.onAnswer(index, label)}
            style={[
              styles.option,
              row && styles.optionRow,
              index === 0 ? styles.optionFirst : undefined,
              props.busy && styles.disabled,
            ]}
          >
            {!row && (
              <Text style={[styles.number, index === 0 && styles.numberFirst]}>{index + 1}</Text>
            )}
            <Text
              style={[
                styles.optionText,
                row && styles.optionTextRow,
                index === 0 && styles.optionTextFirst,
              ]}
              numberOfLines={2}
            >
              {label}
            </Text>
          </TouchableOpacity>
        ))}
        {props.open !== undefined && (
          <TouchableOpacity
            accessibilityRole="button"
            onPress={props.open.onPress}
            style={[styles.option, row && styles.optionRow, styles.openButton]}
          >
            <Text style={[styles.optionText, row && styles.optionTextRow]}>{props.open.label}</Text>
          </TouchableOpacity>
        )}
      </View>
      {props.note !== undefined && <Text style={styles.note}>{props.note}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 14,
    gap: 10,
    borderRadius: theme.radius.card + 2,
    borderWidth: 1,
    borderColor: theme.colors.warningBorder,
    backgroundColor: theme.colors.warningSurface,
  },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  headingRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 999, backgroundColor: theme.colors.warning },
  heading: {
    color: theme.colors.warning,
    fontFamily: theme.font.bold,
    fontSize: 12,
    letterSpacing: 0.6,
  },
  context: {
    flexShrink: 1,
    color: theme.colors.warningMuted,
    fontFamily: theme.font.body,
    fontSize: 12,
  },
  question: {
    color: theme.colors.text,
    fontFamily: theme.font.semibold,
    fontSize: 15,
    lineHeight: 21,
  },
  options: { gap: 6 },
  optionsRow: { flexDirection: "row", gap: 8 },
  option: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.warningBorder,
  },
  optionFirst: { backgroundColor: theme.colors.warning, borderColor: theme.colors.warning },
  optionRow: { flex: 1, minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
  openButton: { justifyContent: "center" },
  number: { color: theme.colors.warningMuted, fontFamily: theme.font.mono, fontSize: 12 },
  numberFirst: { color: theme.colors.onWarning },
  optionText: {
    flexShrink: 1,
    color: theme.colors.warningText,
    fontFamily: theme.font.semibold,
    fontSize: 14,
  },
  optionTextRow: { textAlign: "center" },
  optionTextFirst: { color: theme.colors.onWarning, fontFamily: theme.font.bold },
  disabled: { opacity: 0.5 },
  note: { color: theme.colors.warningText, fontFamily: theme.font.body, fontSize: 12 },
});
