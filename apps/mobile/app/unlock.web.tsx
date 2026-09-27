// The browser build's unlock screen (Task 13). The root layout pushes it
// whenever the connection is locked, exactly as on native. Differences:
// - No OS prompt. Once per page load it first tries the stored refresh
//   token, which exists only with "Keep me signed in on this browser" on,
//   and goes straight to `auth:refresh`. If that finds nothing, the laptop
//   has passkeys and the platform reports a user-verifying authenticator,
//   it raises the passkey sheet on its own (a browser that refuses a sheet
//   without a tap just leaves the button). After an idle lock, or on a
//   return to the tab, the owner uses a passkey or the password.
// - Passkey first (button), password as the fallback.
// - The "Keep me signed in" switch lives here too (default off).
// - Right after pairing (passkey-offer-signal.ts), the first password
//   sign-in is followed by an offer to add a passkey for this browser. The
//   laptop asks for the password again for that.
// Decisions live in unlock-screen.ts, auth-session.ts and
// passkey-registration.ts; this file is layout and wiring.
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Switch,
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
import { passkeys } from "@/lib/passkey";
import { setPasskeyOfferSignal, takePasskeyOfferSignal } from "@/lib/passkey-offer-signal";
import { loadPrefs, setKeepSignedIn } from "@/lib/prefs";
import { filePrefsStore } from "@/lib/prefs-file";
import { useAuthSession, useConnectionStore, useRpcClient } from "@/lib/rpc-context";
import { connectionStateKey } from "@/lib/settings-store";
import { theme } from "@/lib/theme";
import { lockCauseKey, runWebAutoSignIn, unlockMessageKey } from "@/lib/unlock-screen";
import { PasskeyRegisterForm } from "@/components/PasskeyRegisterForm";

const LOCALE = Intl.DateTimeFormat().resolvedOptions().locale;

type Phase = "unlock" | "offer";

/** The automatic sign-in runs once per page load, not once per mount. */
let pageLoadSignInDone = false;

