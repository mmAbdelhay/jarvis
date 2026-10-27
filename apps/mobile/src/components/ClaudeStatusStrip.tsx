import { Pressable, StyleSheet, Text, View } from "react-native";
import { Icon } from "@/components/Icon";
import { meterWidth, modeKey } from "@/lib/claude-chat";
import { type Language, type MessageKey, t } from "@/lib/i18n";
import { theme } from "@/lib/theme";
import type { ClaudeMode } from "@jarvis/wire";

/**
 * The chat view's strip under the header: Claude's mode (a tap sends
 * Shift+Tab, which cycles it), the model, and the account's session and
 * week meters. A meter with no value is left out.
 */
export function ClaudeStatusStrip(props: {
  language: Language;
  mode: ClaudeMode | undefined;
  model: string | undefined;
  sessionUsed: number | undefined;
  weekUsed: number | undefined;
  disabled: boolean;
  onMode(): void;
}) {
  const auto = props.mode === "auto";
  const mode = t(props.language, modeKey(props.mode));
  return (
    <View style={styles.strip}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(props.language, "claude.modeHint", { mode })}
        accessibilityState={{ disabled: props.disabled }}
        disabled={props.disabled}
        onPress={props.onMode}
        hitSlop={8}
        style={[styles.mode, auto && styles.modeAuto, props.disabled && styles.disabled]}
      >
        {auto && <Icon name="bolt" size={12} color={theme.colors.claudeWorking} />}
        <Text style={[styles.modeText, auto && styles.modeTextAuto]} numberOfLines={1}>
          {mode}
        </Text>
      </Pressable>
      {props.model !== undefined && (
        <Text style={styles.model} numberOfLines={1}>
          {props.model}
        </Text>
      )}
      <View style={styles.spacer} />
      {props.sessionUsed !== undefined && (
        <Meter
          language={props.language}
          letter="claude.sessionMeter"
          label="claude.sessionUsed"
          used={props.sessionUsed}
        />
      )}
      {props.weekUsed !== undefined && (
        <Meter
          language={props.language}
          letter="claude.weekMeter"
          label="claude.weekUsed"
          used={props.weekUsed}
        />
      )}
    </View>
  );
}

function Meter(props: { language: Language; letter: MessageKey; label: MessageKey; used: number }) {
  const width = meterWidth(props.used);
  return (
    <View
      style={styles.meter}
      accessible
      accessibilityLabel={t(props.language, props.label, { n: String(width) })}
    >
      <Text style={styles.meterText}>{t(props.language, props.letter)}</Text>
      <View style={styles.bar}>
        <View style={[styles.fill, { width: `${width}%` }]} />
      </View>
      <Text style={styles.meterText}>{width}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  mode: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    flexShrink: 1,
  },
  modeAuto: { borderColor: theme.colors.claudeWorkingBorder },
  disabled: { opacity: 0.5 },
  modeText: { ...theme.type.chip, fontSize: 12, color: theme.colors.textSecondary },
  modeTextAuto: { color: theme.colors.claudeWorking },
  model: { ...theme.type.chip, fontSize: 12, color: theme.colors.textMuted, flexShrink: 1 },
  spacer: { flex: 1 },
  meter: { flexDirection: "row", alignItems: "center", gap: 6 },
  meterText: { fontFamily: theme.font.monoSemibold, fontSize: 11, color: theme.colors.textMuted },
  bar: {
    width: 34,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.hairline,
    overflow: "hidden",
    flexDirection: "row",
  },
  fill: { backgroundColor: theme.colors.accent },
});
