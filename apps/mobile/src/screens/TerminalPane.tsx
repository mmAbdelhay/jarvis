// A Workspace terminal pane (M9 Task 7): the same hardened
// TerminalWebView/KeyBar/ComposeBar and attach/input plumbing
// session/[id].tsx uses, reattached to one of the laptop's existing panes
// instead of an agent session. Route ids are opaque strings, validated
// against the pane inventory before this ever subscribes to anything
// (rule 6/global constraint — a deep link never reaches terminal bytes or
// an unvalidated pane). Never creates, splits or closes a pane — only ever
// attaches to one the laptop already has.
import { Stack, useFocusEffect } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
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
import { ArrowPad } from "@/components/ArrowPad";
import { FileBrowserSheet } from "@/components/FileBrowserSheet";
import { KeyBar } from "@/components/KeyBar";
import { PlanStrip } from "@/components/PlanStrip";
import { TerminalNavBar } from "@/components/TerminalNavBar";
import {
  TerminalWebView,
  type TerminalView,
  type TerminalWebViewHandle,
} from "@/components/TerminalWebView";
import { deviceOrientationPolicy } from "@/lib/app-orientation";
import { realClock } from "@/lib/clock";
import { clientPlatformFor } from "@/lib/client-platform";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import type { SendResult, SessionInput } from "@/lib/session-input";
import { sendResultText, streamStatusKey, trimmedAmount } from "@/lib/session-screen";
import type { SessionStream, SessionStreamView } from "@/lib/session-stream";
import { keyboardAvoidingBehavior, keyboardBottomPadding } from "@/lib/keyboard-offset";
import type { KeyName } from "@/lib/terminal-keys";
import { sgrWheelSequence } from "@/lib/terminal-keys";
import type { TerminalKeyInput } from "@/lib/terminal-keyboard";
import { createTerminalInput } from "@/lib/terminal-input";
import { createTerminalStream, watchTerminalExit } from "@/lib/terminal-stream";
import { theme } from "@/lib/theme";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { useLayoutClass } from "@/lib/use-layout-class";
import { createPlansStore } from "@/lib/plans-store";
import { parseTerminalPanes, resolvePane } from "@/lib/workspace-store";
import { PlanSheet } from "@/plan/PlanSheet";
import { currentStep, planProgressOf } from "@/plan/plan-progress";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type ValidationPhase = "checking" | "notFound" | "ok";

/** One laptop terminal pane: the full-screen `/terminal/[paneKey]` route
 *  on a phone, or the inline Workspace tab on a wide screen (`embedded`: no
 *  stack header). Keyed by pane, so a parent that keeps the same pane keeps
 *  the same attach. `tabId` defaults to the pane key: a fresh tab's main
 *  pane key is its own tab id. */
export function TerminalPane(props: { paneKey: string; tabId?: string; embedded: boolean }) {
  const tabId = props.tabId ?? props.paneKey;
  return (
    <TerminalPaneBody
      key={`${tabId}/${props.paneKey}`}
      paneKey={props.paneKey}
      tabId={tabId}
      embedded={props.embedded}
    />
  );
}

