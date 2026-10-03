import { useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { KEY_CAPS, KEY_LABEL_KEYS } from "@/lib/session-screen";
import type { Latches } from "@/lib/session-input";
import type { BarKey } from "@/lib/terminal-keys";
import { theme } from "@/lib/theme";

/**
 * A row of key caps. `moreKeys` hide behind a trailing "⋯" cap that opens a
 * second row, so a short bar loses no key. `variant="footer"` draws no
 * ground or border of its own: the screen's footer supplies them.
 */
export function KeyBar<K extends BarKey>(props: {
  keys: readonly K[];
  moreKeys?: readonly K[];
  disabled: boolean;
  armed: Latches;
  variant?: "footer";
  onKey(key: K): void;
}) {
  const language = useLanguage();
  const [open, setOpen] = useState(false);
  const footer = props.variant === "footer";
  const more = props.moreKeys ?? [];

  function cap(key: K) {
    const armed = key === "ctrl" ? props.armed.ctrl : key === "alt" ? props.armed.alt : false;
    return (
      <TouchableOpacity
        key={key}
        disabled={props.disabled}
        accessibilityRole="button"
        accessibilityLabel={t(language, KEY_LABEL_KEYS[key])}
        accessibilityHint={
          armed ? t(language, key === "ctrl" ? "session.ctrlArmed" : "session.altArmed") : undefined
        }
        accessibilityState={{ disabled: props.disabled, selected: armed }}
        onPress={() => props.onKey(key)}
        style={[styles.cap, armed && styles.armed, props.disabled && styles.disabled]}
      >
        <Text
          style={[
            styles.text,
            key === "ctrlC" && styles.danger,
            key === "ctrlR" && styles.link,
            armed && styles.armedText,
          ]}
        >
          {KEY_CAPS[key]}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={!footer && styles.frame}>
      <ScrollView
        horizontal
        style={styles.row}
        contentContainerStyle={footer ? styles.footerContent : styles.content}
      >
        {props.keys.map(cap)}
        {more.length > 0 && (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={t(language, open ? "keys.less" : "keys.more")}
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen((value) => !value)}
            style={[styles.cap, open && styles.open]}
          >
            <Text style={[styles.text, open && styles.openText]}>⋯</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
      {open && more.length > 0 && (
        <View style={[styles.moreRow, footer ? styles.footerMore : styles.moreInset]}>
          {more.map(cap)}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    direction: "ltr",
    backgroundColor: theme.colors.ground,
    borderTopColor: theme.colors.hairlineSoft,
    borderTopWidth: 1,
  },
  row: { flexGrow: 0, direction: "ltr" },
  content: { gap: 6, paddingVertical: 8, paddingHorizontal: 12 },
  footerContent: { gap: 6 },
  moreRow: { direction: "ltr", flexDirection: "row", flexWrap: "wrap", gap: 6 },
  moreInset: { paddingBottom: 8, paddingHorizontal: 12 },
  footerMore: { paddingTop: 6 },
  cap: {
    minHeight: 36,
    minWidth: 36,
    paddingHorizontal: 12,
    alignItems: "center",
    borderRadius: 9,
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
  },
  armed: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
  open: { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accentBorder },
  disabled: { opacity: 0.4 },
  text: { ...theme.type.mono, color: theme.colors.textSecondary },
  danger: { color: theme.colors.dangerText },
  link: { color: theme.colors.link },
  armedText: { color: theme.colors.primaryText },
  openText: { color: theme.colors.link },
});
