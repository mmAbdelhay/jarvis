import { useMemo, useRef } from "react";
import { PanResponder, StyleSheet, Text, View } from "react-native";
import { t, type Language } from "@/lib/i18n";
import { type Arrow, arrowsFor } from "@/lib/arrow-pad";
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
    <View
      {...responder.panHandlers}
      accessible
      accessibilityLabel={t(props.language, "terminal.arrowPad")}
      style={[styles.pad, props.disabled && styles.disabled]}
    >
      <Text style={styles.hint}>← ↑ ↓ →</Text>
      <Text style={styles.caption}>{t(props.language, "terminal.arrowPadHint")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: {
    minHeight: 64,
    marginHorizontal: 10,
    marginBottom: 8,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.accentSoft,
    backgroundColor: theme.colors.surface,
    direction: "ltr",
  },
  disabled: { opacity: 0.4 },
  hint: { color: theme.colors.textSecondary, fontFamily: theme.font.monoSemibold, fontSize: 14 },
  caption: { color: theme.colors.textDim, fontFamily: theme.font.body, fontSize: 11 },
});
