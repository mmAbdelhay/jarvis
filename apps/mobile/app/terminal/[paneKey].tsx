// A Workspace terminal pane (M9 Task 7): the same hardened
// TerminalWebView/KeyBar/ComposeBar and attach/input plumbing
// session/[id].tsx uses, reattached to one of the laptop's existing panes
// instead of an agent session. Route ids are opaque strings, validated
// against the pane inventory before this ever subscribes to anything
// (rule 6/global constraint — a deep link never reaches terminal bytes or
// an unvalidated pane). Never creates, splits or closes a pane — only ever
// attaches to one the laptop already has.
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { ComposeBar } from "@/components/ComposeBar";
import { KeyBar } from "@/components/KeyBar";
import { TerminalWebView, type TerminalWebViewHandle } from "@/components/TerminalWebView";
import { realClock } from "@/lib/clock";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import type { SessionInput } from "@/lib/session-input";
import {
  sendResultText,
  sessionRouteId,
  streamStatusKey,
  trimmedAmount,
} from "@/lib/session-screen";
import type { SessionStream, SessionStreamView } from "@/lib/session-stream";
import { keyboardAvoidingBehavior, keyboardBottomPadding } from "@/lib/keyboard-offset";
import type { KeyName } from "@/lib/terminal-keys";
import { createTerminalInput } from "@/lib/terminal-input";
import { createTerminalStream, watchTerminalExit } from "@/lib/terminal-stream";
import { theme } from "@/lib/theme";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { parseTerminalPanes, resolvePane } from "@/lib/workspace-store";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type ValidationPhase = "checking" | "notFound" | "ok";

export default function TerminalPaneScreen() {
  const params = useLocalSearchParams<{ paneKey: string; tabId: string }>();
  const paneKey = sessionRouteId(params.paneKey);
  const tabId = sessionRouteId(params.tabId);
  const language = useLanguage();
  if (paneKey === undefined || tabId === undefined) {
    return <Text style={styles.status}>{t(language, "terminal.notFound")}</Text>;
  }
  return <TerminalPaneBody key={`${tabId}/${paneKey}`} paneKey={paneKey} tabId={tabId} />;
}

