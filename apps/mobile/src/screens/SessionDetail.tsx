// One session's live view (turns, compose bar, key bar, changes/transcript
// links), moved out of app/session/[id].tsx (2026-09-28 wide layout spec
// §4) so the phone's full-screen route and the wide sessions split render
// the same component. Subscriptions are keyed by `id`: callers key this
// component by id, never by layout, so a rotation keeps one subscription.

import { useFocusEffect, useRouter } from "expo-router";
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
import { ActionSheet } from "@/components/ActionSheet";
import { ComposeBar } from "@/components/ComposeBar";
import { IconButton } from "@/components/IconButton";
import { KeyBar } from "@/components/KeyBar";
import { MicButton } from "@/components/MicButton";
import { PlanSummaryCard } from "@/components/PlanSummaryCard";
import { PromptCard } from "@/components/PromptCard";
import { ResumeButton } from "@/components/ResumeButton";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SegmentTabs, type SegmentTab } from "@/components/SegmentTabs";
import { TerminalWebView, type TerminalWebViewHandle } from "@/components/TerminalWebView";
import { type ChangeCountsView, createChangeCountsStore } from "@/lib/change-counts";
import { deviceOrientationPolicy } from "@/lib/app-orientation";
import { realClock } from "@/lib/clock";
import { clientPlatformFor } from "@/lib/client-platform";
import { isApplePlatform, platformKey, sendHintText, t } from "@/lib/i18n";
import { keyboardAvoidingBehavior, keyboardBottomPadding } from "@/lib/keyboard-offset";
import { useLanguage } from "@/lib/language-context";
import { createPlansStore } from "@/lib/plans-store";
import { useRpcClient } from "@/lib/rpc-context";
import { PlanSheet } from "@/plan/PlanSheet";
import { planProgressOf, planSteps } from "@/plan/plan-progress";
import {
  clearLatches,
  createSessionInput,
  type Latches,
  latchesOf,
  NO_LATCHES,
  type SessionInput,
  toggleLatch,
} from "@/lib/session-input";
import { answerPrompt, fetchPrompt, type PhonePrompt } from "@/lib/session-prompt";
import {
  isEnded,
  notFoundText,
  sendResultText,
  sessionSubtitle,
  sessionWideSubtitle,
  streamStatusKey,
  trimmedAmount,
} from "@/lib/session-screen";
import {
  createSessionStream,
  type SessionStream,
  type SessionStreamView,
} from "@/lib/session-stream";
import { createSessionsStore, type SessionsStore, type SessionsView } from "@/lib/sessions-store";
import {
  type BarKey,
  isTextKey,
  MORE_KEYS,
  SESSION_KEYS,
  sgrWheelSequence,
  TEXT_KEY_VALUE,
} from "@/lib/terminal-keys";
import { theme } from "@/lib/theme";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { useLayoutClass } from "@/lib/use-layout-class";
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
  const countsStore = useMemo(() => createChangeCountsStore({ client }), [client]);
  const [counts, setCounts] = useState<ChangeCountsView>(countsStore.get());
  const [now, setNow] = useState(() => realClock.now());
  const [menuOpen, setMenuOpen] = useState(false);
  // The wide pane (tablet or browser): the same session in a card layout.
  // A phone that inherits a selection keeps the phone layout.
  const wide = useLayoutClass().kind === "wide" && embedded;
  const [keysOpen, setKeysOpen] = useState(false);
  const [armed, setArmed] = useState<Latches>(NO_LATCHES);
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
  // The session's plan, looked for where the session runs; notes on it are
  // sent to the session itself (plans:send falls back to a live session).
  const projectPath = row?.projectPath;
  const plansStore = useMemo(
    () =>
      createPlansStore({
        client,
        paneKey: id,
        ...(projectPath === undefined ? {} : { cwd: projectPath }),
      }),
    [client, id, projectPath],
  );
  const [planVisible, setPlanVisible] = useState(false);
  const [, setPlanRevision] = useState(0);
  useEffect(() => plansStore.subscribe(() => setPlanRevision((value) => value + 1)), [plansStore]);
  useEffect(() => {
    void plansStore.openDefault();
  }, [plansStore]);
  const planProgress = planProgressOf(plansStore.state.doc);
  const plan = planSteps(plansStore.state.doc);

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
      const unsubscribeCounts = countsStore.subscribe(setCounts);
      countsStore.focus();
      setCounts(countsStore.get());
      // The header's elapsed time moves on by the minute.
      setNow(realClock.now());
      const tick = setInterval(() => setNow(realClock.now()), 30_000);
      return () => {
        clearInterval(tick);
        unsubscribeCounts();
        countsStore.blur();
        unsubscribe();
        unsubscribeConnection();
        if (ownStore) store.blur();
      };
    }, [store, client, ownStore, countsStore]),
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
        setArmed(NO_LATCHES);
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

  async function onKey(key: BarKey) {
    const input = inputRef.current;
    if (input === undefined || disabled) return;
    if (key === "ctrl" || key === "alt") {
      setArmed(toggleLatch(input, key));
      return;
    }
    // The Alt latch is spent the moment the key goes, not when it lands.
    const pending = isTextKey(key) ? input.sendText(TEXT_KEY_VALUE[key]) : input.sendKey(key);
    setArmed(latchesOf(input));
    const result = await pending;
    if (inputRef.current !== input) return;
    setKeyNotice(sendResultText(result, language, clientPlatformFor(Platform.OS)));
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setKeyNotice(""), 4000);
  }

  if (!found) {
    const text = notFoundText(sessions, language);
    return (
      <View style={styles.missing}>
        {!embedded && <ScreenHeader title={t(language, "sessions.title")} onBack={router.back} />}
        <Text style={styles.missingText}>{text}</Text>
        <TouchableOpacity
          onPress={() => {
            void store.refresh();
          }}
        >
          <Text style={styles.missingText}>{t(language, "common.retry")}</Text>
        </TouchableOpacity>
      </View>
    );
  }
  const statusKey = streamStatusKey(streamView);
  const changedFiles = Object.hasOwn(counts, id) ? counts[id]?.files : undefined;
  const mic = micButtonState(voiceView, { sessionEnded: ended, forSession: true });
  const voiceNotice = voiceView.notice;
  const voiceNoticeKey =
    voiceNotice && voiceNotice.code !== "server" ? noticeKey(voiceNotice.code) : undefined;
  const tabs: SegmentTab[] = [
    {
      key: "live",
      label: t(language, "session.live"),
      selected: true,
      onPress: () => {},
    },
    {
      key: "changes",
      label: t(language, "changes.title"),
      ...(changedFiles === undefined || changedFiles === 0
        ? {}
        : { badge: String(changedFiles), badgeTone: "success" as const }),
      selected: false,
      onPress: () => router.push({ pathname: "/changes", params: { id } }),
    },
    {
      key: "plan",
      label: t(language, "plans.title"),
      ...(planProgress === undefined
        ? {}
        : {
            badge: `${planProgress.done}/${planProgress.total}`,
            badgeTone: "muted" as const,
          }),
      selected: planVisible,
      onPress: () => setPlanVisible(true),
    },
    {
      key: "files",
      label: t(language, "session.files"),
      selected: false,
      onPress: () =>
        router.push(
          row.project === null || row.project === ""
            ? "/workspace"
            : { pathname: "/workspace", params: { project: row.project } },
        ),
    },
  ];
  const wideSubtitle = sessionWideSubtitle(row, now);
  const notices = (
    <>
      {ended && <Text style={styles.status}>{t(language, "session.ended")}</Text>}
      {/* The laptop refuses a resume that names no project of its own (it has
        no screen selection to fall back on), so a session without one gets
        no button rather than a guaranteed refusal. */}
      {ended && row.project !== null && (
        <View style={styles.resume}>
          <ResumeButton sessionId={id} project={row.project} state={row.state} />
        </View>
      )}
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
    </>
  );
  const terminalView = (
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
  );
  const voiceBlock = (
    <>
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
    </>
  );
  return (
    // iOS: KeyboardAvoidingView's padding behavior, as before. Android: no
    // behavior (a plain View) and the screen pads itself from the measured
    // keyboard height + bottom inset — keyboard-offset.ts has the measured
    // reason the KeyboardAvoidingView came up ~75 dp short on the real phone.
    <KeyboardAvoidingView
      style={[
        styles.container,
        wide && styles.wideContainer,
        { paddingBottom: keyboardBottomPadding(Platform.OS, keyboardHeight, insets.bottom) },
      ]}
      behavior={keyboardAvoidingBehavior(Platform.OS)}
    >
      {wide ? (
        <View style={styles.wideHeader}>
          <View style={styles.wideHeading}>
            <Text style={styles.wideTitle} numberOfLines={1}>
              {row.summary}
            </Text>
            <Text style={styles.wideSub} numberOfLines={1}>
              {wideSubtitle.text}
              {wideSubtitle.branch !== undefined && (
                <>
                  {" · "}
                  {t(language, "session.branch")}{" "}
                  <Text style={styles.wideBranch}>{wideSubtitle.branch}</Text>
                </>
              )}
            </Text>
          </View>
          <View style={styles.wideTabs}>
            <SegmentTabs variant="inline" label={t(language, "session.views")} tabs={tabs} />
            <IconButton
              icon="more"
              label={t(language, "session.more")}
              size={40}
              iconSize={18}
              onPress={() => setMenuOpen(true)}
            />
          </View>
        </View>
      ) : (
        <View style={styles.header}>
          <ScreenHeader
            title={row.summary}
            subtitle={sessionSubtitle(row, now)}
            bordered={false}
            {...(embedded ? {} : { onBack: router.back })}
            trailing={
              <IconButton
                icon="more"
                label={t(language, "session.more")}
                iconSize={18}
                onPress={() => setMenuOpen(true)}
              />
            }
          />
          <View style={styles.tabs}>
            <SegmentTabs label={t(language, "session.views")} tabs={tabs} />
          </View>
        </View>
      )}
      <ActionSheet
        visible={menuOpen}
        title={row.summary}
        actions={[
          {
            key: "transcript",
            label: t(language, "history.transcript"),
            onPress: () => router.push({ pathname: "/transcript/[id]", params: { id } }),
          },
        ]}
        onClose={() => setMenuOpen(false)}
      />
      <PlanSheet
        visible={planVisible}
        store={plansStore}
        language={language}
        tabTitle={row.summary}
        onClose={() => setPlanVisible(false)}
      />
      {/* One tree position for the terminal in both layouts, so crossing the
          breakpoint only restyles it (no WebView remount). */}
      <View style={wide ? styles.wideBody : styles.phoneStack}>
        <View style={wide ? styles.wideOutput : styles.body}>
          {notices}
          <View style={wide ? styles.wideTerminal : styles.output}>{terminalView}</View>
          {keyNotice !== "" && <Text style={styles.status}>{keyNotice}</Text>}
          {wide ? (
            <>
              {keysOpen && (
                <KeyBar
                  variant="footer"
                  keys={SESSION_KEYS}
                  moreKeys={MORE_KEYS}
                  disabled={disabled}
                  armed={armed}
                  onMoreClose={() => setArmed(clearLatches(inputRef.current))}
                  onKey={(key) => {
                    void onKey(key);
                  }}
                />
              )}
              <ComposeBar
                variant="inline"
                disabled={disabled}
                placeholder={`${t(language, "session.messagePlaceholder", { agent: row.agentId })}${
                  Platform.OS === "web"
                    ? `  ${sendHintText(language, isApplePlatform(globalThis.navigator ?? {}))}`
                    : ""
                }`}
                onSend={(text) =>
                  inputRef.current?.sendText(text) ?? Promise.resolve({ kind: "offline" })
                }
                onSent={() => setArmed(latchesOf(inputRef.current))}
                beforeSend={
                  <View style={styles.wideTools}>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityState={{ expanded: keysOpen }}
                      onPress={() => {
                        // Hiding the keys drops a latch armed on them.
                        if (keysOpen) setArmed(clearLatches(inputRef.current));
                        setKeysOpen((open) => !open);
                      }}
                      style={[styles.keysToggle, keysOpen && styles.keysToggleOn]}
                    >
                      <Text style={[styles.keysText, keysOpen && styles.keysTextOn]}>
                        {t(language, "session.keys")}
                      </Text>
                    </TouchableOpacity>
                    <MicButton
                      variant="square"
                      enabled={mic.enabled}
                      active={mic.active}
                      labelKey={mic.labelKey}
                    />
                  </View>
                }
              />
              {voiceBlock}
            </>
          ) : (
            prompt !== undefined && (
              <PromptCard
                prompt={prompt}
                busy={promptBusy}
                note={promptNote}
                onAnswer={onAnswer}
                heading={t(language, "prompt.waiting")}
                hideDot
              />
            )
          )}
        </View>
        {wide ? (
          (prompt !== undefined || planProgress !== undefined || plan.length > 0) && (
            <View style={styles.wideAside}>
              {prompt !== undefined && (
                <PromptCard
                  prompt={prompt}
                  busy={promptBusy}
                  note={promptNote}
                  onAnswer={onAnswer}
                  heading={t(language, "prompt.waiting")}
                  hideDot
                  density="compact"
                />
              )}
              {(planProgress !== undefined || plan.length > 0) && (
                <PlanSummaryCard
                  progress={planProgress}
                  steps={plan}
                  onPress={() => setPlanVisible(true)}
                />
              )}
            </View>
          )
        ) : (
          <View style={styles.footer}>
            <KeyBar
              variant="footer"
              keys={SESSION_KEYS}
              moreKeys={MORE_KEYS}
              disabled={disabled}
              armed={armed}
              onMoreClose={() => setArmed(clearLatches(inputRef.current))}
              onKey={(key) => {
                void onKey(key);
              }}
            />
            <ComposeBar
              disabled={disabled}
              placeholder={t(language, "session.messagePlaceholder", { agent: row.agentId })}
              onSend={(text) =>
                inputRef.current?.sendText(text) ?? Promise.resolve({ kind: "offline" })
              }
              onSent={() => setArmed(latchesOf(inputRef.current))}
              beforeSend={
                <MicButton
                  variant="square"
                  enabled={mic.enabled}
                  active={mic.active}
                  labelKey={mic.labelKey}
                />
              }
            />
            {voiceBlock}
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  // Wide pane: 20/24 padding, 14 between the header and the body.
  wideContainer: {
    gap: 14,
    paddingHorizontal: 24,
    paddingVertical: 20,
    backgroundColor: theme.colors.ground,
  },
  wideHeader: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  wideHeading: { flexShrink: 1, minWidth: 0, gap: 2 },
  wideTitle: { color: theme.colors.text, fontFamily: theme.font.extrabold, fontSize: 22 },
  wideSub: { color: theme.colors.textMuted, fontFamily: theme.font.body, fontSize: 13 },
  wideBranch: { color: theme.colors.textSecondary, fontFamily: theme.font.mono },
  wideTabs: { flexDirection: "row", alignItems: "center", gap: 8 },
  phoneStack: { flex: 1 },
  wideBody: { flex: 1, flexDirection: "row", gap: 14, minHeight: 0 },
  wideOutput: {
    flex: 3,
    minWidth: 420,
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairlineSoft,
    backgroundColor: theme.colors.terminalGround,
  },
  wideTerminal: { flex: 1, overflow: "hidden" },
  wideTools: { flexDirection: "row", alignItems: "center", gap: 8 },
  keysToggle: {
    minHeight: 42,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: theme.radius.small,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  keysToggleOn: { backgroundColor: theme.colors.selected },
  keysText: { color: theme.colors.textMuted, fontFamily: theme.font.semibold, fontSize: 13 },
  keysTextOn: { color: theme.colors.text },
  wideAside: { flex: 1, minWidth: 260, gap: 14 },
  resume: { paddingBottom: 6 },
  header: {
    backgroundColor: theme.colors.ground,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.hairlineSoft,
  },
  tabs: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 10 },
  // The padded strip under the footer (keyboard, home indicator) is the
  // footer's own colour.
  container: { flex: 1, backgroundColor: theme.colors.surfaceDim },
  body: {
    flex: 1,
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: theme.colors.ground,
  },
  // The xterm WebView stays; the card frames it.
  output: {
    flex: 1,
    overflow: "hidden",
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairlineSoft,
    backgroundColor: theme.colors.terminalGround,
  },
  footer: {
    gap: 10,
    paddingTop: 10,
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderTopColor: theme.colors.hairlineSoft,
    backgroundColor: theme.colors.surfaceDim,
  },
  missing: { flex: 1, backgroundColor: theme.colors.ground },
  missingText: {
    ...theme.type.meta,
    color: theme.colors.warning,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  status: { ...theme.type.meta, color: theme.colors.warning, paddingVertical: 6 },
  badge: { color: theme.colors.warning, paddingVertical: theme.spacing.sm },
  voiceNotice: { paddingBottom: theme.spacing.sm },
});
