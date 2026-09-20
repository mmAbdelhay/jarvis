import { parsePairingUri } from "@jarvis/wire";
import type { PairingLink } from "@jarvis/wire";
import { CameraView, useCameraPermissions } from "expo-camera";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { takeClearFailedSignal } from "@/lib/clear-failed-signal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { realClock } from "@/lib/clock";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { nativeTransport } from "@/lib/native-transport";
import {
  afterClearRetry,
  type AlreadyPairedCheck,
  canStartIntake,
  entryPhaseKind,
  hostStep,
  intakeStep,
  phaseAfterCheck,
  shouldDrainPairingLink,
} from "@/lib/pair-flow";
import { pair, type PairOutcome, withHost } from "@/lib/pairing";
import { subscribePairingLink, takePairingLink } from "@/lib/pairing-link-holder";
import {
  clearPairing,
  loadPairing,
  PairingAlreadyExistsError,
  savePairing,
} from "@/lib/pairing-record";
import { expoSecureStore } from "@/lib/secure-store";
import { systemTransport } from "@/lib/system-transport";
import { theme } from "@/lib/theme";
import { createTrustRoutingTransport } from "@/lib/trust-routing-transport";

const CLIENT_STRING = `jarvis-mobile/${Constants.expoConfig?.version ?? "0.0.0"}/${Platform.OS}`;
// M11 rule 6: constructed once, module-wide — a link with a `name` pairs
// through `systemTransport` (OS trust store), one without pins natively
// through `nativeTransport`, exactly as before.
const transport = createTrustRoutingTransport({ pin: nativeTransport, system: systemTransport });

type PairFailureReason = Exclude<PairOutcome, { ok: true }>["reason"];
// Screen-only conditions (I5, Important-1): `pair()` itself either
// succeeded and the keychain write afterwards failed, or the mount-time
// "is this phone already paired" check itself failed to read the keychain.
type ScreenFailure = PairFailureReason | "save-failed" | "check-failed";

type Phase =
  | { kind: "checking" }
  | { kind: "alreadyPaired" }
  // Reached when the laptop unpaired this phone and `_layout.tsx`'s
  // `onUnpaired` handler couldn't clear the stored record — distinct from
  // `alreadyPaired` on purpose, so the screen never shows "already paired"
  // right under a banner that just said "this phone was unpaired", and
  // never offers the Dashboard button that would only reconnect with the
  // now-revoked token (task-6-rereview-r1.md).
  | { kind: "clearFailed" }
  | { kind: "scan" }
  | { kind: "needsHost"; invalid?: boolean }
  | { kind: "confirm"; host: string; port: number; fingerprintTail: string; name?: string }
  | { kind: "waiting" }
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

