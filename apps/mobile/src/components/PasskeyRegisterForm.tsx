// "Add a passkey" (browser build, Task 13b): the label (defaults to the
// browser's name, editable), the owner password re-entered (the laptop
// re-checks it), then the browser's create sheet. Used by the unlock
// screen's after-pairing offer and by Settings. The flow and its outcomes
// live in passkey-registration.ts; this is layout and wiring.
import { useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { t } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { passkeys } from "@/lib/passkey";
import { passkeyLabel, registerPasskey } from "@/lib/passkey-registration";
import { useRpcClient } from "@/lib/rpc-context";
import { theme } from "@/lib/theme";
import { registerMessageKey } from "@/lib/unlock-screen";
import { deviceNameFromUserAgent } from "@/lib/web-pairing";

const DEFAULT_LABEL =
  typeof navigator === "undefined" ? "Web browser" : deviceNameFromUserAgent(navigator.userAgent);

export function PasskeyRegisterForm(props: {
  /** Called after a passkey was added; without it the form says so and stays. */
  onRegistered?: () => void;
}): React.JSX.Element {
  const language = useLanguage();
  const client = useRpcClient();
  const [label, setLabel] = useState(DEFAULT_LABEL);
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{ key: MessageKey; ok: boolean } | undefined>();

  async function add(): Promise<void> {
    if (password === "" || working) return;
    setWorking(true);
    setMessage(undefined);
    try {
      const outcome = await registerPasskey({
        rpc: client,
        password,
        label: passkeyLabel(label, DEFAULT_LABEL),
        create: passkeys.create,
      });
      if (outcome === "registered" && props.onRegistered !== undefined) {
        props.onRegistered();
        return;
      }
      const key = registerMessageKey(outcome);
      setMessage(key === undefined ? undefined : { key, ok: outcome === "registered" });
    } finally {
      // Never keep the password around longer than the attempt.
      setPassword("");
      setWorking(false);
    }
  }

  const canAdd = !working && password !== "";
  return (
    <View style={styles.form}>
      <TextInput
        style={styles.input}
        value={label}
        onChangeText={setLabel}
        placeholder={t(language, "passkey.label")}
        placeholderTextColor={theme.colors.textMuted}
        accessibilityLabel={t(language, "passkey.label")}
        autoCorrect={false}
        editable={!working}
      />
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        placeholder={t(language, "auth.password")}
        placeholderTextColor={theme.colors.textMuted}
        accessibilityLabel={t(language, "auth.password")}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="current-password"
        editable={!working}
        onSubmitEditing={() => void add()}
      />
      <TouchableOpacity
        style={[styles.button, !canAdd && styles.buttonDisabled]}
        disabled={!canAdd}
        onPress={() => void add()}
      >
        {working ? (
          <ActivityIndicator color={theme.colors.primaryText} />
        ) : (
          <Text style={styles.buttonText}>{t(language, "passkey.add")}</Text>
        )}
      </TouchableOpacity>
      {message !== undefined && (
        <Text style={message.ok ? styles.success : styles.error}>{t(language, message.key)}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: theme.spacing.md },
  input: {
    minHeight: 48,
    color: theme.colors.text,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.md,
    fontSize: theme.font.size.md,
  },
  button: {
    backgroundColor: theme.colors.primary,
    minHeight: 48,
    borderRadius: theme.radius.control,
    justifyContent: "center",
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: {
    color: theme.colors.primaryText,
    fontSize: theme.font.size.md,
    fontFamily: theme.font.bold,
  },
  success: { color: theme.colors.success, fontSize: theme.font.size.sm },
  error: { color: theme.colors.danger, fontSize: theme.font.size.sm },
});
