// One session's live view (turns, compose bar, key bar, changes/transcript
// links), moved out of app/session/[id].tsx (2026-09-28 wide layout spec
// §4) so the phone's full-screen route and the wide sessions split render
// the same component. Subscriptions are keyed by `id`: callers key this
// component by id, never by layout, so a rotation keeps one subscription.

import { Stack, useFocusEffect, useRouter } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
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
import { PromptCard } from "@/components/PromptCard";
import { TerminalWebView, type TerminalWebViewHandle } from "@/components/TerminalWebView";
import { deviceOrientationPolicy } from "@/lib/app-orientation";
import { realClock } from "@/lib/clock";
import { clientPlatformFor } from "@/lib/client-platform";
import { platformKey, t } from "@/lib/i18n";
import { keyboardAvoidingBehavior, keyboardBottomPadding } from "@/lib/keyboard-offset";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import { createSessionInput, type SessionInput } from "@/lib/session-input";
import { answerPrompt, fetchPrompt, type PhonePrompt } from "@/lib/session-prompt";
import {
  isEnded,
  notFoundText,
  sendResultText,
  streamStatusKey,
  trimmedAmount,
} from "@/lib/session-screen";
import {
  createSessionStream,
  type SessionStream,
  type SessionStreamView,
} from "@/lib/session-stream";
import { createSessionsStore, type SessionsStore, type SessionsView } from "@/lib/sessions-store";
import type { KeyName } from "@/lib/terminal-keys";
import { sgrWheelSequence } from "@/lib/terminal-keys";
import { theme } from "@/lib/theme";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import type { VoiceView } from "@/lib/voice-controller";
import { useVoiceController } from "@/lib/voice-context";
import { micButtonState, noticeKey, textDirection } from "@/lib/voice-screen";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export function SessionDetail(props: {
  id: string;
  /** Inside the sessions split: no native header, so the title is drawn
   *  inline instead of set on the stack screen. */
  embedded: boolean;
  /** The split's list store, shared so the pane adds no second
   *  `sessions:list`/`sessions:update`. Its owner focuses and blurs it. */
  store?: SessionsStore;
}) {
  const { id, embedded } = props;
  const client = useRpcClient();
  const router = useRouter();
  const language = useLanguage();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const voiceController = useVoiceController();
  const [voiceView, setVoiceView] = useState<VoiceView>(voiceController.get());
  const ownStore = props.store === undefined;
  const store = useMemo(
    () => props.store ?? createSessionsStore({ client }),
    [props.store, client],
  );
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

  // What the agent is waiting on, read every few seconds while this screen
  // is up and the session is live; answered by index and label, which the
  // laptop checks against the prompt on screen then.
  const [prompt, setPrompt] = useState<PhonePrompt | undefined>(undefined);
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptNote, setPromptNote] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (ended) {
      setPrompt(undefined);
      return;
    }
    let cancelled = false;
    const read = () => {
      void fetchPrompt(client, id)
        .then((next) => {
          if (cancelled) return;
          setPrompt((previous) =>
            JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
          );
        })
        .catch(() => {});
    };
    read();
    const timer = setInterval(read, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, id, ended]);
  const onAnswer = useCallback(
    (index: number, label: string) => {
      setPromptBusy(true);
      setPromptNote(undefined);
      void answerPrompt(client, id, index, label)
        .then((outcome) => {
          if (outcome === "answered") setPrompt(undefined);
          else
            setPromptNote(
              t(
                language,
                outcome === "changed" ? "session.promptChanged" : "session.promptOffline",
              ),
            );
        })
        .finally(() => setPromptBusy(false));
    },
    [client, id, language],
  );
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
      if (ownStore) store.focus();
      setSessions(store.get());
      return () => {
        unsubscribe();
        unsubscribeConnection();
        if (ownStore) store.blur();
      };
    }, [store, client, ownStore]),
  );

  // Bug 10: app/_layout.tsx locks PORTRAIT_UP globally; unlocks the moment
  // this screen gains focus so the OS can rotate to landscape for a wider
  // terminal, re-locks to PORTRAIT_UP the moment it loses focus or unmounts
  // (`useFocusEffect`'s cleanup runs for both) — same pattern as
  // sidecar-view.tsx's own landscape fix. Wrapped in try/catch: the web
  // target and some simulators reject these calls outright.
  useFocusEffect(
    useCallback(() => {
      void (async () => {
        try {
          await ScreenOrientation.unlockAsync();
        } catch {
          // Simulator/web: no native orientation lock to unlock. Nothing to do.
        }
      })();
      return () => {
        // A tablet is never locked (orientation-policy.ts).
        if (deviceOrientationPolicy() !== "portrait-lock") return;
        void (async () => {
          try {
            await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
          } catch {
            // Simulator/web: no native orientation lock to set. Nothing to do.
          }
        })();
      };
    }, []),
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
    setKeyNotice(sendResultText(result, language, clientPlatformFor(Platform.OS)));
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
      {embedded ? (
        <Text style={styles.title} numberOfLines={1}>
          {row.summary}
        </Text>
      ) : (
        <Stack.Screen options={{ title: row.summary }} />
      )}
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
        fixedSize={streamView.size}
        onWheel={(direction) => {
          void inputRef.current?.sendText(sgrWheelSequence(direction));
        }}
      />
      {keyNotice !== "" && <Text style={styles.status}>{keyNotice}</Text>}
      <KeyBar
        disabled={disabled}
        armed={armed}
        onKey={(key) => {
          void onKey(key);
        }}
      />
      {prompt !== undefined && (
        <PromptCard prompt={prompt} busy={promptBusy} note={promptNote} onAnswer={onAnswer} />
      )}
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
            <Text style={styles.status}>
              {t(language, platformKey(voiceNoticeKey, clientPlatformFor(Platform.OS)))}
            </Text>
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
  title: {
    color: theme.colors.text,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 4,
    fontFamily: theme.font.semibold,
    fontSize: 15,
    backgroundColor: theme.colors.ground,
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
