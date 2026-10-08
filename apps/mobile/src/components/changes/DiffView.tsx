import type { GitFileDiff } from "@jarvis/core";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  diffRows,
  gutterNumber,
  numberedDiffRows,
  type SplitSide,
  splitDiffRows,
} from "@/lib/changes-screen";
import { type Language, t } from "@/lib/i18n";
import type { DiffMode } from "@/lib/prefs";
import { theme } from "@/lib/theme";

/** One file's diff: a hunk header row (with the path), then its lines on
 *  tinted grounds, no line numbers. Forced LTR like the terminal: a diff's
 *  markers and monospace content must not be bidi reordered under Arabic. */
export function DiffView(props: {
  language: Language;
  diff: GitFileDiff;
  /** "wide": 13/22 text with a line-number gutter, unified or split. */
  density?: "phone" | "wide";
  mode?: DiffMode;
}) {
  const { diff, language } = props;
  if (props.density === "wide") {
    return <WideDiff language={language} diff={diff} mode={props.mode ?? "unified"} />;
  }
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

const MARKERS = { added: "+", removed: "-", context: " " } as const;

function WideDiff(props: { language: Language; diff: GitFileDiff; mode: DiffMode }) {
  const { diff, language } = props;
  const body = (() => {
    if (diff.binary || diff.tooLarge) return null;
    if (props.mode === "split") {
      const rows = splitDiffRows(diff);
      return (
        <View style={styles.diffContent}>
          {rows.map((row) =>
            row.kind === "hunk" ? (
              <View key={row.key} style={styles.wideHunkRow}>
                <Text selectable style={[styles.wideHunkText, { writingDirection: "ltr" }]}>
                  {row.text}
                </Text>
              </View>
            ) : (
              <View key={row.key} style={styles.pair}>
                <SplitCell side={row.left} />
                <SplitCell side={row.right} divided />
              </View>
            ),
          )}
        </View>
      );
    }
    const rows = numberedDiffRows(diff);
    return (
      <ScrollView horizontal>
        <View style={styles.diffContent}>
          {rows.map((row) =>
            row.kind === "hunk" ? (
              <View key={row.key} style={styles.wideHunkRow}>
                <Text selectable style={[styles.wideHunkText, { writingDirection: "ltr" }]}>
                  {row.text}
                </Text>
              </View>
            ) : (
              <View
                key={row.key}
                style={[
                  styles.wideRow,
                  row.kind === "added" && styles.addedRow,
                  row.kind === "removed" && styles.removedRow,
                ]}
              >
                <Text
                  selectable
                  style={[
                    styles.wideLine,
                    { writingDirection: "ltr" },
                    row.kind === "added" && styles.addedText,
                    row.kind === "removed" && styles.removedText,
                  ]}
                >
                  {`${gutterNumber(row.number)} ${MARKERS[row.kind]} ${row.text}`}
                </Text>
              </View>
            ),
          )}
        </View>
      </ScrollView>
    );
  })();
  return (
    <View style={styles.block}>
      {diff.binary && <Text style={styles.note}>{t(language, "changes.binary")}</Text>}
      {diff.tooLarge && <Text style={styles.note}>{t(language, "changes.tooLarge")}</Text>}
      {body}
    </View>
  );
}

function SplitCell(props: { side: SplitSide | undefined; divided?: boolean }) {
  const { side } = props;
  return (
    <View
      style={[
        styles.cell,
        props.divided && styles.cellDivided,
        side?.kind === "added" && styles.addedRow,
        side?.kind === "removed" && styles.removedRow,
      ]}
    >
      {side !== undefined && (
        <Text
          selectable
          style={[
            styles.wideLine,
            { writingDirection: "ltr" },
            side.kind === "added" && styles.addedText,
            side.kind === "removed" && styles.removedText,
          ]}
        >
          {`${gutterNumber(side.number)} ${MARKERS[side.kind]} ${side.text}`}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wideHunkRow: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    backgroundColor: theme.colors.surfaceDim,
  },
  wideHunkText: {
    ...theme.type.mono,
    fontSize: 13,
    lineHeight: 22,
    color: theme.colors.accentText,
  },
  wideLine: {
    ...theme.type.mono,
    fontSize: 13,
    lineHeight: 22,
    color: theme.colors.textSecondary,
  },
  wideRow: { paddingHorizontal: 14 },
  pair: { flexDirection: "row" },
  cell: { flex: 1, paddingHorizontal: 14 },
  cellDivided: { borderStartWidth: 1, borderStartColor: theme.colors.hairlineSoft },
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