export default function PairScreen() {
  const insets = useSafeAreaInsets();
  const language = useLanguage();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [hostText, setHostText] = useState("");
  const [pastedLink, setPastedLink] = useState("");
  const [deviceName, setDeviceName] = useState("");
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
  const alreadyPairedRef = useRef(false);

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

  // C1a / Important-1: while a pairing record already exists, this screen
  // refuses to start any pairing at all — deep link, scan or paste —
  // until the user has explicitly unpaired. A `loadPairing` failure fails
  // *closed*: `phaseAfterCheck` never routes a failed check to "scan",
  // so a transient keychain error can never unlock scanning.
  const checkAlreadyPaired = useCallback(async () => {
    safeSetPhase({ kind: "checking" });
    let check: AlreadyPairedCheck;
    try {
      const loaded = await loadPairing(expoSecureStore);
      check = { ok: true, paired: loaded !== undefined };
    } catch {
      // Logged without any secret: just the fact that the check failed.
      console.warn("pair: loadPairing failed while checking for an existing pairing");
      check = { ok: false };
    }
    const nextKind = phaseAfterCheck(check);
    alreadyPairedRef.current = nextKind !== "scan";
    // R-M1: a link stashed for a phone that turns out to be already
    // paired (or whose check itself failed) must not linger in the
    // holder — drained here so it can never resurface at a later scan
    // phase, e.g. after the user unpairs.
    if (shouldDrainPairingLink(nextKind)) {
      takePairingLink();
    }
    if (nextKind === "checkFailed") {
      safeSetPhase({ kind: "error", failure: "check-failed" });
      return;
    }
    safeSetPhase({ kind: nextKind });
  }, [safeSetPhase]);

  useEffect(() => {
    // Arriving with the one-shot clearFailed signal set (clear-failed-
    // signal.ts, consumed here — never a route param, which a forged
    // `jarvis://pair?...&clearFailed=1` link could set) goes straight to
    // that phase — never through `checkAlreadyPaired`, which would find
    // the still-present record and show the contradictory "already
    // paired" screen instead.
    const entryKind = entryPhaseKind(takeClearFailedSignal());
    if (entryKind === "clearFailed") {
      alreadyPairedRef.current = true;
      // R-M1: same reasoning as the checkAlreadyPaired branch above.
      if (shouldDrainPairingLink(entryKind)) {
        takePairingLink();
      }
      safeSetPhase({ kind: "clearFailed" });
      return;
    }
    void checkAlreadyPaired();
    // Runs once, on mount: `takeClearFailedSignal()` is one-shot by design
    // (consuming it again on a later `checkAlreadyPaired` identity change
    // would read `false` and silently skip the phase), and both callbacks
    // are otherwise stable.
  }, [checkAlreadyPaired, safeSetPhase]);

  // The clearFailed phase's own retry — calls clearPairing directly (never
  // checkAlreadyPaired: a retry that just cleared the record is already
  // known to have nothing left to find) and moves on to "scan" only once
  // it actually succeeds.
  const retryClear = useCallback(async () => {
    let cleared: boolean;
    try {
      await clearPairing(expoSecureStore);
      cleared = true;
    } catch {
      // Logged without any secret: just the fact that the retry failed.
      console.warn("pair: retrying clearPairing failed");
      cleared = false;
    }
    const next = afterClearRetry(cleared);
    if (next === "scan") {
      alreadyPairedRef.current = false;
      safeSetPhase({ kind: "scan" });
      return;
    }
    safeSetPhase({ kind: "clearFailed" });
  }, [safeSetPhase]);

  const startPairing = useCallback(
    async (link: PairingLink): Promise<void> => {
      const name = deviceNameRef.current.trim() || defaultDeviceNameRef.current;
      // Submitted (I1): `pair()` now holds the only copy of the secret
      // this screen ever had — drop the ref immediately rather than wait
      // for the outcome.
      pendingLinkRef.current = null;
      safeSetPhase({ kind: "waiting" });
      const outcome = await pair(
        { transport, clock: realClock, client: CLIENT_STRING },
        link,
        name,
      );
      if (!outcome.ok) {
        safeSetPhase({ kind: "error", failure: outcome.reason });
        return;
      }
      try {
        await savePairing(expoSecureStore, outcome.record, outcome.credential);
      } catch (err) {
        if (err instanceof PairingAlreadyExistsError) {
          // Important-1, defence in depth: the mount-time check said "not
          // paired", but a valid record exists by the time this write
          // happened (e.g. a concurrent pairing elsewhere) — `savePairing`
          // itself refused rather than overwrite it.
          alreadyPairedRef.current = true;
          safeSetPhase({ kind: "alreadyPaired" });
          return;
        }
        // I5: a keychain write failure must not leave the screen stuck on
        // "Waiting for approval…" forever.
        safeSetPhase({ kind: "error", failure: "save-failed" });
        return;
      }
      safeSetPhase({ kind: "success" });
      router.replace("/dashboard");
    },
    [router, safeSetPhase],
  );

  const intake = useCallback(
    (uri: string) => {
      if (
        !canStartIntake({
          alreadyPaired: alreadyPairedRef.current,
          phaseKind: phaseRef.current.kind,
        })
      ) {
        return;
      }
      const link = parsePairingUri(uri);
      if (link === undefined) {
        safeSetPhase({ kind: "error", failure: "invalid-link" });
        return;
      }
      pendingLinkRef.current = link;
      // Important-2, ruling C1b: every link — scanned, pasted or a deep
      // link — goes through this same pure classification, which can only
      // ever produce "needsHost" or "confirm"; nothing here can start
      // `pair()`.
      const step = intakeStep(link);
      if (step.kind === "needsHost") {
        safeSetPhase({ kind: "needsHost" });
        return;
      }
      safeSetPhase(step);
    },
    [safeSetPhase],
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

  return (
    <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
      <Text style={styles.title}>{t(language, "pair.title")}</Text>

      {phase.kind === "alreadyPaired" && (
        <>
          <Text style={styles.label}>{t(language, "pair.alreadyPaired")}</Text>
          <TouchableOpacity style={styles.button} onPress={() => router.replace("/dashboard")}>
            <Text style={styles.buttonText}>{t(language, "nav.dashboard")}</Text>
          </TouchableOpacity>
        </>
      )}

      {phase.kind === "clearFailed" && (
        <>
          <Text style={styles.errorText}>{t(language, "pair.clearFailed")}</Text>
          {/* No Dashboard button here — reaching it would just reconnect
              with the still-stored, now-revoked token and loop back to
              this exact screen. */}
          <TouchableOpacity style={styles.button} onPress={() => void retryClear()}>
            <Text style={styles.buttonText}>{t(language, "common.retry")}</Text>
          </TouchableOpacity>
        </>
      )}

      {phase.kind === "scan" && (
        <>
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
        </>
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
          <Text style={styles.label}>{t(language, "pair.waitingApproval")}</Text>
        </>
      )}

      {phase.kind === "error" && (
        <>
          <Text style={styles.errorText}>{t(language, errorKey(phase.failure))}</Text>
          <TouchableOpacity
            style={styles.button}
            onPress={phase.failure === "check-failed" ? () => void checkAlreadyPaired() : retry}
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
  title: {
    color: theme.colors.text,
    fontSize: theme.font.size.xl,
    fontFamily: theme.font.bold,
    textAlign: "auto",
    alignSelf: "stretch",
    marginBottom: 6,
  },
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
