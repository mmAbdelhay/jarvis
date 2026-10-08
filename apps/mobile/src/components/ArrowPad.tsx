import { useMemo, useRef } from "react";
import { PanResponder, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { t, type Language } from "@/lib/i18n";
import { type Arrow, arrowsFor } from "@/lib/arrow-pad";
import { KEY_CAPS, KEY_LABEL_KEYS } from "@/lib/session-screen";
import { theme } from "@/lib/theme";

/**
 * A pad to drag a thumb across instead of tapping four small arrow keys:
 * moving the cursor through a line, or through an agent's menu, is one
 * gesture. Arrows are laid out as on a keyboard whatever the reading
 * direction — they are terminal keys, not navigation.
 */
export function ArrowPad(props: {
  language: Language;
  disabled: boolean;
  onArrow(arrow: Arrow): void;
  /** The ⌫ and ⏎ column beside the pad. */
  onKey(key: "backspace" | "enter"): void;
}) {
  const sent = useRef({ x: 0, y: 0 });
  const onArrow = useRef(props.onArrow);
  onArrow.current = props.onArrow;
  const disabled = useRef(props.disabled);
  disabled.current = props.disabled;
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled.current,
        onMoveShouldSetPanResponder: () => !disabled.current,
        onPanResponderGrant: () => {
          sent.current = { x: 0, y: 0 };
        },
        onPanResponderMove: (_event, gesture) => {
          const { arrows, used } = arrowsFor(
            gesture.dx - sent.current.x,
            gesture.dy - sent.current.y,
          );
          sent.current = { x: sent.current.x + used.x, y: sent.current.y + used.y };
          for (const arrow of arrows) onArrow.current(arrow);
        },
      }),
    [],
  );
  return (
    <View style={styles.row}>
      <View
        {...responder.panHandlers}
        accessible
        accessibilityLabel={t(props.language, "terminal.arrowPad")}
        style={[styles.pad, props.disabled && styles.disabled]}
      >
        <Text style={[styles.arrow, styles.up]}>↑</Text>
        <Text style={[styles.arrow, styles.down]}>↓</Text>
        <Text style={[styles.arrow, styles.start]}>←</Text>
        <Text style={[styles.arrow, styles.end]}>→</Text>
        <View style={styles.center}>
          <View style={styles.knob} />
          <Text style={styles.caption}>{t(props.language, "terminal.arrowPadHint")}</Text>
        </View>
      </View>
      <View style={styles.column}>
        {(["backspace", "enter"] as const).map((key) => (
          <TouchableOpacity
            key={key}
            disabled={props.disabled}
            accessibilityRole="button"
            accessibilityLabel={t(props.language, KEY_LABEL_KEYS[key])}
            onPress={() => props.onKey(key)}
            style={[styles.key, key === "enter" && styles.enter, props.disabled && styles.disabled]}
          >
            <Text style={[styles.keyText, key === "enter" && styles.enterText]}>
              {KEY_CAPS[key]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8, alignItems: "stretch", direction: "ltr" },
  pad: {
    flex: 1,
    minHeight: 92,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.accentBorder,
    backgroundColor: theme.colors.surface,
    direction: "ltr",
  },
  disabled: { opacity: 0.4 },
  arrow: { position: "absolute", color: theme.colors.textMuted, fontSize: 14 },
  up: { top: 6 },
  down: { bottom: 6 },
  start: { insetInlineStart: 10 },
  end: { insetInlineEnd: 10 },
  center: { alignItems: "center", gap: 4 },
  knob: {
    width: 28,
    height: 28,
    borderRadius: theme.radius.full,
    borderWidth: 2,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.selected,
  },
  caption: { ...theme.type.meta, color: theme.colors.textDim, fontFamily: theme.font.semibold },
  column: { width: 92, gap: 8 },
  key: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  enter: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
  keyText: { color: theme.colors.textSecondary, fontFamily: theme.font.mono, fontSize: 14 },
  enterText: { color: theme.colors.primaryText, fontFamily: theme.font.monoSemibold },
});
