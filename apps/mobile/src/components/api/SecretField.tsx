// A masked text field for a secret value (Behaviour rule 5): an
// environment variable marked `secret`, a bearer token, a basic-auth
// password, an apikey value. Masked by default; a tap on "reveal" shows the
// literal text, never logged or written anywhere else on its own.
import { useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { t } from "@/lib/i18n";
import type { Language } from "@/lib/i18n";
import { theme } from "@/lib/theme";

const MASK = "••••••••";

export function SecretField(props: {
  value: string;
  onChangeText?: (text: string) => void;
  editable?: boolean;
  secret: boolean;
  language: Language;
  placeholder?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const showMask = props.secret && !revealed;

  if (!props.secret) {
    return (
      <TextInput
        style={styles.input}
        value={props.value}
        onChangeText={props.onChangeText}
        editable={props.editable ?? true}
        placeholder={props.placeholder}
        placeholderTextColor={theme.colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
      />
    );
  }

  return (
    <View style={styles.row}>
      {showMask ? (
        <Text style={[styles.input, styles.masked]} selectable={false}>
          {props.value.length > 0 ? MASK : ""}
        </Text>
      ) : (
        <TextInput
          style={styles.input}
          value={props.value}
          onChangeText={props.onChangeText}
          editable={props.editable ?? true}
          placeholder={props.placeholder}
          placeholderTextColor={theme.colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={false}
        />
      )}
      <TouchableOpacity
        style={styles.revealButton}
        onPress={() => setRevealed((value) => !value)}
        accessibilityRole="button"
      >
        <Text style={styles.revealText}>
          {t(props.language, revealed ? "api.secret.hide" : "api.secret.reveal")}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm },
  input: {
    flex: 1,
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    borderColor: theme.colors.border,
    borderWidth: 1,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  masked: { color: theme.colors.textMuted },
  revealButton: { paddingHorizontal: theme.spacing.sm, paddingVertical: theme.spacing.xs },
  revealText: { color: theme.colors.primary, fontSize: theme.font.size.sm },
});
