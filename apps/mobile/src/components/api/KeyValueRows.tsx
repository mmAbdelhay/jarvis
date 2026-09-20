// An editable name/value list (Behaviour rule 1: headers, query params,
// form-urlencoded rows, ad-hoc variables). Each row toggles enabled, edits
// its own name/value, and can be removed; a trailing "add" row appends an
// empty one. Purely a controlled view over the array the caller owns —
// no store access, no network.
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { t } from "@/lib/i18n";
import type { Language } from "@/lib/i18n";
import { theme } from "@/lib/theme";
import { SecretField } from "./SecretField";

export type KeyValueRow = {
  name: string;
  value: string;
  enabled: boolean;
  secret?: boolean;
  /** Fix round 1 (I4): Bruno's own `params[].type` ("query" | "path") —
   *  carried through untouched by every update here (the `{ ...row,
   *  ...patch }` spread below never drops a field the caller put on a
   *  row), so a params row this component didn't originate from never
   *  loses it on save. */
  type?: string;
};

export function KeyValueRows(props: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  language: Language;
  addLabel: string;
}) {
  function updateRow(index: number, patch: Partial<KeyValueRow>): void {
    const next = props.rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
    props.onChange(next);
  }

  function removeRow(index: number): void {
    props.onChange(props.rows.filter((_, i) => i !== index));
  }

  function addRow(): void {
    props.onChange([...props.rows, { name: "", value: "", enabled: true }]);
  }

  return (
    <View style={styles.list}>
      {props.rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id of their own; index is fine for a locally-owned, append/remove-only list.
        <View key={index} style={styles.row}>
          <TouchableOpacity
            style={[styles.toggle, row.enabled ? styles.toggleOn : undefined]}
            onPress={() => updateRow(index, { enabled: !row.enabled })}
            accessibilityRole="button"
          />
          <TextInput
            style={styles.nameInput}
            value={row.name}
            onChangeText={(name) => updateRow(index, { name })}
            placeholder={t(props.language, "api.kv.name")}
            placeholderTextColor={theme.colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.valueWrap}>
            <SecretField
              value={row.value}
              onChangeText={(value) => updateRow(index, { value })}
              secret={row.secret === true}
              language={props.language}
              placeholder={t(props.language, "api.kv.value")}
            />
          </View>
          <TouchableOpacity onPress={() => removeRow(index)} accessibilityRole="button">
            <Text style={styles.remove}>{t(props.language, "api.kv.remove")}</Text>
          </TouchableOpacity>
        </View>
      ))}
      <TouchableOpacity style={styles.addButton} onPress={addRow} accessibilityRole="button">
        <Text style={styles.addText}>{props.addLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: theme.spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing.xs },
  toggle: {
    width: 18,
    height: 18,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  toggleOn: { backgroundColor: theme.colors.primary },
  nameInput: {
    width: 96,
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    borderColor: theme.colors.border,
    borderWidth: 1,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  valueWrap: { flex: 1 },
  remove: { color: theme.colors.danger, fontSize: theme.font.size.sm },
  addButton: { alignSelf: "flex-start", paddingVertical: theme.spacing.xs },
  addText: { color: theme.colors.primary, fontSize: theme.font.size.sm },
});
