// A Workspace terminal pane (M9 Task 7): the same hardened
// TerminalWebView/KeyBar/ComposeBar and attach/input plumbing
// session/[id].tsx uses, reattached to one of the laptop's existing panes
// instead of an agent session. Route ids are opaque strings, validated
// against the pane inventory before this ever subscribes to anything
// (rule 6/global constraint — a deep link never reaches terminal bytes or
// an unvalidated pane). Never creates, splits or closes a pane — only ever
// attaches to one the laptop already has.
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
import { ComposeBar } from "@/components/ComposeBar";
import { ArrowPad } from "@/components/ArrowPad";
import { AttachSheet, type AttachSource } from "@/components/AttachSheet";
import { AttachTray } from "@/components/AttachTray";
import { ClaudeChatView, ClaudeTabToggle } from "@/components/ClaudeChatView";
import { FileBrowserSheet } from "@/components/FileBrowserSheet";
import { FileTree } from "@/components/FileTree";
import { IconButton } from "@/components/IconButton";
import { KeyBar } from "@/components/KeyBar";
import { PlanStrip } from "@/components/PlanStrip";
import { ScreenHeader } from "@/components/ScreenHeader";
import { TerminalFindField, TerminalLatestPill, TerminalNavBar } from "@/components/TerminalNavBar";
import {
  TerminalWebView,
  type TerminalView,
  type TerminalWebViewHandle,
} from "@/components/TerminalWebView";
import { deviceOrientationPolicy } from "@/lib/app-orientation";
import {
  type AttachPick,
  type AttachUploader,
  attachPickOf,
  createAttachUploader,
} from "@/lib/claude-attach";
import { answerNoticeKey, CLAUDE_CHAT_KEYS, chatHeader } from "@/lib/claude-chat";
import { createAttachTray, submit } from "@/lib/claude-compose";
import { createClaudeViewStore } from "@/lib/claude-view-store";
import { nativeFilePicker } from "@/lib/file-picker";
import { capacityFor } from "@/lib/home-capacity";
import { pickImages } from "@/lib/image-pick";
import { nativeRecordingFiles } from "@/lib/native-recording-files";
import { topBarStoreFor } from "@/lib/top-bar-store";
import { realClock } from "@/lib/clock";
import { clientPlatformFor } from "@/lib/client-platform";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import {
  type Latches,
  clearLatches,
  latchesOf,
  NO_LATCHES,
  type SendResult,
  type SessionInput,
  toggleLatch,
} from "@/lib/session-input";
import { sendResultText, streamStatusKey, trimmedAmount } from "@/lib/session-screen";
import type { SessionStream, SessionStreamView } from "@/lib/session-stream";
import { keyboardAvoidingBehavior, keyboardBottomPadding } from "@/lib/keyboard-offset";
import {
  type BarKey,
  isTextKey,
  NAV_KEYS,
  TEXT_KEY_VALUE,
  terminalFooterKeys,
} from "@/lib/terminal-keys";
import { paneChips, terminalTitle } from "@/lib/terminal-header";
import { sgrWheelSequence } from "@/lib/terminal-keys";
import type { TerminalKeyInput } from "@/lib/terminal-keyboard";
import { createTerminalFit, type TerminalSize } from "@/lib/terminal-fit";
import { createTerminalInput } from "@/lib/terminal-input";
import { createTerminalStream, watchTerminalExit } from "@/lib/terminal-stream";
import { theme } from "@/lib/theme";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { useLayoutClass } from "@/lib/use-layout-class";
import { createPlansStore } from "@/lib/plans-store";
import { parseTerminalPanes, parseWorkspaceSnapshot, resolvePane } from "@/lib/workspace-store";
import { PlanDock, PlanSheet } from "@/plan/PlanSheet";
import { currentStep, planProgressOf } from "@/plan/plan-progress";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MobileWorkspaceTab, TerminalPaneInfo } from "@jarvis/wire";

type ValidationPhase = "checking" | "notFound" | "ok";

