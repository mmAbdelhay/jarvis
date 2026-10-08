import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Icon } from "@/components/Icon";
import { IconButton } from "@/components/IconButton";
import { t, type Language } from "@/lib/i18n";
import { theme } from "@/lib/theme";
import type { TerminalView } from "./TerminalWebView";

/**
 * Getting around a terminal's scrollback: step through find matches and —
 * given `jumps` (the wide layout) — jump to the previous or next command
 * when the shell marks its prompts. The find field itself sits in the
 * screen header (TerminalFindField); the phone has previous / next command
 * as icon caps in its key bar instead. The way back to the live end floats
 * over the output (TerminalLatestPill). Shown only when one of those has
 * something to do.
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
  jumps?: { view: TerminalView; onJump(to: "prevCommand" | "nextCommand"): void };
}) {
  const { language, jumps } = props;
  if (!props.finding && !jumps?.view.commands) return null;
  return (
    <View style={styles.bar}>
      {props.finding && (
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
      )}
      {jumps?.view.commands && (
        <View style={styles.jumpRow}>
          {(["prevCommand", "nextCommand"] as const).map((to) => (
            <TouchableOpacity
              key={to}
              accessibilityRole="button"
              onPress={() => jumps.onJump(to)}
              style={styles.jump}
            >
              <Icon
                name={to === "prevCommand" ? "chevronUp" : "chevronDown"}
                size={14}
                color={theme.colors.textSecondary}
                strokeWidth={2.4}
              />
              <Text style={styles.jumpText}>
                {t(
                  language,
                  to === "prevCommand" ? "terminal.prevCommand" : "terminal.nextCommand",
                )}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      {props.finding && props.found === false && (
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

/** "Latest": floats over the output once scrolled away from the live end —
 *  centred, or (`compact`, the phone) a small chip in the bottom corner. */
export function TerminalLatestPill(props: {
  language: Language;
  compact?: boolean;
  onPress(): void;
}) {
  const compact = props.compact === true;
  return (
    <View pointerEvents="box-none" style={compact ? styles.chipLayer : styles.pillLayer}>
      <TouchableOpacity
        accessibilityRole="button"
        onPress={props.onPress}
        style={[styles.pill, compact && styles.chip]}
      >
        <Icon
          name="arrowDown"
          size={compact ? 12 : 14}
          color={theme.colors.primaryText}
          strokeWidth={2.6}
        />
        <Text style={[styles.pillText, compact && styles.chipText]}>
          {t(props.language, "terminal.latest")}
        </Text>
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
  jumpRow: { flexDirection: "row", gap: 6 },
  pillLayer: {
    position: "absolute",
    bottom: 14,
    insetInlineStart: 0,
    insetInlineEnd: 0,
    alignItems: "center",
  },
  chipLayer: { position: "absolute", bottom: 10, insetInlineEnd: 10 },
  pill: {
    minHeight: 40,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.accent,
  },
  chip: { minHeight: 28, paddingHorizontal: 10, gap: 4 },
  pillText: { color: theme.colors.primaryText, fontFamily: theme.font.extrabold, fontSize: 13 },
  chipText: { fontSize: 12 },
});
