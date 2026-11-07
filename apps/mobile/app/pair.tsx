import type { PairingLink } from "@jarvis/wire";
import { CameraView, useCameraPermissions } from "expo-camera";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { takeClearFailedSignal } from "@/lib/clear-failed-signal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconButton } from "@/components/IconButton";
import { clientPlatformFor, clientStringFor } from "@/lib/client-platform";
import { realClock } from "@/lib/clock";
import { dialogs } from "@/lib/dialog";
import { AuthCard, useAuthCardRootStyle } from "@/components/WidePanel";
import { type Language, t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { nativeTransport } from "@/lib/native-transport";
import {
  type JoinFailure,
  type JoinStep,
  clearFailedEntry,
  entryPhaseKind,
  heldAfterHost,
  hostStep,
  intakeLink,
  joinFailureKey,
  openHeldMachine,
  pairBackTarget,
  phaseAfterRead,
  readHeldMachines,
  savePairing,
  shouldDrainPairingLink,
  submitJoin,
} from "@/lib/pair-flow";
import { useMachineSessions, useNavigatorGate } from "@/lib/machine-context";
import { MAX_MACHINES, type MachineId } from "@/lib/machine-index";
import { prepareSwitchRoute, retryClear as retryClearOf } from "@/lib/machine-sessions";
import { machineStore, openMachineStore } from "@/lib/machine-store-instance";
import { joinMachine, pair, type PairOutcome, withHost } from "@/lib/pairing";
import { subscribePairingLink, takePairingLink } from "@/lib/pairing-link-holder";
import { leavePairScreen } from "@/lib/scope-routing";
import { screenHeaderModel } from "@/lib/screen-header";
import { systemTransportFor } from "@/lib/system-transport";
import { theme } from "@/lib/theme";
import { createAppTransport } from "@/lib/trust-routing-transport";

const CLIENT_STRING = clientStringFor(Platform.OS, Constants.expoConfig?.version ?? "0.0.0");
const PLATFORM = clientPlatformFor(Platform.OS);
// M11 rule 6: constructed once, module-wide — a link with a `name` pairs
// through `systemTransport` (OS trust store), one without pins natively
// through `nativeTransport`, exactly as before. Task 13: the browser build
// always dials through `systemTransport` (createAppTransport).
const transport = createAppTransport(PLATFORM, {
  pin: nativeTransport,
  system: systemTransportFor(PLATFORM),
});

type PairFailureReason = Exclude<PairOutcome, { ok: true }>["reason"];
// Screen-only conditions (I5, Important-1): `pair()` itself either
// succeeded and the keychain write afterwards failed or the phone is full,
// or the mount-time read of the machines failed.
type ScreenFailure = PairFailureReason | "save-failed" | "check-failed" | "limit";

type Phase =
  | { kind: "checking" }
  // Reached when the laptop unpaired this phone and `_layout.tsx`'s
  // `onUnpaired` handler couldn't clear the stored record. It never offers
  // the Dashboard button that would only reconnect with the now-revoked
  // token (task-6-rereview-r1.md): only a retry, and another machine if one
  // is held.
  | { kind: "clearFailed" }
  | { kind: "sameMachine"; id: MachineId }
  | { kind: "scan" }
  | { kind: "join"; failure?: JoinFailure }
  | { kind: "needsHost"; invalid?: boolean }
  | { kind: "confirm"; host: string; port: number; fingerprintTail: string; name?: string }
  // `join`: nobody has an approval to give, so nothing asks for one.
  | { kind: "waiting"; join?: boolean }
  | { kind: "error"; failure: ScreenFailure }
  | { kind: "success" };

// Exhaustive: every `PairOutcome` failure reason and every screen-only
// one maps to a key, so a reason added later without updating this
// function is a compile error rather than a silent fallback.
function errorKey(reason: ScreenFailure) {
  switch (reason) {
    case "invalid-link":
      return "pair.linkInvalid" as const;
    case "fingerprint":
      return "pair.fingerprintMismatch" as const;
    case "denied":
      return "pair.denied" as const;
    case "expired":
      return "pair.expired" as const;
    case "timeout":
      return "pair.timeout" as const;
    case "protocol":
      return "pair.protocol" as const;
    case "unreachable":
      return "pair.unreachable" as const;
    case "save-failed":
      return "pair.saveFailed" as const;
    case "check-failed":
      return "pair.checkFailed" as const;
    case "web-needs-certificate":
      return "pair.webNeedsCertificate" as const;
    case "limit":
      return "pair.limit" as const;
    // Neither of these is ever produced by `pair()` today (host-needed is
    // resolved before `pair()` is called, through the "needsHost"/"confirm"
    // steps; a busy laptop's own close code maps to `expired` — see
    // task-5-review.md, I2) — mapped to the closest honest copy rather than
    // silently falling through.
    case "busy":
    case "host-needed":
      return "pair.protocol" as const;
  }
}

// Wide layout: a centred card instead of a full-screen page (the logic
// below is the same on every screen size).
export default function PairScreenRoute() {
  return (
    <AuthCard>
      <PairScreen />
    </AuthCard>
  );
}

// The password lives in this component's state and nowhere else on this screen:
// cleared the moment submit reads it, and gone with the form once the join
// starts. `onSubmit` hands it straight on, so a retry is typed again.
function JoinForm(props: {
  language: Language;
  name: string;
  onNameChange(name: string): void;
  failure: JoinFailure | undefined;
  onSubmit(name: string, password: string): void;
  onCancel(): void;
}) {
  const { language, name, onNameChange, failure, onSubmit, onCancel } = props;
  const [password, setPassword] = useState("");

  function submit(): void {
    const read = password;
    setPassword("");
    if (read.length === 0) return;
    onSubmit(name, read);
  }

  return (
    <>
      <Text style={styles.label}>{t(language, "pair.joinName")}</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={onNameChange}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <Text style={styles.label}>{t(language, "pair.joinPassword")}</Text>
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        onSubmitEditing={submit}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      {failure !== undefined && (
        <Text style={styles.errorText}>{t(language, joinFailureKey(failure))}</Text>
      )}
      <TouchableOpacity style={styles.button} onPress={submit}>
        <Text style={styles.buttonText}>{t(language, "common.ok")}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.button} onPress={onCancel}>
        <Text style={styles.buttonText}>{t(language, "common.cancel")}</Text>
      </TouchableOpacity>
    </>
  );
}