/** Attachments one Claude message can carry. */
const MAX_ATTACH = 4;

/** One laptop terminal pane: the full-screen `/terminal/[paneKey]` route
 *  on a phone, or the inline Workspace tab on a wide screen (`embedded`: no
 *  stack header). Keyed by pane, so a parent that keeps the same pane keeps
 *  the same attach. `tabId` defaults to the pane key: a fresh tab's main
 *  pane key is its own tab id. */
export function TerminalPane(props: {
  paneKey: string;
  tabId?: string;
  embedded: boolean;
  /** Wide Workspace: the project's name for the status bar. */
  project?: string;
  /** Wide Workspace: the Files tree beside the terminal (otherwise the Files button). */
  filesAside?: boolean;
  /** Wide Workspace: the plan docked beside the terminal (otherwise the PlanStrip). */
  planDock?: boolean;
}) {
  const tabId = props.tabId ?? props.paneKey;
  return (
    <TerminalPaneBody
      key={`${tabId}/${props.paneKey}`}
      paneKey={props.paneKey}
      tabId={tabId}
      embedded={props.embedded}
      project={props.project}
      filesAside={props.filesAside === true}
      planDock={props.planDock === true}
    />
  );
}

function TerminalPaneBody({
  paneKey,
  tabId,
  embedded,
  project,
  filesAside,
  planDock,
}: {
  paneKey: string;
  tabId: string;
  embedded: boolean;
  project: string | undefined;
  filesAside: boolean;
  planDock: boolean;
}) {
  const client = useRpcClient();
  const router = useRouter();
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
  const [armed, setArmed] = useState<Latches>(NO_LATCHES);
  const [keyNotice, setKeyNotice] = useState("");
  const [planVisible, setPlanVisible] = useState(false);
  const [view, setView] = useState<TerminalView>({ back: false, commands: false });
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<boolean | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [navMode, setNavMode] = useState(false);
  const [tab, setTab] = useState<MobileWorkspaceTab | undefined>(undefined);
  const [panes, setPanes] = useState<TerminalPaneInfo[]>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const [, setPlanRevision] = useState(0);
  const [attachOpen, setAttachOpen] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const webRef = useRef<TerminalWebViewHandle>(null);
  const inputRef = useRef<SessionInput | undefined>(undefined);
  const streamRef = useRef<SessionStream | undefined>(undefined);
  const exitedRef = useRef(exited);
  exitedRef.current = exited;
  // Fit toggle (terminal-fit.ts): on, the phone sizes the pty to its own
  // fit; `ptySize` is the size the pty has as far as this screen knows —
  // the attach snapshot's, or the desktop's size Fit just gave back.
  const [fitOn, setFitOn] = useState(false);
  const [ptySize, setPtySize] = useState<TerminalSize | undefined>(undefined);
  const fit = useMemo(
    () =>
      createTerminalFit({
        // Marked "fit"/"restore": the host applies it even to a pane the
        // desktop sized. Straight to the host, not through the debounced
        // input — the restore on blur must outlive the disposed input (a
        // failed one is retried on the next open, terminal-fit.ts).
        send: async ({ cols, rows }, mode) => {
          const result = await client.call("terminal:resize", [paneKey, cols, rows, mode], {
            whenNotOpen: "reject",
          });
          if (!result.ok) return { ok: false };
          const size = parseTerminalSize(result.value);
          return size === undefined ? { ok: true } : { ok: true, size };
        },
        watchOpen: (listener) =>
          client.onState((state) => {
            if (state === "open") listener();
          }),
        restored: setPtySize,
      }),
    [client, paneKey],
  );
  const sink = useMemo(
    () => ({
      write: (data: string) => webRef.current?.write(data),
      reset: () => webRef.current?.reset(),
    }),
    [],
  );
  const plansStore = useMemo(() => createPlansStore({ client, paneKey }), [client, paneKey]);
  // Claude Code in this pane (Task 8): the parsed view and the Chat/Term
  // choice live in the store; the attachments in the tray.
  const claudeStore = useMemo(
    () => createClaudeViewStore({ client, paneKey, log: console.log }),
    [client, paneKey],
  );
  const [claude, setClaude] = useState(() => claudeStore.get());
  useEffect(() => claudeStore.subscribe(setClaude), [claudeStore]);
  const claudeView = claude.view.kind === "claude" ? claude.view : undefined;
  const chatShown = claudeView !== undefined && claude.tab === "chat";
  const languageRef = useRef(language);
  languageRef.current = language;
  // The uploader, behind a ref and rebuilt once disposed (the same guard
  // connection-store.ts / push-context.tsx use): a StrictMode double-run
  // effect disposes it and the re-run builds a fresh one at once, so the
  // tray, which calls through the ref, never holds a dead uploader.
  const uploaderRef = useRef<AttachUploader | undefined>(undefined);
  const makeUploader = useCallback(
    () =>
      createAttachUploader({
        client,
        files: nativeRecordingFiles,
        paneKey,
        errorText: (kind) => t(languageRef.current, `claude.upload.${kind}`),
      }),
    [client, paneKey],
  );
  if (uploaderRef.current === undefined) uploaderRef.current = makeUploader();
  useEffect(() => {
    if (uploaderRef.current === undefined || uploaderRef.current.isDisposed()) {
      uploaderRef.current = makeUploader();
    }
    const current = uploaderRef.current;
    return () => current.dispose();
  }, [makeUploader]);
  const tray = useMemo(
    () =>
      createAttachTray<AttachPick>({
        send: (pick, onProgress, onCancel) => {
          const uploader = uploaderRef.current;
          if (uploader === undefined || uploader.isDisposed()) {
            return Promise.resolve({ error: t(languageRef.current, "claude.upload.cancelled") });
          }
          return uploader.send(pick, onProgress, onCancel);
        },
        attach: (fileId) =>
          uploaderRef.current?.attach(fileId) ??
          Promise.resolve({ ok: false, error: t(languageRef.current, "claude.upload.attach") }),
        failedText: () => t(languageRef.current, "claude.upload.failed"),
        maxFiles: MAX_ATTACH,
      }),
    [],
  );
  const [trayItems, setTrayItems] = useState(() => tray.items());
  useEffect(() => tray.subscribe(() => setTrayItems(tray.items())), [tray]);
  // The account's session/week use for the chat's meters, from the same
  // store the wide shell's capacity reads; only while Claude is here.
  const topBar = useMemo(() => topBarStoreFor(client), [client]);
  const [capacity, setCapacity] = useState(() => topBar.get().capacity);
  const claudePresent = claudeView !== undefined;
  useEffect(() => {
    if (!claudePresent) return;
    setCapacity(topBar.get().capacity);
    return topBar.subscribe((view) => setCapacity(view.capacity));
  }, [topBar, claudePresent]);
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
        if (found !== undefined) setPanes(panes);
        if (found === undefined) {
          setPhase("notFound");
          return;
        }
        setExited(found.exited);
        setPhase("ok");
      });
      // The tab's own title and project for the header; a failed read
      // leaves the pane key as the title.
      // Embedded (wide) has no stack header to title, so it skips the read.
      if (!embedded) {
        void client.call("workspace:snapshot", []).then((result) => {
          if (cancelled || !result.ok) return;
          setTab(parseWorkspaceSnapshot(result.value)?.tabs.find((item) => item.id === tabId));
        });
      }
      return () => {
        cancelled = true;
      };
    }, [client, tabId, paneKey, embedded]),
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
  //
  // Task 8: input stays attached in both Chat and Term; the terminal:data
  // stream only while Term (the terminal itself) is on screen. The input is
  // made afresh at each switch: one carried over from Term would still hold
  // the terminal's size and send it again (reconnect, app back to front),
  // and Chat never resizes the pty.
  useFocusEffect(
    // biome-ignore lint/correctness/useExhaustiveDependencies: `chatShown` is the switch the input is remade at (above).
    useCallback(() => {
      if (phase !== "ok") return;
      const input = createTerminalInput({
        client,
        paneKey,
        clock: realClock,
        log: console.log,
      });
      input.setEnded(exitedRef.current);
      const exitWatcher = watchTerminalExit({
        client,
        paneKey,
        onExit: () => setExited(true),
      });
      inputRef.current = input;
      const appState = AppState.addEventListener("change", (state) => {
        if (state === "active") input.reassert();
      });
      return () => {
        exitWatcher.close();
        input.dispose();
        appState.remove();
        inputRef.current = undefined;
        clearTimeout(noticeTimer.current);
        setArmed(NO_LATCHES);
        setKeyNotice("");
      };
    }, [client, paneKey, phase, chatShown]),
  );

  useFocusEffect(
    useCallback(() => {
      if (phase !== "ok" || chatShown) return;
      const stream = createTerminalStream({
        client,
        paneKey,
        clock: realClock,
        log: console.log,
      });
      streamRef.current = stream;
      const unsubscribe = stream.subscribe(setStreamView);
      sink.reset();
      stream.open(sink);
      setStreamView(stream.get());
      return () => {
        unsubscribe();
        stream.close();
        streamRef.current = undefined;
      };
    }, [client, paneKey, phase, sink, chatShown]),
  );

  // The Claude view's keyed subscription, for as long as the pane is open.
  useFocusEffect(
    useCallback(() => {
      if (phase !== "ok") return;
      claudeStore.open();
      return () => claudeStore.close();
    }, [claudeStore, phase]),
  );

  useEffect(() => {
    inputRef.current?.setEnded(exited);
  }, [exited]);

  // A pty size the host reports. Never answered with a resize of its own
  // but the phone's fit again (terminal-fit.ts), so it cannot start a loop:
  // a size Fit did not set means the desktop resized the pane meanwhile,
  // and Fit simply goes off. A fresh attach's not-yet-known size keeps the
  // last one, so refocusing does not reflow the page through a fit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the size's own cols/rows, not the view object, which changes on every stream update.
  useEffect(() => {
    if (streamView.size === undefined) return;
    setPtySize(streamView.size);
    if (fit.ptyReported(streamView.size)) setFitOn(false);
  }, [streamView.size?.cols, streamView.size?.rows, fit]);

  const fitOff = useCallback(() => {
    const desktop = fit.disable();
    if (desktop !== undefined) setPtySize(desktop);
    setFitOn(false);
  }, [fit]);

  // Leaving the screen (blur or unmount), or the app going to the
  // background, with Fit on gives the desktop its size back.
  useFocusEffect(
    useCallback(() => {
      const appState = AppState.addEventListener("change", (state) => {
        if (state === "background") fitOff();
      });
      return () => {
        appState.remove();
        fitOff();
      };
    }, [fitOff]),
  );

  // Chat shows no terminal, so it never sizes the pty: a Fit left on when
  // Term goes away gives the desktop its size back, as leaving does.
  useEffect(() => {
    if (chatShown) fitOff();
  }, [chatShown, fitOff]);
  // The attach sheet belongs to Chat: leaving it closes the sheet for good.
  useEffect(() => {
    if (!chatShown) setAttachOpen(false);
  }, [chatShown]);

  function toggleFit(): void {
    if (fit.isOn()) {
      fitOff();
      return;
    }
    if (fit.enable(ptySize)) setFitOn(true);
  }
  const disabled = exited || phase !== "ok" || connection !== "open";

  function flashNotice(text: string): void {
    setKeyNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setKeyNotice(""), 4000);
  }

  function showResult(input: SessionInput, result: SendResult): void {
    if (inputRef.current !== input) return;
    flashNotice(sendResultText(result, language, clientPlatformFor(Platform.OS)));
  }

  // Chat's Enter: the attached paths, then the text, then Enter.
  async function sendToClaude(text: string): Promise<SendResult> {
    const input = inputRef.current;
    if (input === undefined) return { kind: "offline" };
    const result = await submit(input, tray, text);
    if (result === "sent") return { kind: "sent" };
    if (result === "blocked") return { kind: "failed", text: t(language, "claude.uploadWait") };
    return result;
  }

  async function answerClaude(index: number, label: string): Promise<void> {
    try {
      const key = answerNoticeKey(await claudeStore.answer(index, label));
      if (key !== undefined) flashNotice(t(language, key));
    } catch {
      flashNotice(t(language, "claude.answerFailed"));
    }
  }

  async function attachFrom(source: AttachSource): Promise<void> {
    setAttachOpen(false);
    const remaining = MAX_ATTACH - tray.items().length;
    if (remaining < 1) {
      flashNotice(t(language, "claude.attachFull", { n: MAX_ATTACH }));
      return;
    }
    // Native: the sheet's modal must be gone before a picker presents. The
    // browser opens its file input at once, while the tap still counts.
    if (Platform.OS !== "web") await new Promise((resolve) => setTimeout(resolve, 400));
    if (source === "files") {
      const picked = await nativeFilePicker.pick();
      if (picked !== undefined) tray.add(picked);
      return;
    }
    const picks = await pickImages(source, remaining);
    if (picks === "denied") {
      flashNotice(t(language, source === "camera" ? "claude.cameraDenied" : "claude.photosDenied"));
      return;
    }
    if (picks === "cancelled") return;
    for (const pick of picks) tray.add(attachPickOf(pick));
  }

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
    showResult(input, result);
  }

  // A key or a paste from the hardware keyboard (wide only). Typed text
  // consumes an armed Ctrl latch, the same as the compose bar's.
  async function onHardwareInput(key: TerminalKeyInput) {
    const input = inputRef.current;
    if (input === undefined || disabled) return;
    const result =
      key.kind === "key" ? await input.sendKey(key.key) : await input.sendText(key.text);
    setArmed(latchesOf(input));
    if (result.kind !== "sent") showResult(input, result);
  }

  if (phase === "checking") {
    return (
      <View style={styles.container}>
        {!embedded && <ScreenHeader title={paneKey} onBack={router.back} />}
        <Text style={styles.status}>{t(language, "session.attaching")}</Text>
      </View>
    );
  }
  if (phase === "notFound") {
    return (
      <View style={styles.container}>
        {!embedded && <ScreenHeader title={paneKey} onBack={router.back} />}
        <Text style={styles.status}>{t(language, "terminal.notFound")}</Text>
      </View>
    );
  }

  const statusKey = streamStatusKey(streamView);
  const trayBusy = trayItems.some((item) => item.state === "uploading");
  const queuedNotes = plansStore.state.comments.filter(
    (comment) => comment.sentAt === undefined,
  ).length;
  const closeFind = () => {
    setFinding(false);
    setFound(undefined);
    setQuery("");
  };
  const findControl = finding ? (
    <TerminalFindField
      language={language}
      value={query}
      found={found}
      onChange={setQuery}
      onSubmit={() => query !== "" && webRef.current?.find(query, "next")}
    />
  ) : (
    <IconButton
      icon="search"
      label={t(language, "terminal.find")}
      {...(embedded ? { size: 28 as const, iconSize: 16 } : {})}
      onPress={() => {
        setFinding(true);
        setFound(undefined);
      }}
    />
  );
  // The phone only: the wide layout keeps the desktop's size.
  const fitButton = (
    <IconButton
      icon="fitWidth"
      label={t(language, "terminal.fit")}
      selected={fitOn}
      disabled={!fitOn && (ptySize === undefined || disabled)}
      onPress={toggleFit}
    />
  );
  const filesButton = (
    <IconButton
      icon="folder"
      label={t(language, "files.title")}
      onPress={() => setFilesOpen(true)}
    />
  );
  // The phone's header keeps both; the wide pane moves find into its status
  // bar and shows the Files button only when no aside holds the tree.
  const tabToggle =
    claudeView === undefined ? null : (
      <ClaudeTabToggle
        language={language}
        tab={claude.tab}
        onChange={(next) => claudeStore.setTab(next)}
      />
    );
  // With Claude here, the header carries Chat|Term; Chat keeps Files, Term
  // keeps Fit and find (Files is one tap away on Chat).
  const headerActions = (
    <View style={styles.headerActions}>
      {tabToggle}
      {!chatShown && fitButton}
      {(claudeView === undefined || chatShown) && filesButton}
      {!chatShown && findControl}
    </View>
  );
  const header =
    claudeView === undefined
      ? { title: terminalTitle(tab, paneKey), subtitle: tab?.project }
      : chatHeader(claudeView, paneKey, tab?.project);
  const dockShown = planDock && plansStore.state.doc !== undefined;
  const chips = embedded ? [] : paneChips(panes, paneKey);
  const showChips = chips.length > 1;
  const terminal = (
    // iOS: KeyboardAvoidingView's padding behavior, as before. Android: no
    // behavior (a plain View) and the screen pads itself from the measured
    // keyboard height + bottom inset — keyboard-offset.ts has the measured
    // reason the KeyboardAvoidingView came up ~75 dp short on the real phone.
    <KeyboardAvoidingView
      style={[
        styles.container,
        embedded && styles.embeddedColumn,
        { paddingBottom: keyboardBottomPadding(Platform.OS, keyboardHeight, insets.bottom) },
      ]}
      behavior={keyboardAvoidingBehavior(Platform.OS)}
    >
      {!embedded && (
        <ScreenHeader
          title={header.title}
          {...(view.back && !chatShown
            ? { subtitle: t(language, "terminal.scrolledBack"), subtitleTone: "warning" as const }
            : header.subtitle === undefined
              ? {}
              : { subtitle: header.subtitle, subtitleMono: claudeView === undefined })}
          onBack={router.back}
          trailing={headerActions}
          bordered={!showChips}
        />
      )}
      {showChips && (
        <View style={styles.chips}>
          {chips.map((chip) => (
            <TouchableOpacity
              key={chip.paneKey}
              accessibilityRole="tab"
              accessibilityState={{ selected: chip.current }}
              onPress={() => {
                if (chip.current) return;
                router.replace({
                  pathname: "/terminal/[paneKey]",
                  params: { paneKey: chip.paneKey, tabId },
                });
              }}
              style={[styles.chip, chip.current && styles.chipOn]}
            >
              <View style={[styles.chipDot, chip.exited && styles.chipDotExited]} />
              <Text style={[styles.chipText, chip.current && styles.chipTextOn]}>
                {t(language, "terminal.pane", { n: chip.number })}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      {/* Wide layout: no stack header, so the Files button sits above the pane
          (unless the aside shows the tree); find is in the status bar. */}
      {embedded && (tabToggle !== null || !filesAside) && (
        <View style={styles.planRow}>
          {tabToggle}
          {!filesAside && filesButton}
        </View>
      )}
      {fitOn && !chatShown && (
        <Text style={styles.fitNote} numberOfLines={1}>
          {t(language, "terminal.fitOn")}
        </Text>
      )}
      {exited && <Text style={styles.status}>{t(language, "terminal.exited")}</Text>}
      {!chatShown && streamView.gapCount > 0 && (
        <Text style={styles.badge}>
          {t(language, "session.trimmed", { amount: trimmedAmount(streamView) || "⋯" })}
        </Text>
      )}
      {!chatShown && statusKey && (
        <TouchableOpacity
          disabled={streamView.phase !== "failed"}
          onPress={() => streamRef.current?.retry()}
        >
          <Text style={styles.status}>
            {streamView.error?.kind === "remote" ? streamView.error.text : t(language, statusKey)}
          </Text>
        </TouchableOpacity>
      )}
      {chatShown && claudeView !== undefined ? (
        <ClaudeChatView
          language={language}
          view={claudeView}
          {...capacityFor(capacity, "anthropic")}
          answering={claude.answering}
          disabled={disabled}
          onMode={() => {
            void onKey("shiftTab");
          }}
          onAnswer={(index, label) => {
            void answerClaude(index, label);
          }}
          onOpenLink={openLink}
        />
      ) : (
        <View style={styles.output}>
          <TerminalWebView
            ref={webRef}
            onReady={({ cols, rows }) => {
              inputRef.current?.resize(cols, rows);
              inputRef.current?.reassert();
              fit.pageSize({ cols, rows });
            }}
            onResize={({ cols, rows }) => {
              inputRef.current?.resize(cols, rows);
              fit.pageSize({ cols, rows });
            }}
            onModes={(modes) => inputRef.current?.setModes(modes)}
            onNeedsReplay={() => streamRef.current?.restart(sink)}
            fixedSize={fitOn ? undefined : ptySize}
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
          {view.back && (
            <TerminalLatestPill
              language={language}
              compact={!embedded}
              onPress={() => webRef.current?.jump("latest")}
            />
          )}
        </View>
      )}
      {keyNotice !== "" && <Text style={styles.status}>{keyNotice}</Text>}
      {!chatShown && (
        <TerminalNavBar
          language={language}
          finding={finding}
          query={query}
          found={found}
          onFind={(text, direction) => webRef.current?.find(text, direction)}
          onCloseFind={closeFind}
          // The wide layout keeps its own row; the phone's are key bar caps.
          {...(embedded ? { jumps: { view, onJump: (to) => webRef.current?.jump(to) } } : {})}
        />
      )}
      {plansStore.state.doc !== undefined && !dockShown && (
        <PlanStrip
          language={language}
          progress={planProgressOf(plansStore.state.doc)}
          step={currentStep(plansStore.state.doc)}
          queuedNotes={queuedNotes}
          compact={!embedded}
          onOpen={() => setPlanVisible(true)}
        />
      )}
      {embedded && (
        <View style={styles.statusBar}>
          <Text style={styles.statusPath} numberOfLines={1}>
            {project ?? ""}
          </Text>
          <View style={styles.statusEnd}>
            {/* Find and the history hint act on the terminal, gone in Chat. */}
            {!chatShown && (
              <Text style={styles.statusHint}>{t(language, "terminal.historyHint")}</Text>
            )}
            {!chatShown && findControl}
          </View>
        </View>
      )}
      <View style={styles.footer}>
        <KeyBar
          variant="footer"
          keys={navMode ? NAV_KEYS : chatShown ? CLAUDE_CHAT_KEYS : terminalFooterKeys(false)}
          disabled={disabled}
          armed={armed}
          // Previous / next command, when the shell marks its prompts (the
          // phone's; the wide layout has its own row above).
          actions={
            view.commands && !embedded && !chatShown
              ? (["prevCommand", "nextCommand"] as const).map((to) => ({
                  id: to,
                  icon: to === "prevCommand" ? ("chevronUp" as const) : ("chevronDown" as const),
                  label: t(language, `terminal.${to}`),
                  onPress: () => webRef.current?.jump(to),
                }))
              : undefined
          }
          modeToggle={{
            open: navMode,
            onPress: () => {
              // Ctrl/Alt caps sit in the navigation row only.
              setArmed(clearLatches(inputRef.current));
              setNavMode((open) => !open);
            },
          }}
          onKey={(key) => {
            void onKey(key);
          }}
        />
        {navMode ? (
          <ArrowPad
            language={language}
            disabled={disabled}
            onArrow={(arrow) => {
              void onKey(arrow);
            }}
            onKey={(key) => {
              void onKey(key);
            }}
          />
        ) : (
          <>
            {chatShown && (
              <AttachTray
                language={language}
                items={trayItems}
                onRemove={(id) => tray.remove(id)}
              />
            )}
            {/* One ComposeBar for both tabs, so a draft survives Chat ⇄ Term. */}
            <ComposeBar
              mono={!chatShown}
              disabled={disabled}
              placeholder={t(
                language,
                !chatShown
                  ? "terminal.typePlaceholder"
                  : claudeView?.prompt !== undefined
                    ? "claude.answerPlaceholder"
                    : "claude.placeholder",
              )}
              {...(chatShown
                ? {
                    leading: (
                      <IconButton
                        icon="plus"
                        size={46}
                        label={t(language, "claude.attach")}
                        disabled={disabled}
                        onPress={() => setAttachOpen(true)}
                      />
                    ),
                    submitIcon: "enter" as const,
                    submitDisabled: trayBusy,
                    submitLabel: t(language, trayBusy ? "claude.enterWaiting" : "claude.enter"),
                  }
                : {})}
              onSend={(text) =>
                chatShown
                  ? sendToClaude(text)
                  : (inputRef.current?.sendText(text) ?? Promise.resolve({ kind: "offline" }))
              }
              onSent={() => setArmed(latchesOf(inputRef.current))}
            />
          </>
        )}
      </View>
      <AttachSheet
        // Claude leaving (or Term) closes the sheet.
        visible={attachOpen && chatShown}
        language={language}
        onPick={(source) => {
          void attachFrom(source);
        }}
        onClose={() => setAttachOpen(false)}
      />
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
  if (!embedded) return terminal;
  // Wide Workspace: the Files tree and the plan dock flank the terminal. The
  // terminal keeps one position, so showing or hiding a side never remounts it.
  return (
    <View style={styles.dockRow}>
      {filesAside ? (
        <FileTree
          key={paneKey}
          client={client}
          paneKey={paneKey}
          language={language}
          onInsert={(text) => {
            void inputRef.current?.sendText(text);
          }}
        />
      ) : null}
      {terminal}
      {dockShown ? <PlanDock store={plansStore} language={language} tabTitle={paneKey} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.terminalGround },
  output: { flex: 1 },
  status: { color: theme.colors.warning, padding: theme.spacing.sm },
  fitNote: {
    ...theme.type.meta,
    color: theme.colors.warning,
    paddingHorizontal: 12,
    paddingVertical: 3,
  },
  badge: { color: theme.colors.warning, padding: theme.spacing.sm },
  planRow: { flexDirection: "row", justifyContent: "flex-end" },
  embeddedColumn: { minWidth: 0 },
  dockRow: { flex: 1, flexDirection: "row", minHeight: 0 },
  statusBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderTopColor: theme.colors.hairlineSoft,
  },
  statusPath: { ...theme.type.mono, flexShrink: 1, color: theme.colors.textDim },
  statusEnd: { flexDirection: "row", alignItems: "center", gap: 8, marginStart: "auto" },
  statusHint: { ...theme.type.meta, color: theme.colors.textDim },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  chips: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 10,
    backgroundColor: theme.colors.ground,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.hairlineSoft,
  },
  chip: {
    minHeight: 34,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipOn: { borderColor: theme.colors.selected, backgroundColor: theme.colors.selected },
  chipDot: {
    width: 7,
    height: 7,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.success,
  },
  chipDotExited: { backgroundColor: theme.colors.disabledDot },
  chipText: { ...theme.type.meta, color: theme.colors.textMuted, fontFamily: theme.font.semibold },
  chipTextOn: { color: theme.colors.text, fontFamily: theme.font.bold },
  footer: {
    gap: 8,
    paddingTop: 8,
    paddingHorizontal: 10,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderTopColor: theme.colors.hairlineSoft,
    backgroundColor: theme.colors.ground,
  },
});

/** The host's answer to a restore: the pty's size, if it is one. */
/** Module-level so its identity is stable for the chat's memoised rows. */
function openLink(url: string): void {
  if (!url.startsWith("https://")) return;
  void Linking.openURL(url).catch(() => {});
}

function parseTerminalSize(value: unknown): TerminalSize | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { cols, rows } = value as { cols?: unknown; rows?: unknown };
  if (typeof cols !== "number" || typeof rows !== "number") return undefined;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return undefined;
  return { cols, rows };
}