function TerminalPaneBody({ paneKey, tabId }: { paneKey: string; tabId: string }) {
  const client = useRpcClient();
  const language = useLanguage();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const [phase, setPhase] = useState<ValidationPhase>("checking");
  const [exited, setExited] = useState(false);
  const [streamView, setStreamView] = useState<SessionStreamView>({
    phase: "idle",
    gapCount: 0,
    droppedBytes: 0,
    ignoredCount: 0,
  });
  const [connection, setConnection] = useState(client.state());
  const [armed, setArmed] = useState(false);
  const [keyNotice, setKeyNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const webRef = useRef<TerminalWebViewHandle>(null);
  const inputRef = useRef<SessionInput | undefined>(undefined);
  const streamRef = useRef<SessionStream | undefined>(undefined);
  const exitedRef = useRef(exited);
  exitedRef.current = exited;
  const sink = useMemo(
    () => ({
      write: (data: string) => webRef.current?.write(data),
      reset: () => webRef.current?.reset(),
    }),
    [],
  );

  useFocusEffect(
    useCallback(() => {
      const unsubscribeConnection = client.onState((state) => setConnection(state));
      setConnection(client.state());
      return () => unsubscribeConnection();
    }, [client]),
  );

  // Rule 6 / bite-proof "pane-key validation": re-checked on every focus
  // (a deep link, or simply returning to this screen later, may name a
  // pane the laptop has since closed or never had) — nothing below this
  // subscribes to anything until `phase` is "ok".
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setPhase("checking");
      void client.call("terminal:panes", [tabId]).then((result) => {
        if (cancelled) return;
        const panes = result.ok ? parseTerminalPanes(result.value) : [];
        const found = resolvePane(panes, paneKey);
        if (found === undefined) {
          setPhase("notFound");
          return;
        }
        setExited(found.exited);
        setPhase("ok");
      });
      return () => {
        cancelled = true;
      };
    }, [client, tabId, paneKey]),
  );

  // Attach/input — only once the pane has been validated. Bite-proof
  // "keyed-subscription release on blur": the cleanup below is what drops
  // this screen's terminal:data/terminal:exit keyed subscriptions and
  // cancels any scheduled input the moment the screen loses focus.
  //
  // Fix round 1, Important 1: terminal:exit is subscribed here, beside
  // terminal:data, for the whole time this pane is open — not read once at
  // focus (task-7-review.md). Delivery for this exact pane sets `exited`,
  // which disables input/resize (see `disabled` below and the setEnded
  // effect) and shows the exited state, exactly as if the validation read
  // had already found it exited. Both subscriptions are released in this
  // same cleanup.
  useFocusEffect(
    useCallback(() => {
      if (phase !== "ok") return;
      const input = createTerminalInput({
        client,
        paneKey,
        clock: realClock,
        log: console.log,
      });
      input.setEnded(exitedRef.current);
      const stream = createTerminalStream({
        client,
        paneKey,
        clock: realClock,
        log: console.log,
      });
      const exitWatcher = watchTerminalExit({
        client,
        paneKey,
        onExit: () => setExited(true),
      });
      inputRef.current = input;
      streamRef.current = stream;
      const unsubscribe = stream.subscribe(setStreamView);
      sink.reset();
      stream.open(sink);
      setStreamView(stream.get());
      const appState = AppState.addEventListener("change", (state) => {
        if (state === "active") input.reassert();
      });
      return () => {
        unsubscribe();
        stream.close();
        exitWatcher.close();
        input.dispose();
        appState.remove();
        inputRef.current = undefined;
        streamRef.current = undefined;
        clearTimeout(noticeTimer.current);
        setArmed(false);
        setKeyNotice("");
      };
    }, [client, paneKey, phase, sink]),
  );

  useEffect(() => {
    inputRef.current?.setEnded(exited);
  }, [exited]);
  const disabled = exited || phase !== "ok" || connection !== "open";

  async function onKey(key: KeyName | "ctrl") {
    const input = inputRef.current;
    if (input === undefined || disabled) return;
    if (key === "ctrl") {
      if (input.ctrlArmed()) input.disarmCtrl();
      else input.armCtrl();
      setArmed(input.ctrlArmed());
      return;
    }
    const result = await input.sendKey(key);
    if (inputRef.current !== input) return;
    setKeyNotice(sendResultText(result, language));
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setKeyNotice(""), 4000);
  }

  if (phase === "checking") {
    return (
      <View style={styles.container}>
        <Text style={styles.status}>{t(language, "session.attaching")}</Text>
      </View>
    );
  }
  if (phase === "notFound") {
    return (
      <View style={styles.container}>
        <Text style={styles.status}>{t(language, "terminal.notFound")}</Text>
      </View>
    );
  }

  const statusKey = streamStatusKey(streamView);
  return (
    // iOS: KeyboardAvoidingView's padding behavior, as before. Android: no
    // behavior (a plain View) and the screen pads itself from the measured
    // keyboard height + bottom inset — keyboard-offset.ts has the measured
    // reason the KeyboardAvoidingView came up ~75 dp short on the real phone.
    <KeyboardAvoidingView
      style={[
        styles.container,
        { paddingBottom: keyboardBottomPadding(Platform.OS, keyboardHeight, insets.bottom) },
      ]}
      behavior={keyboardAvoidingBehavior(Platform.OS)}
    >
      <Stack.Screen options={{ title: paneKey }} />
      {exited && <Text style={styles.status}>{t(language, "terminal.exited")}</Text>}
      {streamView.gapCount > 0 && (
        <Text style={styles.badge}>
          {t(language, "session.trimmed", { amount: trimmedAmount(streamView) || "⋯" })}
        </Text>
      )}
      {statusKey && (
        <TouchableOpacity
          disabled={streamView.phase !== "failed"}
          onPress={() => streamRef.current?.retry()}
        >
          <Text style={styles.status}>
            {streamView.error?.kind === "remote" ? streamView.error.text : t(language, statusKey)}
          </Text>
        </TouchableOpacity>
      )}
      <TerminalWebView
        ref={webRef}
        onReady={({ cols, rows }) => {
          inputRef.current?.resize(cols, rows);
          inputRef.current?.reassert();
        }}
        onResize={({ cols, rows }) => inputRef.current?.resize(cols, rows)}
        onModes={(modes) => inputRef.current?.setModes(modes)}
        onNeedsReplay={() => streamRef.current?.restart(sink)}
      />
      {keyNotice !== "" && <Text style={styles.status}>{keyNotice}</Text>}
      <KeyBar
        disabled={disabled}
        armed={armed}
        onKey={(key) => {
          void onKey(key);
        }}
      />
      <View style={styles.composeRow}>
        <ComposeBar
          disabled={disabled}
          onSend={(text) =>
            inputRef.current?.sendText(text) ?? Promise.resolve({ kind: "offline" })
          }
          onSent={() => setArmed(inputRef.current?.ctrlArmed() ?? false)}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  status: { color: theme.colors.warning, padding: theme.spacing.sm },
  badge: { color: theme.colors.warning, padding: theme.spacing.sm },
  composeRow: { paddingHorizontal: theme.spacing.sm, paddingBottom: theme.spacing.sm },
});
