import { useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { t, type Language } from "@/lib/i18n";
import { theme } from "@/lib/theme";
import type { TerminalView } from "./TerminalWebView";

/**
 * Getting around a terminal's scrollback on a phone: jump to the previous
 * or next command (when the shell marks its prompts), back to the live
 * end once scrolled away from it, and find text in the output. Shown only
 * when one of those has something to do, or while finding.
 */
export function TerminalNavBar(props: {
  language: Language;
  view: TerminalView;
  finding: boolean;
  /** Whether the last find matched; undefined before any. */
  found: boolean | undefined;
  onJump(to: "latest" | "prevCommand" | "nextCommand"): void;
  onFind(query: string, direction: "next" | "prev"): void;
  onCloseFind(): void;
}) {
  const [query, setQuery] = useState("");
  const { language, view } = props;
  if (!props.finding && !view.back && !view.commands) return null;
  return (
    <View style={styles.bar}>
      {props.finding && (
        <View style={styles.findRow}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={() => query !== "" && props.onFind(query, "next")}
            placeholder={t(language, "terminal.findPlaceholder")}
            placeholderTextColor={theme.colors.textDim}
            accessibilityLabel={t(language, "terminal.find")}
            style={[styles.findInput, props.found === false && styles.findMissing]}
          />
          {(["prev", "next"] as const).map((direction) => (
            <TouchableOpacity
              key={direction}
              accessibilityRole="button"
              accessibilityLabel={t(
                language,
                direction === "next" ? "terminal.findNext" : "terminal.findPrev",
              )}
              disabled={query === ""}
              onPress={() => props.onFind(query, direction)}
              style={[styles.iconButton, query === "" && styles.disabled]}
            >
              <Text style={styles.iconText}>{direction === "next" ? "↓" : "↑"}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={t(language, "terminal.findClose")}
            onPress={props.onCloseFind}
            style={styles.iconButton}
          >
            <Text style={styles.iconText}>×</Text>
          </TouchableOpacity>
        </View>
      )}
      {(view.commands || view.back) && (
        <View style={styles.jumpRow}>
          {view.commands && (
            <>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => props.onJump("prevCommand")}
                style={styles.jump}
              >
                <Text style={styles.jumpText}>↑ {t(language, "terminal.prevCommand")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => props.onJump("nextCommand")}
                style={styles.jump}
              >
                <Text style={styles.jumpText}>↓ {t(language, "terminal.nextCommand")}</Text>
              </TouchableOpacity>
            </>
          )}
          {view.back && (
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => props.onJump("latest")}
              style={[styles.jump, styles.latest]}
            >
              <Text style={styles.latestText}>⤓ {t(language, "terminal.latest")}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      {props.finding && props.found === false && (
        <Text style={styles.missing}>{t(language, "terminal.findNone")}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.hairlineSoft,
    backgroundColor: theme.colors.ground,
  },
  findRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  findInput: {
    flex: 1,
    minHeight: 40,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    fontFamily: theme.font.mono,
    fontSize: 13,
  },
  findMissing: { borderColor: theme.colors.danger },
  iconButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  iconText: { color: theme.colors.textSecondary, fontSize: 16 },
  disabled: { opacity: 0.4 },
  jumpRow: { flexDirection: "row", gap: 6 },
  jump: {
    flex: 1,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  jumpText: { color: theme.colors.textSecondary, fontFamily: theme.font.bold, fontSize: 13 },
  latest: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
  latestText: { color: theme.colors.primaryText, fontFamily: theme.font.bold, fontSize: 13 },
  missing: { color: theme.colors.danger, fontFamily: theme.font.body, fontSize: 12 },
});
