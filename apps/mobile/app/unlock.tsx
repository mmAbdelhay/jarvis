// Phase 0 owner login: the screen the root layout pushes whenever the
// connection is locked (or the phone locked itself). It tries the stored
// refresh token first — reading it raises the biometric prompt — and
// offers the owner password as the fallback. It closes itself once the
// connection is open again. The decisions live in unlock-screen.ts and
// auth-session.ts; this file is layout and wiring.
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { UnlockOutcome } from "@/lib/auth-session";
import { t } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useAuthSession, useConnectionStore } from "@/lib/rpc-context";
import { connectionStateKey } from "@/lib/settings-store";
import { theme } from "@/lib/theme";
import { lockCauseKey, unlockMessageKey } from "@/lib/unlock-screen";

export default function UnlockScreen() {
  const insets = useSafeAreaInsets();
  const language = useLanguage();
  const router = useRouter();
  const auth = useAuthSession();
  const connection = useConnectionStore();

  const [connectionView, setConnectionView] = useState(connection.get());
  const [authView, setAuthView] = useState(auth.get());
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<MessageKey | undefined>(undefined);

  useEffect(() => connection.subscribe(setConnectionView), [connection]);
  useEffect(() => auth.subscribe(setAuthView), [auth]);

  // The lock cannot be backed out of (Android's back button).
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => subscription.remove();
  }, []);

  const locked = connectionView.state === "locked";

  // Unlocked: close, back to wherever the owner was.
  useEffect(() => {
    if (connectionView.state !== "open" || authView.lockedLocally) return;
    if (router.canGoBack()) router.back();
    else router.replace("/dashboard");
  }, [connectionView.state, authView.lockedLocally, router]);

  const finish = useCallback((outcome: UnlockOutcome) => {
    setMessage(unlockMessageKey(outcome));
    setWorking(false);
  }, []);

  const tryBiometric = useCallback(async () => {
    setWorking(true);
    setMessage(undefined);
    finish(await auth.unlockWithStoredRefresh());
  }, [auth, finish]);

  // The device-owner check raises itself only at launch and on a return
  // to the foreground (`autoPrompt`, consumed by the attempt) — never
  // after an in-app idle lock, where the button is there instead — and
  // only once the connection can take it and no automatic resume runs.
  useEffect(() => {
    if (!locked || authView.busy || authView.biometricUnavailable || !authView.autoPrompt) {
      return;
    }
    void tryBiometric();
  }, [locked, authView.busy, authView.biometricUnavailable, authView.autoPrompt, tryBiometric]);

  async function submitPassword(): Promise<void> {
    if (password === "" || working) return;
    setWorking(true);
    setMessage(undefined);
    const outcome = await auth.unlockWithPassword(password);
    // Never keep the password around longer than the attempt.
    setPassword("");
    finish(outcome);
  }

  const causeKey = lockCauseKey(authView.lockCause);
  const canSubmit = locked && !working && password !== "";

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[styles.content, { paddingTop: insets.top + 48 }]}>
        <Text style={styles.title}>{t(language, "auth.title")}</Text>
        {causeKey !== undefined && <Text style={styles.cause}>{t(language, causeKey)}</Text>}
        {!locked && (
          <Text style={styles.status}>{t(language, connectionStateKey(connectionView))}</Text>
        )}

        <Text style={styles.hint}>{t(language, "auth.passwordHint")}</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder={t(language, "auth.password")}
          placeholderTextColor={theme.colors.textMuted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          editable={!working}
          onSubmitEditing={() => void submitPassword()}
        />
        <TouchableOpacity
          style={[styles.button, !canSubmit && styles.buttonDisabled]}
          disabled={!canSubmit}
          onPress={() => void submitPassword()}
        >
          {working ? (
            <ActivityIndicator color={theme.colors.primaryText} />
          ) : (
            <Text style={styles.buttonText}>{t(language, "auth.unlock")}</Text>
          )}
        </TouchableOpacity>

        {authView.biometricUnavailable ? (
          <Text style={styles.note}>{t(language, "auth.noBiometric")}</Text>
        ) : (
          <TouchableOpacity
            style={styles.secondary}
            disabled={!locked || working}
            onPress={() => void tryBiometric()}
          >
            <Text style={styles.secondaryText}>{t(language, "auth.useBiometric")}</Text>
          </TouchableOpacity>
        )}

        {message !== undefined && <Text style={styles.error}>{t(language, message)}</Text>}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { paddingHorizontal: theme.spacing.gutter, gap: theme.spacing.md },
  title: { color: theme.colors.text, fontSize: theme.font.size.xl, fontFamily: theme.font.bold },
  cause: { color: theme.colors.warning, fontSize: theme.font.size.md },
  status: { color: theme.colors.textMuted, fontSize: theme.font.size.sm },
  hint: { color: theme.colors.textSecondary, fontSize: theme.font.size.md },
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
  secondary: { minHeight: 44, justifyContent: "center", alignItems: "center" },
  secondaryText: { color: theme.colors.accentText, fontSize: theme.font.size.md },
  note: { color: theme.colors.textMuted, fontSize: theme.font.size.sm },
  error: { color: theme.colors.danger, fontSize: theme.font.size.sm },
});