export default function UnlockScreen() {
  const insets = useSafeAreaInsets();
  const language = useLanguage();
  const router = useRouter();
  const auth = useAuthSession();
  const client = useRpcClient();
  const connection = useConnectionStore();

  const [connectionView, setConnectionView] = useState(connection.get());
  const [authView, setAuthView] = useState(auth.get());
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<MessageKey | undefined>(undefined);
  const [keepSignedIn, setKeep] = useState(false);
  const [phase, setPhase] = useState<Phase>("unlock");
  // Set before a password sign-in that should be followed by the offer, so
  // the close-on-open effect below never races it.
  const [holdOpen, setHoldOpen] = useState(false);
  const passkeySupported = useRef(passkeys.isSupported()).current;

  useEffect(() => connection.subscribe(setConnectionView), [connection]);
  useEffect(() => auth.subscribe(setAuthView), [auth]);
  useEffect(() => {
    let cancelled = false;
    void loadPrefs(filePrefsStore, LOCALE).then((prefs) => {
      if (!cancelled) setKeep(prefs.keepSignedIn);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const locked = connectionView.state === "locked";

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/dashboard");
  }, [router]);

  // Unlocked: close, back to wherever the owner was — unless the passkey
  // offer is (about to be) on screen.
  useEffect(() => {
    if (connectionView.state !== "open" || authView.lockedLocally) return;
    if (holdOpen || phase === "offer") return;
    leave();
  }, [connectionView.state, authView.lockedLocally, holdOpen, phase, leave]);

  const finish = useCallback((outcome: UnlockOutcome) => {
    setMessage(unlockMessageKey(outcome));
  }, []);

  /** Runs one attempt with the busy state always reset (finally), so an
   *  exception can never leave the screen stuck. */
  const attempt = useCallback(
    async (run: () => Promise<UnlockOutcome>) => {
      setWorking(true);
      setMessage(undefined);
      try {
        finish(await run());
      } catch {
        finish("failed");
      } finally {
        setWorking(false);
      }
    },
    [finish],
  );

  const passkeySignIn = useCallback(() => auth.unlockWithPasskey(passkeys.getAssertion), [auth]);

  const passkeyContext = useCallback(async () => {
    const status = await client.call("auth:status", [{}]);
    return {
      supported: passkeySupported,
      platformAuthenticator: await passkeys.hasPlatformAuthenticator(),
      hasPasskeys:
        status.ok && (status.value as { hasPasskeys?: unknown } | null)?.hasPasskeys === true,
    };
  }, [client, passkeySupported]);

  // Once per page load (controller ruling): the stored sign-in (keep me
  // signed in), then — when that found nothing and the platform can verify
  // the owner — the passkey sheet. Never on a return to the tab or after an
  // idle lock: auth-session re-arms `autoPrompt` only at launch in the
  // browser, and the module flag guards a remount.
  useEffect(() => {
    if (!locked || authView.busy || !authView.autoPrompt || pageLoadSignInDone) return;
    pageLoadSignInDone = true;
    void attempt(() =>
      runWebAutoSignIn({
        storedSignIn: () => auth.unlockWithStoredRefresh(),
        passkeyContext,
        passkeySignIn,
      }),
    );
  }, [locked, authView.busy, authView.autoPrompt, auth, attempt, passkeyContext, passkeySignIn]);

  async function submitPassword(): Promise<void> {
    if (password === "" || working) return;
    const offer = passkeySupported && takePasskeyOfferSignal();
    setHoldOpen(offer);
    const typed = password;
    // Never keep the password around longer than the attempt.
    setPassword("");
    await attempt(async () => {
      let outcome: UnlockOutcome = "failed";
      try {
        outcome = await auth.unlockWithPassword(typed);
        return outcome;
      } finally {
        if (offer) {
          if (outcome === "unlocked") setPhase("offer");
          else setPasskeyOfferSignal(); // not signed in yet: offer after the next try
          setHoldOpen(false);
        }
      }
    });
  }

  async function changeKeepSignedIn(on: boolean): Promise<void> {
    setKeep(on);
    try {
      await setKeepSignedIn(filePrefsStore, LOCALE, on);
      await auth.storagePolicyChanged();
    } catch {
      setKeep(!on);
    }
  }

  const causeKey = lockCauseKey(authView.lockCause);

  if (phase === "offer") {
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 48 }]}
      >
        <Text style={styles.title}>{t(language, "passkey.offerTitle")}</Text>
        <Text style={styles.hint}>{t(language, "passkey.offerHint")}</Text>
        <PasskeyRegisterForm onRegistered={leave} />
        <TouchableOpacity style={styles.secondary} onPress={leave}>
          <Text style={styles.secondaryText}>{t(language, "passkey.skip")}</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  const canSubmit = locked && !working && password !== "";

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 48 }]}
    >
      <Text style={styles.title}>{t(language, "auth.title")}</Text>
      {causeKey !== undefined && <Text style={styles.cause}>{t(language, causeKey)}</Text>}
      {!locked && (
        <Text style={styles.status}>{t(language, connectionStateKey(connectionView))}</Text>
      )}

      {passkeySupported && (
        <TouchableOpacity
          style={[styles.button, (!locked || working) && styles.buttonDisabled]}
          disabled={!locked || working}
          onPress={() => void attempt(passkeySignIn)}
        >
          <Text style={styles.buttonText}>{t(language, "auth.usePasskey")}</Text>
        </TouchableOpacity>
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
        returnKeyType="go"
        editable={!working}
        onSubmitEditing={() => void submitPassword()}
      />
      <TouchableOpacity
        style={[
          passkeySupported ? styles.outlineButton : styles.button,
          !canSubmit && styles.buttonDisabled,
        ]}
        disabled={!canSubmit}
        onPress={() => void submitPassword()}
      >
        {working ? (
          <ActivityIndicator color={theme.colors.primaryText} />
        ) : (
          <Text style={passkeySupported ? styles.outlineButtonText : styles.buttonText}>
            {t(language, "auth.unlock")}
          </Text>
        )}
      </TouchableOpacity>

      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>{t(language, "auth.keepSignedIn")}</Text>
        <Switch
          value={keepSignedIn}
          accessibilityLabel={t(language, "auth.keepSignedIn")}
          onValueChange={(on) => void changeKeepSignedIn(on)}
        />
      </View>
      <Text style={styles.note}>{t(language, "auth.keepSignedInHint")}</Text>

      {message !== undefined && <Text style={styles.error}>{t(language, message)}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: {
    paddingHorizontal: theme.spacing.gutter,
    gap: theme.spacing.md,
    width: "100%",
    maxWidth: 480,
    alignSelf: "center",
  },
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
  outlineButton: {
    borderColor: theme.colors.border,
    borderWidth: 1,
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
  outlineButtonText: {
    color: theme.colors.text,
    fontSize: theme.font.size.md,
    fontFamily: theme.font.bold,
  },
  secondary: { minHeight: 44, justifyContent: "center", alignItems: "center" },
  secondaryText: { color: theme.colors.accentText, fontSize: theme.font.size.md },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  switchLabel: { flex: 1, color: theme.colors.text, fontSize: theme.font.size.md },
  note: { color: theme.colors.textMuted, fontSize: theme.font.size.sm },
  error: { color: theme.colors.danger, fontSize: theme.font.size.sm },
});