function TerminalPaneBody({
  paneKey,
  tabId,
  embedded,
}: {
  paneKey: string;
  tabId: string;
  embedded: boolean;
}) {
  const client = useRpcClient();
  // Wide (Review Focus 4): a hardware keyboard types into the terminal
  // itself. The phone keeps its compose bar and key bar only.
  const hardwareKeys = useLayoutClass().kind === "wide";
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
  const [planVisible, setPlanVisible] = useState(false);
  const [view, setView] = useState<TerminalView>({ back: false, commands: false });
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<boolean | undefined>(undefined);
  const [padOpen, setPadOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [, setPlanRevision] = useState(0);
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
  const plansStore = useMemo(() => createPlansStore({ client, paneKey }), [client, paneKey]);
  useEffect(() => plansStore.subscribe(() => setPlanRevision((value) => value + 1)), [plansStore]);
  // Final fix wave M5: the header's "Plan · N" counts the open plan's queued
  // comments, so the default plan is opened on mount, not first on sheet open.
  useEffect(() => {
    void plansStore.openDefault();
  }, [plansStore]);

  useFocusEffect(
    useCallback(() => {
      const unsubscribeConnection = client.onState((state) => setConnection(state));
      setConnection(client.state());
      return () => unsubscribeConnection();
    }, [client]),
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

  function showResult(input: SessionInput, result: SendResult): void {
    if (inputRef.current !== input) return;
    setKeyNotice(sendResultText(result, language, clientPlatformFor(Platform.OS)));
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setKeyNotice(""), 4000);
  }

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
    showResult(input, result);
  }

  // A key or a paste from the hardware keyboard (wide only). Typed text
  // consumes an armed Ctrl latch, the same as the compose bar's.
  async function onHardwareInput(key: TerminalKeyInput) {
    const input = inputRef.current;
    if (input === undefined || disabled) return;
    const result =
      key.kind === "key" ? await input.sendKey(key.key) : await input.sendText(key.text);
    setArmed(input.ctrlArmed());
    if (result.kind !== "sent") showResult(input, result);
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
  const queuedNotes = plansStore.state.comments.filter(
    (comment) => comment.sentAt === undefined,
  ).length;
  const headerActions = (
    <View style={styles.headerActions}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={t(language, "files.title")}
        onPress={() => setFilesOpen(true)}
        style={styles.headerButton}
      >
        <Text style={styles.headerButtonText}>▤</Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={t(language, "terminal.find")}
        accessibilityState={{ selected: finding }}
        onPress={() => {
          setFinding((open) => !open);
          setFound(undefined);
        }}
        style={[styles.headerButton, finding && styles.headerButtonOn]}
      >
        <Text style={styles.headerButtonText}>⌕</Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={t(language, "terminal.arrowPad")}
        accessibilityState={{ selected: padOpen }}
        onPress={() => setPadOpen((open) => !open)}
        style={[styles.headerButton, padOpen && styles.headerButtonOn]}
      >
        <Text style={styles.headerButtonText}>✥</Text>
      </TouchableOpacity>
    </View>
  );
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
      {!embedded && (
        <Stack.Screen
          options={{
            title: paneKey,
            headerRight: () => headerActions,
          }}
        />
      )}
      {/* Wide layout: no stack header, so the same button sits above the pane. */}
      {embedded && <View style={styles.planRow}>{headerActions}</View>}
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
        fixedSize={streamView.size}
        onWheel={(direction) => {
          void inputRef.current?.sendText(sgrWheelSequence(direction));
        }}
        onView={setView}
        onFound={setFound}
        onHardwareInput={
          hardwareKeys
            ? (key) => {
                void onHardwareInput(key);
              }
            : undefined
        }
      />
      {keyNotice !== "" && <Text style={styles.status}>{keyNotice}</Text>}
      <TerminalNavBar
        language={language}
        view={view}
        finding={finding}
        found={found}
        onJump={(to) => webRef.current?.jump(to)}
        onFind={(query, direction) => webRef.current?.find(query, direction)}
        onCloseFind={() => {
          setFinding(false);
          setFound(undefined);
        }}
      />
      {plansStore.state.doc !== undefined && (
        <PlanStrip
          language={language}
          progress={planProgressOf(plansStore.state.doc)}
          step={currentStep(plansStore.state.doc)}
          queuedNotes={queuedNotes}
          onOpen={() => setPlanVisible(true)}
        />
      )}
      {padOpen && (
        <ArrowPad
          language={language}
          disabled={disabled}
          onArrow={(arrow) => {
            void onKey(arrow);
          }}
        />
      )}
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
      <FileBrowserSheet
        visible={filesOpen}
        client={client}
        paneKey={paneKey}
        language={language}
        onInsert={(text) => {
          void inputRef.current?.sendText(text);
        }}
        onClose={() => setFilesOpen(false)}
      />
      <PlanSheet
        visible={planVisible}
        store={plansStore}
        language={language}
        tabTitle={paneKey}
        onClose={() => setPlanVisible(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  status: { color: theme.colors.warning, padding: theme.spacing.sm },
  badge: { color: theme.colors.warning, padding: theme.spacing.sm },
  composeRow: { paddingHorizontal: theme.spacing.sm, paddingBottom: theme.spacing.sm },
  planRow: { flexDirection: "row", justifyContent: "flex-end" },
  headerActions: { flexDirection: "row", gap: 6, paddingHorizontal: theme.spacing.sm },
  headerButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  headerButtonOn: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  headerButtonText: { color: theme.colors.textSecondary, fontSize: 17 },
});
