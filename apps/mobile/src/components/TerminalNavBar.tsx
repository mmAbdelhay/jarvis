import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Icon } from "@/components/Icon";
import { IconButton } from "@/components/IconButton";
import { t, type Language } from "@/lib/i18n";
import { theme } from "@/lib/theme";

/**
 * Stepping through find matches in a terminal's scrollback on a phone. The
 * find field itself sits in the screen header (TerminalFindField); previous
 * / next command are icon caps in the key bar, and the way back to the live
 * end floats over the output (TerminalLatestPill). Shown only while finding.
 */
export function TerminalNavBar(props: {
  language: Language;
  finding: boolean;
  /** The text being found; the field in the header owns it. */
  query: string;
  /** Whether the last find matched; undefined before any. */
  found: boolean | undefined;
  onFind(query: string, direction: "next" | "prev"): void;
  onCloseFind(): void;
}) {
  const { language } = props;
  if (!props.finding) return null;
  return (
    <View style={styles.bar}>
      <View style={styles.findRow}>
        {(["prev", "next"] as const).map((direction) => (
          <TouchableOpacity
            key={direction}
            accessibilityRole="button"
            accessibilityLabel={t(
              language,
              direction === "next" ? "terminal.findNext" : "terminal.findPrev",
            )}
            disabled={props.query === ""}
            onPress={() => props.onFind(props.query, direction)}
            style={[styles.jump, props.query === "" && styles.disabled]}
          >
            <Icon
              name={direction === "next" ? "chevronDown" : "chevronUp"}
              size={14}
              color={theme.colors.textSecondary}
              strokeWidth={2.4}
            />
            <Text style={styles.jumpText}>
              {t(language, direction === "next" ? "terminal.findNext" : "terminal.findPrev")}
            </Text>
          </TouchableOpacity>
        ))}
        <IconButton
          icon="close"
          size={40}
          iconSize={16}
          label={t(language, "terminal.findClose")}
          onPress={props.onCloseFind}
        />
      </View>
      {props.found === false && (
        <Text style={styles.missing}>{t(language, "terminal.findNone")}</Text>
      )}
    </View>
  );
}

/** The find field in the screen header: 150 wide, a search icon, the query. */
export function TerminalFindField(props: {
  language: Language;
  value: string;
  found: boolean | undefined;
  onChange(value: string): void;
  onSubmit(): void;
}) {
  return (
    <View style={[styles.field, props.found === false && styles.fieldMissing]}>
      <Icon name="search" size={14} color={theme.colors.textMuted} strokeWidth={2.2} />
      <TextInput
        value={props.value}
        onChangeText={props.onChange}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={props.onSubmit}
        placeholder={t(props.language, "terminal.findPlaceholder")}
        placeholderTextColor={theme.colors.textDim}
        accessibilityLabel={t(props.language, "terminal.find")}
        style={styles.fieldInput}
      />
    </View>
  );
}

/** "Latest": a small chip floating at the output's bottom corner, once
 *  scrolled away from the live end — over the output, not under it. */
export function TerminalLatestPill(props: { language: Language; onPress(): void }) {
  return (
    <View pointerEvents="box-none" style={styles.pillLayer}>
      <TouchableOpacity accessibilityRole="button" onPress={props.onPress} style={styles.pill}>
        <Icon name="arrowDown" size={12} color={theme.colors.primaryText} strokeWidth={2.6} />
        <Text style={styles.pillText}>{t(props.language, "terminal.latest")}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.hairlineSoft,
    backgroundColor: theme.colors.ground,
  },
  findRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  disabled: { opacity: 0.4 },
  jump: {
    flex: 1,
    minHeight: 40,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.small,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  jumpText: { color: theme.colors.textSecondary, fontFamily: theme.font.bold, fontSize: 13 },
  missing: { color: theme.colors.dangerText, fontFamily: theme.font.body, fontSize: 12 },
  field: {
    width: 150,
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: theme.radius.small,
    borderWidth: 1,
    borderColor: theme.colors.accentBorder,
    backgroundColor: theme.colors.surface,
  },
  fieldMissing: { borderColor: theme.colors.danger },
  fieldInput: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    color: theme.colors.text,
    fontFamily: theme.font.mono,
    fontSize: 12,
  },
  pillLayer: { position: "absolute", bottom: 10, insetInlineEnd: 10 },
  pill: {
    minHeight: 28,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.accent,
  },
  pillText: { color: theme.colors.primaryText, fontFamily: theme.font.extrabold, fontSize: 12 },
});
