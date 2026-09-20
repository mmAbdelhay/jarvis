import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  KeyboardAvoidingView,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { ComposeBar } from "@/components/ComposeBar";
import { KeyBar } from "@/components/KeyBar";
import { MicButton } from "@/components/MicButton";
import { TerminalWebView, type TerminalWebViewHandle } from "@/components/TerminalWebView";
import { realClock } from "@/lib/clock";
import { t } from "@/lib/i18n";
import { keyboardAvoidingBehavior, keyboardBottomPadding } from "@/lib/keyboard-offset";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import { createSessionInput, type SessionInput } from "@/lib/session-input";
import {
  isEnded,
  notFoundText,
  sendResultText,
  sessionRouteId,
  streamStatusKey,
  trimmedAmount,
} from "@/lib/session-screen";
import {
  createSessionStream,
  type SessionStream,
  type SessionStreamView,
} from "@/lib/session-stream";
import { createSessionsStore, type SessionsView } from "@/lib/sessions-store";
import type { KeyName } from "@/lib/terminal-keys";
import { theme } from "@/lib/theme";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import type { VoiceView } from "@/lib/voice-controller";
import { useVoiceController } from "@/lib/voice-context";
import { micButtonState, noticeKey, textDirection } from "@/lib/voice-screen";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function SessionScreen() {
  const id = sessionRouteId(useLocalSearchParams().id);
  const language = useLanguage();
  if (id === undefined) return <Text style={styles.status}>{t(language, "session.notFound")}</Text>;
  return <SessionBody key={id} id={id} />;
}