function PairScreen() {
  const cardRoot = useAuthCardRootStyle();
  const insets = useSafeAreaInsets();
  const language = useLanguage();
  const router = useRouter();
  const gate = useNavigatorGate();
  const sessions = useMachineSessions();
  const clearFailedIdRef = useRef<MachineId | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [hostText, setHostText] = useState("");
  const [pastedLink, setPastedLink] = useState("");
  const [joinName, setJoinName] = useState("");
  const [deviceName, setDeviceName] = useState("");
  // Ids alone, for the back button and the limit: what can be told from memory.
  const [held, setHeld] = useState<MachineId[]>([]);
  const heldRef = useRef(held);
  const scannedRef = useRef(false);
  const mountedRef = useRef(true);
  // Mirrors `deviceName` for code that must read the *current* value from
  // inside a stable callback (the pairing-link subscription, subscribed
  // once) rather than whatever value was in scope when that callback was
  // created.
  const deviceNameRef = useRef(deviceName);
  deviceNameRef.current = deviceName;
  const defaultDeviceNameRef = useRef("");
  // The one place the secret-bearing `PairingLink` lives while the user is
  // on the "needsHost" or "confirm" step (I1) — never in `phase`, which a
  // debug overlay could print. Cleared the moment it is no longer needed:
  // on submit (handed to `pair()`), on cancel, on a full retry, and on
  // unmount.
  const pendingLinkRef = useRef<PairingLink | null>(null);

  const phaseRef = useRef(phase);

  const safeSetPhase = useCallback((next: Phase) => {
    // Synchronous, not render-timed: a second intake in the same tick
    // (e.g. a new link racing a scan) must see the phase this call is
    // about to commit to, not the one from the last completed render.
    phaseRef.current = next;
    if (mountedRef.current) {
      setPhase(next);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingLinkRef.current = null;
    };
  }, []);

  useEffect(() => {
    void requestPermission();
  }, [requestPermission]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const name = Device.deviceName ?? Device.modelName;
      if (!cancelled && name) {
        defaultDeviceNameRef.current = name;
        setDeviceName(name);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshHeld = useCallback(async () => {
    const read = await readHeldMachines(openMachineStore, machineStore);
    if (read.ok) {
      heldRef.current = read.ids;
      if (mountedRef.current) setHeld(read.ids);
    }
    return read;
  }, []);

  // C1a / Important-1: a phone may add a machine whatever it holds, and a held
  // machine is refused by its id, at each intake. A machine store that could
  // not open fails *closed*: `phaseAfterRead` never routes a failed read to
  // "scan", so a transient keychain error can never unlock scanning.
  const checkMachines = useCallback(async () => {
    safeSetPhase({ kind: "checking" });
    const read = await refreshHeld();
    if (!read.ok) {
      // Logged without any secret: just the fact that the check failed.
      console.warn("pair: reading the machines failed");
    }
    const nextKind = phaseAfterRead(read);
    // R-M1: a link stashed for a phone whose check failed must not linger in
    // the holder — drained here so it can never resurface at a later scan.
    if (shouldDrainPairingLink(nextKind)) {
      takePairingLink();
    }
    if (nextKind === "checkFailed") {
      safeSetPhase({ kind: "error", failure: "check-failed" });
      return;
    }
    safeSetPhase({ kind: nextKind });
  }, [refreshHeld, safeSetPhase]);

  useEffect(() => {
    // Arriving with the one-shot clearFailed signal set (clear-failed-
    // signal.ts, consumed here — never a route param, which a forged
    // `jarvis://pair?...&clearFailed=1` link could set) goes straight to
    // that phase. A signal for a machine no longer on screen is not this
    // visit's: the user has moved past it.
    const signal = clearFailedEntry(takeClearFailedSignal(), sessions.current().id);
    clearFailedIdRef.current = signal?.id ?? null;
    const entryKind = entryPhaseKind(signal !== undefined);
    if (entryKind === "clearFailed") {
      // R-M1: same reasoning as the checkMachines branch above.
      if (shouldDrainPairingLink(entryKind)) {
        takePairingLink();
      }
      safeSetPhase({ kind: "clearFailed" });
      // For the back button: with none read, the retry is still there.
      void refreshHeld();
      return;
    }
    void checkMachines();
    // Runs once, on mount: `takeClearFailedSignal()` is one-shot by design
    // (consuming it again on a later `checkMachines` identity change would
    // read `false` and silently skip the phase), and every callback here is
    // otherwise stable.
  }, [checkMachines, refreshHeld, safeSetPhase, sessions]);

  // Off this screen, to the machine on screen. Through the gate: this runs
  // after an await, and a switch's remount may have taken the navigator.
  const leave = useCallback(() => {
    leavePairScreen({
      gate,
      screenUp: () => mountedRef.current,
      toDashboard: () => prepareSwitchRoute(router, gate, (line) => console.warn(line)),
    });
  }, [gate, router]);

  // Decision 11: nobody is stranded on this screen while another machine works.
  // A machine that cannot be opened may have gone, and left a phase of its own.
  const openMachine = useCallback(
    (id: MachineId) =>
      openHeldMachine(id, {
        switchTo: sessions.switchTo,
        leave,
        failed: () => {
          dialogs.notice(t(language, "machines.openFailed"));
          void refreshHeld();
          const { kind } = phaseRef.current;
          if (kind === "checking" || kind === "sameMachine") {
            scannedRef.current = false;
            safeSetPhase({ kind: "scan" });
          }
        },
        log: (line) => console.warn(line),
      }),
    [sessions, leave, language, refreshHeld, safeSetPhase],
  );

  // The clearFailed phase's own retry — removes the machine the signal named,
  // with its session's memory of the stored token, and moves on only once it
  // actually succeeds. A machine named next may not have reached the screen, as
  // reading it can have failed, so this goes there itself.
  const retryClear = useCallback(async () => {
    const next = await retryClearOf(sessions, clearFailedIdRef.current);
    if (next === "clearFailed") {
      // Logged without any secret: just the fact that the retry failed.
      console.warn("pair: retrying the clear failed");
      safeSetPhase({ kind: "clearFailed" });
      return;
    }
    clearFailedIdRef.current = null;
    void refreshHeld();
    if (next === "scan") {
      safeSetPhase({ kind: "scan" });
      return;
    }
    safeSetPhase({ kind: "checking" });
    await openMachine(next.next);
  }, [sessions, safeSetPhase, refreshHeld, openMachine]);

  const isHeld = useCallback((id: MachineId) => machineStore.has(id), []);
  const atLimit = useCallback(() => heldRef.current.length >= MAX_MACHINES, []);

  const applyStep = useCallback(
    (step: JoinStep) => {
      switch (step.kind) {
        case "success":
          safeSetPhase({ kind: "success" });
          leave();
          return;
        case "sameMachine":
          safeSetPhase({ kind: "sameMachine", id: step.id });
          return;
        case "limit":
          safeSetPhase({ kind: "error", failure: "limit" });
          return;
        case "saveFailed":
          // I5: a keychain write failure must not leave the screen stuck on
          // the wait forever.
          safeSetPhase({ kind: "error", failure: "save-failed" });
          return;
        case "checkFailed":
          safeSetPhase({ kind: "error", failure: "check-failed" });
          return;
        case "join":
          safeSetPhase({ kind: "join", failure: step.failure });
          return;
        case "abandoned":
          return;
      }
    },
    [leave, safeSetPhase],
  );

  const startPairing = useCallback(
    async (link: PairingLink): Promise<void> => {
      const name = deviceNameRef.current.trim() || defaultDeviceNameRef.current;
      // Submitted (I1): `pair()` now holds the only copy of the secret
      // this screen ever had — drop the ref immediately rather than wait
      // for the outcome.
      pendingLinkRef.current = null;
      safeSetPhase({ kind: "waiting" });
      const outcome = await pair(
        { transport, clock: realClock, client: CLIENT_STRING, platform: PLATFORM },
        link,
        name,
      );
      if (!outcome.ok) {
        safeSetPhase({ kind: "error", failure: outcome.reason });
        return;
      }
      // The user left while it waited: nothing switches behind them.
      if (!mountedRef.current) return;
      applyStep(await savePairing(sessions.addAndSwitch, outcome.record, outcome.credential));
    },
    [applyStep, sessions, safeSetPhase],
  );

  const startJoin = useCallback(
    async (nameText: string, password: string): Promise<void> => {
      if (phaseRef.current.kind !== "join") return;
      const name = deviceNameRef.current.trim() || defaultDeviceNameRef.current;
      applyStep(
        await submitJoin(
          {
            isHeld,
            atLimit,
            waiting: () => safeSetPhase({ kind: "waiting", join: true }),
            join: (address, secret) =>
              joinMachine(
                { transport, clock: realClock, client: CLIENT_STRING, platform: PLATFORM },
                address,
                secret,
                name,
              ),
            stillWanted: () => mountedRef.current,
            addAndSwitch: sessions.addAndSwitch,
          },
          nameText,
          password,
        ),
      );
    },
    [applyStep, atLimit, isHeld, sessions, safeSetPhase],
  );

  const intake = useCallback(
    (uri: string) => {
      // Important-2, ruling C1b: every link — scanned, pasted or a deep link
      // — goes through this same pure classification, which can only ever
      // stop short of `pair()`.
      const result = intakeLink({ phaseKind: phaseRef.current.kind, uri, isHeld, atLimit });
      switch (result.kind) {
        case "dropped":
          return;
        case "invalid":
          safeSetPhase({ kind: "error", failure: "invalid-link" });
          return;
        case "checkFailed":
          safeSetPhase({ kind: "error", failure: "check-failed" });
          return;
        case "limit":
          safeSetPhase({ kind: "error", failure: "limit" });
          return;
        case "sameMachine":
          safeSetPhase({ kind: "sameMachine", id: result.id });
          return;
        case "step":
          pendingLinkRef.current = result.link;
          safeSetPhase(result.step);
          return;
      }
    },
    [atLimit, isHeld, safeSetPhase],
  );

  // A cold-start `jarvis://` link is stashed by `app/+native-intent.tsx`
  // (via pairing-link-holder.ts) before this screen ever mounts. Consumed
  // once the screen has actually reached "scan" (never earlier: a deep
  // link that arrived while still "checking" must not be dropped, but
  // must also not jump the already-paired check).
  useEffect(() => {
    if (phase.kind !== "scan") return;
    const url = takePairingLink();
    if (url !== null) {
      intake(url);
    }
  }, [phase, intake]);

  // A warm-start link (the app already running, on this screen) arrives
  // through the same holder — `+native-intent.tsx` stashes it and notifies
  // subscribers. Always taken (never left to resurface later), but only
  // acted on while actually in "scan" — otherwise dropped, the same as a
  // second concurrent link always was (ruling C1c).
  useEffect(() => {
    return subscribePairingLink(() => {
      const url = takePairingLink();
      if (url !== null && phaseRef.current.kind === "scan") {
        intake(url);
      }
    });
  }, [intake]);

  function handleBarcodeScanned(result: { data: string }): void {
    if (scannedRef.current) return;
    scannedRef.current = true;
    intake(result.data);
  }

  function handlePasteSubmit(): void {
    const uri = pastedLink.trim();
    // Cleared immediately after parsing (successful or not): the field
    // never keeps a rendered copy of a link that carries the secret.
    setPastedLink("");
    if (uri.length === 0) return;
    intake(uri);
  }

  function handleHostSubmit(): void {
    const pending = pendingLinkRef.current;
    if (pending === null) return;
    const text = hostText.trim();
    const step = hostStep(pending, text);
    if (step.kind === "invalid") {
      // I3: keep the scanned link in the ref so the user can retype the
      // host, instead of discarding it and forcing a re-scan.
      safeSetPhase({ kind: "needsHost", invalid: true });
      return;
    }
    const resolved = withHost(pending, text);
    if (resolved === undefined) {
      // Defensive: `hostStep` already validated this exact text with the
      // same `withHost`, so this branch is unreachable in practice.
      safeSetPhase({ kind: "needsHost", invalid: true });
      return;
    }
    // Its id is known only now. Same answers as `intakeLink`'s.
    let sameId: MachineId | undefined;
    try {
      sameId = heldAfterHost(resolved, isHeld);
    } catch {
      pendingLinkRef.current = null;
      safeSetPhase({ kind: "error", failure: "check-failed" });
      return;
    }
    if (sameId !== undefined) {
      pendingLinkRef.current = null;
      safeSetPhase({ kind: "sameMachine", id: sameId });
      return;
    }
    if (atLimit()) {
      pendingLinkRef.current = null;
      safeSetPhase({ kind: "error", failure: "limit" });
      return;
    }
    pendingLinkRef.current = resolved;
    safeSetPhase(step);
  }

  function handleConfirm(): void {
    const pending = pendingLinkRef.current;
    if (pending === null) return;
    void startPairing(pending);
  }

  function handleCancelConfirm(): void {
    pendingLinkRef.current = null;
    scannedRef.current = false;
    safeSetPhase({ kind: "scan" });
  }

  function retry(): void {
    scannedRef.current = false;
    pendingLinkRef.current = null;
    safeSetPhase({ kind: "scan" });
  }

  const backTarget = pairBackTarget({
    phaseKind: phase.kind,
    onScreen: sessions.current().id,
    clearFailedId: clearFailedIdRef.current,
    held,
  });

  return (
    <View style={[styles.container, { paddingTop: insets.top + 8 }, cardRoot]}>
      <View style={styles.titleRow}>
        {backTarget !== undefined && (
          <IconButton
            icon="back"
            label={t(language, "common.back")}
            onPress={() => {
              pendingLinkRef.current = null;
              void openMachine(backTarget);
            }}
            mirrorInRtl={screenHeaderModel({ language, hasBack: true }).backMirrored}
          />
        )}
        <Text style={styles.title}>
          {t(language, phase.kind === "join" ? "pair.joinTitle" : "pair.title")}
        </Text>
      </View>

      {phase.kind === "clearFailed" && (
        <>
          <Text style={styles.errorText}>{t(language, "pair.clearFailed")}</Text>
          {/* No Dashboard button here — reaching it would just reconnect
              with the still-stored, now-revoked token and loop back to
              this exact screen. The back button goes to another machine. */}
          <TouchableOpacity style={styles.button} onPress={() => void retryClear()}>
            <Text style={styles.buttonText}>{t(language, "common.retry")}</Text>
          </TouchableOpacity>
        </>
      )}

      {phase.kind === "sameMachine" && (
        <>
          <Text style={styles.label}>{t(language, "pair.sameMachine")}</Text>
          <TouchableOpacity style={styles.button} onPress={() => void openMachine(phase.id)}>
            <Text style={styles.buttonText}>{t(language, "pair.openMachine")}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={handleCancelConfirm}>
            <Text style={styles.buttonText}>{t(language, "common.cancel")}</Text>
          </TouchableOpacity>
        </>
      )}

      {phase.kind === "join" && (
        <JoinForm
          language={language}
          name={joinName}
          onNameChange={setJoinName}
          failure={phase.failure}
          onSubmit={(name, password) => void startJoin(name, password)}
          onCancel={handleCancelConfirm}
        />
      )}

      {phase.kind === "scan" && (
        <ScrollView
          style={styles.scanScroll}
          contentContainerStyle={styles.scanContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.scanArea}>
            {permission === null ? null : permission.granted ? (
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={handleBarcodeScanned}
              />
            ) : (
              <Text style={styles.cameraPermissionText}>
                {t(language, "pair.cameraPermission")}
              </Text>
            )}
            <View pointerEvents="none" style={styles.finder}>
              <View style={[styles.corner, styles.topStart]} />
              <View style={[styles.corner, styles.topEnd]} />
              <View style={[styles.corner, styles.bottomStart]} />
              <View style={[styles.corner, styles.bottomEnd]} />
              <View style={styles.scanLine} />
            </View>
          </View>
          <Text style={styles.label}>{t(language, "pair.scan")}</Text>

          <TouchableOpacity style={styles.button} onPress={() => safeSetPhase({ kind: "join" })}>
            <Text style={styles.buttonText}>{t(language, "pair.joinTitle")}</Text>
          </TouchableOpacity>

          <Text style={styles.label}>{t(language, "pair.pasteLink")}</Text>
          <TextInput
            style={styles.input}
            value={pastedLink}
            onChangeText={setPastedLink}
            onSubmitEditing={handlePasteSubmit}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="jarvis://pair?..."
            placeholderTextColor={theme.colors.textMuted}
          />
          <TouchableOpacity style={styles.button} onPress={handlePasteSubmit}>
            <Text style={styles.buttonText}>{t(language, "common.ok")}</Text>
          </TouchableOpacity>

          <Text style={styles.label}>{t(language, "pair.deviceName")}</Text>
          <TextInput
            style={styles.input}
            value={deviceName}
            onChangeText={setDeviceName}
            autoCorrect={false}
          />
        </ScrollView>
      )}

      {phase.kind === "needsHost" && (
        <>
          <Text style={styles.label}>{t(language, "pair.hostNeeded")}</Text>
          {phase.invalid && <Text style={styles.errorText}>{t(language, "pair.hostInvalid")}</Text>}
          <TextInput
            style={styles.input}
            value={hostText}
            onChangeText={setHostText}
            onSubmitEditing={handleHostSubmit}
            autoCapitalize="none"
            autoCorrect={false}
            placeholderTextColor={theme.colors.textMuted}
          />
          <TouchableOpacity style={styles.button} onPress={handleHostSubmit}>
            <Text style={styles.buttonText}>{t(language, "common.ok")}</Text>
          </TouchableOpacity>
        </>
      )}

      {phase.kind === "confirm" && (
        <>
          {phase.name !== undefined && (
            <Text style={styles.label}>
              {t(language, "pair.confirmName", { name: phase.name })}
            </Text>
          )}
          <Text style={styles.label}>
            {t(language, "pair.confirm", {
              host: phase.host,
              port: phase.port,
              tail: phase.fingerprintTail,
            })}
          </Text>
          <Text style={styles.label}>
            {t(language, phase.name !== undefined ? "pair.trustSystem" : "pair.trustPinned")}
          </Text>
          <TouchableOpacity style={styles.button} onPress={handleConfirm}>
            <Text style={styles.buttonText}>{t(language, "pair.confirmButton")}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={handleCancelConfirm}>
            <Text style={styles.buttonText}>{t(language, "common.cancel")}</Text>
          </TouchableOpacity>
        </>
      )}

      {phase.kind === "waiting" && (
        <>
          <ActivityIndicator color={theme.colors.primary} />
          {phase.join !== true && (
            <Text style={styles.label}>{t(language, "pair.waitingApproval")}</Text>
          )}
        </>
      )}

      {phase.kind === "error" && (
        <>
          <Text style={styles.errorText}>{t(language, errorKey(phase.failure))}</Text>
          <TouchableOpacity
            style={styles.button}
            onPress={phase.failure === "check-failed" ? () => void checkMachines() : retry}
          >
            <Text style={styles.buttonText}>{t(language, "common.retry")}</Text>
          </TouchableOpacity>
        </>
      )}

      {phase.kind === "success" && <Text style={styles.label}>{t(language, "pair.success")}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-start",
    backgroundColor: theme.colors.background,
    paddingHorizontal: 24,
    paddingTop: 74,
    paddingBottom: 34,
    gap: 10,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    gap: 8,
    marginBottom: 6,
  },
  title: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.font.size.xl,
    fontFamily: theme.font.bold,
    textAlign: "auto",
  },
  scanScroll: { alignSelf: "stretch" },
  scanContent: { alignItems: "center", gap: 10 },
  scanArea: {
    width: "100%",
    height: 342,
    borderRadius: 22,
    backgroundColor: theme.colors.terminalGround,
    borderColor: theme.colors.hairline,
    borderWidth: 1,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  cameraPermissionText: {
    color: theme.colors.textDim,
    fontFamily: theme.font.body,
    fontSize: 12,
    textAlign: "center",
    padding: theme.spacing.lg,
  },
  finder: { position: "absolute", width: 220, height: 220 },
  corner: { position: "absolute", width: 34, height: 34, borderColor: theme.colors.accent },
  topStart: { start: 0, top: 0, borderStartWidth: 3, borderTopWidth: 3, borderTopStartRadius: 10 },
  topEnd: { end: 0, top: 0, borderEndWidth: 3, borderTopWidth: 3, borderTopEndRadius: 10 },
  bottomStart: {
    start: 0,
    bottom: 0,
    borderStartWidth: 3,
    borderBottomWidth: 3,
    borderBottomStartRadius: 10,
  },
  bottomEnd: {
    end: 0,
    bottom: 0,
    borderEndWidth: 3,
    borderBottomWidth: 3,
    borderBottomEndRadius: 10,
  },
  scanLine: {
    position: "absolute",
    start: 12,
    end: 12,
    top: 108,
    height: 2,
    backgroundColor: theme.colors.accent,
    opacity: 0.7,
  },
  label: {
    color: theme.colors.textDim,
    fontFamily: theme.font.semibold,
    fontSize: 12,
    textAlign: "center",
  },
  input: {
    width: "100%",
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.control,
    paddingHorizontal: 14,
    height: 48,
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    fontFamily: theme.font.mono,
    fontSize: 13,
  },
  button: {
    backgroundColor: theme.colors.primary,
    minWidth: 52,
    minHeight: 44,
    borderRadius: theme.radius.control,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: {
    color: theme.colors.primaryText,
    fontSize: theme.font.size.md,
    fontFamily: theme.font.bold,
    textAlign: "center",
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: theme.font.size.md,
    textAlign: "center",
  },
});
