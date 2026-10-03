import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "@/lib/theme";

const styles = StyleSheet.create({
  card: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 380,
    gap: 12,
    padding: 18,
    borderRadius: theme.radius.card16,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  title: { color: theme.colors.text, fontFamily: theme.font.extrabold, fontSize: 15 },
});

/** The wide Settings card's frame, shared by the cards that wrap existing sections. */
export const SETTINGS_CARD = styles.card;
export const SETTINGS_CARD_TITLE = styles.title;

/** A wide Settings card: a heading over its content. */
export function SettingsCard(props: { title: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}