function SessionBody({ id }: { id: string }) {
  const client = useRpcClient();
  const router = useRouter();
  const language = useLanguage();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const voiceController = useVoiceController();
  const [voiceView, setVoiceView] = useState<VoiceView>(voiceController.get());
  const store = useMemo(() => createSessionsStore({ client }), [client]);
  const [sessions, setSessions] = useState<SessionsView>({ ...store.get(), loading: true });
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
  // Fix round 1 (spec gap): the brief names `SessionsStore.find(id)` as the
  // lookup interface; `sessions` stays the re-render trigger (its identity
  // changes on every store notification), but the row itself now comes
  // from the store's own method rather than a re-derived scan.
  const row = store.find(id);
  const found = row !== undefined;
  const ended = isEnded(row?.state);
  const endedRef = useRef(ended);
  endedRef.current = ended;
  const sink = useMemo(
    () => ({
      write: (data: string) => webRef.current?.write(data),
      reset: () => webRef.current?.reset(),
    }),
    [],
  );

  useFocusEffect(
    useCallback(() => {
      const unsubscribe = store.subscribe(setSessions);
      const unsubscribeConnection = client.onState((state) => setConnection(state));
      setConnection(client.state());
      store.focus();
      setSessions(store.get());
      return () => {
        unsubscribe();
        unsubscribeConnection();
        store.blur();
      };
    }, [store, client]),
  );

  useFocusEffect(
    useCallback(() => {
      if (!found) return;
      const input = createSessionInput({
        client,
        sessionId: id,
        clock: realClock,
        log: console.log,
      });
      input.setEnded(endedRef.current);
      const stream = createSessionStream({
        client,
        sessionId: id,
        clock: realClock,
        log: console.log,
      });
      inputRef.current = input;
      streamRef.current = stream;
      const unsubscribe = stream.subscribe(setStreamView);
      // `close()` resets the stream cursor, while React Navigation can
      // retain this WebView across a blur. Clear any retained terminal
      // contents before the next snapshot is written on refocus.
      sink.reset();
      stream.open(sink);
      setStreamView(stream.get());
      const appState = AppState.addEventListener("change", (state) => {
        if (state === "active") input.reassert();
      });
      return () => {
        unsubscribe();
        stream.close();
        input.dispose();
        appState.remove();
        inputRef.current = undefined;
        streamRef.current = undefined;
        clearTimeout(noticeTimer.current);
        // Fix round 1 (Important 4): `armed`/`keyNotice` are React state
        // that outlives this effect's own input — without this, arming
        // Ctrl, backgrounding, and returning left the cap showing armed
        // against a fresh `SessionInput` (ctrlArmedFlag reset to false),
        // so the next compose send would reach the pty unmodified.
        setArmed(false);
        setKeyNotice("");
      };
    }, [client, id, found, sink]),
  );

  useFocusEffect(
    useCallback(() => {
      if (!found) return;
      const unsubscribe = voiceController.subscribe(setVoiceView);
      const release = voiceController.focus({ kind: "session", sessionId: id });
      setVoiceView(voiceController.get());
      return () => {
        unsubscribe();
        release();
      };
    }, [voiceController, id, found]),
  );

  useEffect(() => {
    inputRef.current?.setEnded(ended);
  }, [ended]);
  const disabled = ended || connection !== "open";

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

  if (!found) {
    const text = notFoundText(sessions, language);
    return (
      <View style={styles.container}>
        <Text style={styles.status}>{text}</Text>
        <TouchableOpacity
          onPress={() => {
            void store.refresh();
          }}
        >
          <Text style={styles.status}>{t(language, "common.retry")}</Text>
        </TouchableOpacity>
      </View>
    );
  }
  const statusKey = streamStatusKey(streamView);
  const mic = micButtonState(voiceView, { sessionEnded: ended, forSession: true });
  const voiceNotice = voiceView.notice;
  const voiceNoticeKey =
    voiceNotice && voiceNotice.code !== "server" ? noticeKey(voiceNotice.code) : undefined;
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
      <Stack.Screen options={{ title: row.summary }} />
      <Text style={styles.label}>{row.label}</Text>
      <View style={styles.links}>
        <TouchableOpacity onPress={() => router.push({ pathname: "/changes", params: { id } })}>
          <Text style={styles.link}>{t(language, "changes.title")}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => router.push({ pathname: "/transcript/[id]", params: { id } })}
        >
          <Text style={styles.link}>{t(language, "history.transcript")}</Text>
        </TouchableOpacity>
      </View>
      {ended && <Text style={styles.status}>{t(language, "session.ended")}</Text>}
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
        <View style={styles.composeBarSlot}>
          <ComposeBar
            disabled={disabled}
            onSend={(text) =>
              inputRef.current?.sendText(text) ?? Promise.resolve({ kind: "offline" })
            }
            onSent={() => setArmed(inputRef.current?.ctrlArmed() ?? false)}
          />
        </View>
        <MicButton compact enabled={mic.enabled} active={mic.active} labelKey={mic.labelKey} />
      </View>
      {voiceNotice && (
        <View style={styles.voiceNotice}>
          {voiceNotice.code === "server" && voiceNotice.server && (
            <Text
              style={[
                styles.status,
                { writingDirection: textDirection(voiceNotice.server.language) },
              ]}
            >
              {voiceNotice.server.text}
            </Text>
          )}
          {voiceNotice.code !== "server" && voiceNoticeKey && (
            <Text style={styles.status}>{t(language, voiceNoticeKey)}</Text>
          )}
          {voiceNotice.code === "sentToSession" && voiceNotice.server && (
            <Text
              style={[
                styles.status,
                { writingDirection: textDirection(voiceNotice.server.language) },
              ]}
            >
              {voiceNotice.server.text}
            </Text>
          )}
          {voiceNotice.code === "micBlocked" && (
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => {
                void Linking.openSettings();
              }}
            >
              <Text style={styles.status}>{t(language, "voice.openSettings")}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.terminalGround },
  status: {
    color: theme.colors.warning,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontFamily: theme.font.body,
    fontSize: 12,
  },
  label: {
    color: theme.colors.textDim,
    paddingHorizontal: 14,
    paddingVertical: 6,
    fontFamily: theme.font.mono,
    fontSize: 11,
    backgroundColor: theme.colors.ground,
  },
  badge: { color: theme.colors.warning, padding: theme.spacing.sm },
  composeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    paddingHorizontal: 4,
    backgroundColor: theme.colors.ground,
  },
  composeBarSlot: { flex: 1 },
  voiceNotice: { paddingHorizontal: theme.spacing.sm, paddingBottom: theme.spacing.sm },
  links: {
    flexDirection: "row",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
  },
  link: { color: theme.colors.primary },
});
