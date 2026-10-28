// Settings → Updates: the installed version, the newest one, Check now and
// (Android only) Update. The phone-update store decides everything; this
// only draws update-view.ts's words and passes the presses back.
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { Language } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { usePhoneUpdate, usePhoneUpdateStore } from "@/lib/phone-update-context";
import { theme } from "@/lib/theme";
import { updateCardView } from "@/lib/update-view";

export function UpdatesSection(props: { language: Language }): React.JSX.Element {
  const store = usePhoneUpdateStore();
  const card = updateCardView(usePhoneUpdate(), props.language);
  const [notesOpen, setNotesOpen] = useState(false);

  return (
    <View style={styles.card}>
      <Text style={styles.cardLine}>{card.installed}</Text>
      {card.newest !== undefined && <Text style={styles.cardLine}>{card.newest}</Text>}
      {card.lastChecked !== undefined && <Text style={styles.cardLine}>{card.lastChecked}</Text>}
      {card.status !== undefined && <Text style={styles.status}>{card.status}</Text>}
      {card.notes !== undefined && (
        <>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => setNotesOpen((open) => !open)}
            style={styles.notesToggle}
          >
            <Text style={styles.notesToggleText}>
              {t(props.language, notesOpen ? "updates.hideNotes" : "updates.showNotes")}
            </Text>
          </TouchableOpacity>
          {notesOpen && <Text style={styles.notes}>{card.notes}</Text>}
        </>
      )}
      {card.progress !== undefined && (
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${Math.round(card.progress * 100)}%` }]} />
        </View>
      )}
      <View style={styles.row}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ disabled: card.check.disabled }}
          disabled={card.check.disabled}
          style={[styles.secondary, card.check.disabled && styles.disabled]}
          onPress={() => void store.check()}
        >
          <Text style={styles.secondaryText}>{card.check.label}</Text>
        </TouchableOpacity>
        {card.update !== undefined && (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ disabled: card.update.disabled }}
            disabled={card.update.disabled}
            style={[styles.primary, card.update.disabled && styles.disabled]}
            onPress={() => void store.update()}
          >
            <Text style={styles.primaryText}>{card.update.label}</Text>
          </TouchableOpacity>
        )}
      </View>
      {card.error !== undefined && <Text style={styles.errorText}>{card.error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderWidth: 1,
    borderRadius: theme.radius.card,
    padding: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  cardLine: { color: theme.colors.textDim, fontFamily: theme.font.mono, fontSize: 11 },
  status: { color: theme.colors.textMuted, fontSize: theme.font.size.sm },
  notesToggle: { minHeight: 32, justifyContent: "center", alignSelf: "flex-start" },
  notesToggleText: { color: theme.colors.accentText, fontSize: theme.font.size.sm },
  notes: { color: theme.colors.textSecondary, fontSize: theme.font.size.sm },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.hairline,
    overflow: "hidden",
    marginTop: theme.spacing.xs,
  },
  fill: { height: 6, backgroundColor: theme.colors.primary },
  row: { flexDirection: "row", gap: theme.spacing.sm, marginTop: theme.spacing.xs },
  secondary: {
    flex: 1,
    minHeight: 44,
    borderRadius: theme.radius.small,
    borderColor: theme.colors.border,
    borderWidth: 1,
    paddingHorizontal: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  secondaryText: {
    color: theme.colors.text,
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.medium,
  },
  primary: {
    flex: 1,
    minHeight: 44,
    borderRadius: theme.radius.small,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  primaryText: {
    color: theme.colors.primaryText,
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.medium,
  },
  disabled: { opacity: 0.5 },
  errorText: { color: theme.colors.danger, fontSize: theme.font.size.sm },
});
