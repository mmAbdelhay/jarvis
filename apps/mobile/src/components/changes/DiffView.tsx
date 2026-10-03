import type { GitFileDiff } from "@jarvis/core";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { diffRows } from "@/lib/changes-screen";
import { type Language, t } from "@/lib/i18n";
import { theme } from "@/lib/theme";

/** One file's diff: a hunk header row (with the path), then its lines on
 *  tinted grounds, no line numbers. Forced LTR like the terminal: a diff's
 *  markers and monospace content must not be bidi reordered under Arabic. */
export function DiffView(props: { language: Language; diff: GitFileDiff }) {
  const { diff, language } = props;
  const rows = diffRows(diff);
  return (
    <View style={styles.block}>
      {diff.binary && <Text style={styles.note}>{t(language, "changes.binary")}</Text>}
      {diff.tooLarge && <Text style={styles.note}>{t(language, "changes.tooLarge")}</Text>}
      {!diff.binary && !diff.tooLarge && (
        <ScrollView horizontal>
          <View style={styles.diffContent}>
            {rows.map((row, index) => (
              <View
                key={row.key}
                style={[
                  styles.row,
                  row.kind === "hunk" && styles.hunkRow,
                  row.kind === "added" && styles.addedRow,
                  row.kind === "removed" && styles.removedRow,
                  index === rows.length - 1 && styles.lastRow,
                ]}
              >
                {row.kind === "hunk" ? (
                  <Text selectable style={[styles.hunkText, { writingDirection: "ltr" }]}>
                    {row.text}
                  </Text>
                ) : (
                  <Text
                    selectable
                    style={[
                      styles.lineText,
                      { writingDirection: "ltr" },
                      row.kind === "added" && styles.addedText,
                      row.kind === "removed" && styles.removedText,
                    ]}
                  >
                    {row.text}
                  </Text>
                )}
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairlineSoft,
    backgroundColor: theme.colors.terminalGround,
    overflow: "hidden",
  },
  note: { ...theme.type.body, color: theme.colors.textMuted, padding: 12 },
  diffContent: { minWidth: "100%", direction: "ltr" },
  row: { paddingHorizontal: 12 },
  hunkRow: { paddingVertical: 6, backgroundColor: theme.colors.surfaceDim },
  addedRow: { backgroundColor: theme.colors.diffAddGround },
  removedRow: { backgroundColor: theme.colors.dangerSurface },
  lastRow: { paddingBottom: 6 },
  hunkText: { ...theme.type.mono, fontSize: 11.5, lineHeight: 19, color: theme.colors.accentText },
  lineText: {
    ...theme.type.mono,
    fontSize: 11.5,
    lineHeight: 19,
    color: theme.colors.textSecondary,
  },
  addedText: { color: theme.colors.diffAddText },
  removedText: { color: theme.colors.dangerText },
});
