// The browser build's pairing screen (Task 13). Same flow and guards as
// app/pair.tsx — the already-paired check fails closed, a pairing only
// starts from the entry step and only after the user confirms — minus the
// camera and the host-entry step:
//
// - The link arrives in the page URL's fragment
//   (`https://<name>:<webPort>/pair#<jarvis:// query>`). It is read once on
//   load and cleared from the address bar and history straight away with
//   `history.replaceState`, then held in a ref (never state) until the
//   already-paired check lets it through. A pasted link (web or jarvis://
//   form) takes the same path.
// - A fingerprint-only link is refused: a browser cannot pin a
//   certificate, so browser access needs Tailscale with a real
//   certificate (`linkRefusedOn`). The browser build always dials through
//   the system transport.
// - The device name defaults from the user agent and stays editable.
//
// The login/unlock step after pairing arrives with Task 13b; until then a
// successful pairing goes to the Dashboard exactly as on native.
//
// With nothing paired, a page served by a machine that describes itself at
// `/jarvis-peer.json` also offers joining that machine with the owner password.
// No passkey offer follows a join.
import type { PairingLink, PeerInfo } from "@jarvis/wire";
import Constants from "expo-constants";
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
import { clientPlatformFor, clientStringFor } from "@/lib/client-platform";
import { realClock } from "@/lib/clock";
import { AuthCard, useAuthCardRootStyle } from "@/components/WidePanel";
import { platformKey, t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import {
  type AlreadyPairedCheck,
  canStartIntake,
  type ConfirmStep,
  entryPhaseKind,
  intakeStep,
  type JoinFailure,
  joinFailureKey,
  type JoinStep,
  phaseAfterCheck,
  submitJoin,
} from "@/lib/pair-flow";
import { setPasskeyOfferSignal } from "@/lib/passkey-offer-signal";
import { useMachineSessions, useNavigatorGate } from "@/lib/machine-context";
import { type MachineId, MAX_MACHINES } from "@/lib/machine-index";
import { prepareSwitchRoute, retryClear as retryClearOf } from "@/lib/machine-sessions";
import { machineStore, openMachineStore } from "@/lib/machine-store-instance";
import { joinMachine, linkRefusedOn, pair, type PairOutcome } from "@/lib/pairing";
import { PairingAlreadyExistsError } from "@/lib/pairing-record";
import { leavePairScreen } from "@/lib/scope-routing";
import { systemTransportFor } from "@/lib/system-transport";
import { theme } from "@/lib/theme";
import { OWN_PEER_TIMEOUT_MS, readOwnPeer } from "@/lib/web-machines";
import {
  CLEARED_HASH_PARAM,
  deviceNameFromUserAgent,
  fragmentArrivalAction,
  pairingLinkFromHash,
  pairingLinkFromText,
} from "@/lib/web-pairing";

const CLIENT_STRING = clientStringFor(Platform.OS, Constants.expoConfig?.version ?? "0.0.0");
const PLATFORM = clientPlatformFor(Platform.OS);
const transport = systemTransportFor(PLATFORM);

type PairFailureReason = Exclude<PairOutcome, { ok: true }>["reason"];
type ScreenFailure = PairFailureReason | "save-failed" | "check-failed";

type Phase =
  | { kind: "checking" }
  | { kind: "alreadyPaired" }
  | { kind: "clearFailed" }
  | { kind: "scan" }
  | ConfirmStep
  | { kind: "waiting"; join?: boolean }
  | { kind: "error"; failure: ScreenFailure }
  | { kind: "success" };

function errorKey(reason: ScreenFailure) {
  switch (reason) {
    case "invalid-link":
      return "pair.linkInvalid" as const;
    case "web-needs-certificate":
    // A browser never pins, so a pin mismatch cannot happen here; the
    // honest copy for any pin-shaped failure is the certificate one.
    case "fingerprint":
      return "pair.webNeedsCertificate" as const;
    case "denied":
      return "pair.denied" as const;
    case "expired":
      return "pair.expired" as const;
    case "timeout":
      return "pair.timeout" as const;
    case "unreachable":
      return "pair.unreachable" as const;
    case "save-failed":
      return "pair.saveFailed" as const;
    case "check-failed":
      return "pair.checkFailed" as const;
    case "protocol":
    case "busy":
    case "host-needed":
      return "pair.protocol" as const;
  }
}

/** Removes the fragment from the address bar and the current history
 * entry, so the secret never lingers where a later visitor, a bookmark or
 * the history list could find it. */
function clearLocationHash(): void {
  const { hash, pathname, search } = window.location;
  if (hash.length > 0) {
    window.history.replaceState(window.history.state, "", `${pathname}${search}`);
  }
}

// Wide layout: a centred card instead of a full-screen page (the logic
// below is the same on every screen size).
export default function PairWebScreenRoute() {
  return (
    <AuthCard>
      <PairWebScreen />
    </AuthCard>
  );
}

/** The owner password for the machine serving this page. The field keeps it only
 *  until submit, as on app/pair.tsx. */
function JoinHereForm(props: {
  name: string;
  failure: JoinFailure | undefined;
  onSubmit(password: string): void;
}) {
  const language = useLanguage();
  const [password, setPassword] = useState("");

  function submit(): void {
    const read = password;
    setPassword("");
    if (read.length === 0) return;
    props.onSubmit(read);
  }

  return (
    <>
      <Text style={styles.label}>{t(language, "pair.joinHere")}</Text>
      <Text style={styles.label}>{props.name}</Text>
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
      {props.failure !== undefined && (
        <Text style={styles.errorText}>{t(language, joinFailureKey(props.failure))}</Text>
      )}
      <TouchableOpacity style={styles.button} onPress={submit}>
        <Text style={styles.buttonText}>{t(language, "pair.joinHere")}</Text>
      </TouchableOpacity>
    </>
  );
}

function PairWebScreen() {
  const cardRoot = useAuthCardRootStyle();
  const language = useLanguage();
  const router = useRouter();
  const gate = useNavigatorGate();
  const sessions = useMachineSessions();
  const clearFailedIdRef = useRef<MachineId | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [pastedLink, setPastedLink] = useState("");
  const [deviceName, setDeviceName] = useState(() =>
    deviceNameFromUserAgent(typeof navigator === "undefined" ? "" : navigator.userAgent),
  );
  const deviceNameRef = useRef(deviceName);
  deviceNameRef.current = deviceName;
  const mountedRef = useRef(true);
  const phaseRef = useRef<Phase>(phase);
  const alreadyPairedRef = useRef(false);
  // The only holders of the secret-bearing link: the raw fragment until
  // the entry step consumes it, then the parsed link until it is handed
  // to `pair()` or dropped. Neither is ever rendered.
  const hashRef = useRef<string | null>(null);
  const pendingLinkRef = useRef<PairingLink | null>(null);
  const joinCancelRef = useRef<AbortController | null>(null);
  const peerAskedRef = useRef(false);
  const [ownPeer, setOwnPeer] = useState<PeerInfo | undefined>(undefined);
  const [joinFailure, setJoinFailure] = useState<JoinFailure | undefined>(undefined);

  if (hashRef.current === null) {
    // Captured during the first render, before anything else touches it.
    hashRef.current = typeof window === "undefined" ? "" : window.location.hash;
  }

  const safeSetPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    if (mountedRef.current) setPhase(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // Expo Router parses the fragment into this route's `#` param and its
    // first history sync (the root's effect, which runs after this one)
    // writes it back into the URL. So: drop the param from the router's
    // state, and clear the address bar on the next tick, after that sync.
    router.setParams({ "#": CLEARED_HASH_PARAM });
    const timer = setTimeout(clearLocationHash, 0);
    return () => {
      clearTimeout(timer);
      mountedRef.current = false;
      pendingLinkRef.current = null;
      joinCancelRef.current?.abort();
    };
  }, [router]);

  const checkAlreadyPaired = useCallback(async () => {
    safeSetPhase({ kind: "checking" });
    let check: AlreadyPairedCheck;
    try {
      await openMachineStore();
      const machines = await machineStore.list();
      check = { ok: true, paired: machines.length > 0 };
    } catch {
      console.warn("pair: reading the machines failed while checking for an existing pairing");
      check = { ok: false };
    }
    const nextKind = phaseAfterCheck(check);
    alreadyPairedRef.current = nextKind !== "scan";
    if (nextKind !== "scan") hashRef.current = "";
    if (nextKind === "checkFailed") {
      safeSetPhase({ kind: "error", failure: "check-failed" });
      return;
    }
    safeSetPhase({ kind: nextKind });
  }, [safeSetPhase]);

  useEffect(() => {
    const signal = takeClearFailedSignal();
    clearFailedIdRef.current = signal?.id ?? null;
    if (entryPhaseKind(signal !== undefined) === "clearFailed") {
      alreadyPairedRef.current = true;
      hashRef.current = "";
      safeSetPhase({ kind: "clearFailed" });
      return;
    }
    void checkAlreadyPaired();
  }, [checkAlreadyPaired, safeSetPhase]);

  const retryClear = useCallback(async () => {
    // The machine the signal named, with its session's memory of the token.
    if ((await retryClearOf(sessions, clearFailedIdRef.current)) === "scan") {
      alreadyPairedRef.current = false;
      safeSetPhase({ kind: "scan" });
      return;
    }
    console.warn("pair: retrying the clear failed");
    safeSetPhase({ kind: "clearFailed" });
  }, [sessions, safeSetPhase]);

  const intake = useCallback(
    (link: PairingLink | undefined) => {
      if (
        !canStartIntake({
          held: alreadyPairedRef.current,
          phaseKind: phaseRef.current.kind,
        })
      ) {
        return;
      }
      if (link === undefined) {
        safeSetPhase({ kind: "error", failure: "invalid-link" });
        return;
      }
      if (linkRefusedOn(link, PLATFORM)) {
        safeSetPhase({ kind: "error", failure: "web-needs-certificate" });
        return;
      }
      const step = intakeStep(link);
      if (step.kind !== "confirm") {
        // Unreachable: a link with a `name` never needs a host.
        safeSetPhase({ kind: "error", failure: "invalid-link" });
        return;
      }
      pendingLinkRef.current = link;
      safeSetPhase(step);
    },
    [safeSetPhase],
  );

  // The fragment link, consumed once the entry step is reached.
  useEffect(() => {
    if (phase.kind !== "scan") return;
    const hash = hashRef.current ?? "";
    hashRef.current = "";
    if (hash.length > 1) intake(pairingLinkFromHash(hash));
  }, [phase, intake]);

  // Asked once, at the entry step: anything but this machine's own answer leaves
  // the screen as it was.
  useEffect(() => {
    if (phase.kind !== "scan" || peerAskedRef.current) return;
    peerAskedRef.current = true;
    void readOwnPeer(fetch, window.location, OWN_PEER_TIMEOUT_MS).then((peer) => {
      if (mountedRef.current) setOwnPeer(peer);
    });
  }, [phase]);

  // D6b: a `/pair#…` link entered while this screen is already open is a
  // hashchange, not a load — read it, clear it from the address bar the
  // same way, and act on it like a fresh load would.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHashChange = () => {
      const hash = window.location.hash;
      if (hash.length <= 1) return;
      router.setParams({ "#": CLEARED_HASH_PARAM });
      clearLocationHash();
      setTimeout(clearLocationHash, 0);
      switch (fragmentArrivalAction(phaseRef.current.kind)) {
        case "intake":
          intake(pairingLinkFromHash(hash));
          break;
        case "hold":
          hashRef.current = hash;
          break;
        case "drop":
          break;
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [router, intake]);

  const startPairing = useCallback(
    async (link: PairingLink): Promise<void> => {
      const name = deviceNameRef.current.trim() || deviceNameFromUserAgent(navigator.userAgent);
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
      try {
        await machineStore.add(outcome.record, outcome.credential);
      } catch (err) {
        if (err instanceof PairingAlreadyExistsError) {
          alreadyPairedRef.current = true;
          safeSetPhase({ kind: "alreadyPaired" });
          return;
        }
        safeSetPhase({ kind: "error", failure: "save-failed" });
        return;
      }
      safeSetPhase({ kind: "success" });
      // Next: the owner password on the unlock screen, which then offers
      // adding a passkey for this browser.
      setPasskeyOfferSignal();
      router.replace("/dashboard");
    },
    [router, safeSetPhase],
  );

  const applyJoinStep = useCallback(
    (step: JoinStep) => {
      switch (step.kind) {
        case "success":
          safeSetPhase({ kind: "success" });
          // Through the gate: the switch's remount may have taken the navigator.
          leavePairScreen({
            gate,
            screenUp: () => mountedRef.current,
            toDashboard: () => prepareSwitchRoute(router, gate, (line) => console.warn(line)),
          });
          return;
        // This browser's one place was taken while the password was on its way.
        case "sameMachine":
        case "limit":
          alreadyPairedRef.current = true;
          safeSetPhase({ kind: "alreadyPaired" });
          return;
        case "saveFailed":
          safeSetPhase({ kind: "error", failure: "save-failed" });
          return;
        case "checkFailed":
          safeSetPhase({ kind: "error", failure: "check-failed" });
          return;
        case "join":
          setJoinFailure(step.failure);
          safeSetPhase({ kind: "scan" });
          return;
        case "abandoned":
          return;
      }
    },
    [gate, router, safeSetPhase],
  );

  const startJoin = useCallback(
    async (peer: PeerInfo, password: string): Promise<void> => {
      if (phaseRef.current.kind !== "scan" || alreadyPairedRef.current) return;
      const name = deviceNameRef.current.trim() || deviceNameFromUserAgent(navigator.userAgent);
      const cancel = new AbortController();
      joinCancelRef.current = cancel;
      setJoinFailure(undefined);
      const running = submitJoin(
        {
          isHeld: (id) => machineStore.has(id),
          atLimit: () => machineStore.count() >= MAX_MACHINES,
          waiting: () => safeSetPhase({ kind: "waiting", join: true }),
          join: (address, secret) =>
            joinMachine(
              { transport, clock: realClock, client: CLIENT_STRING, platform: PLATFORM },
              address,
              secret,
              name,
              cancel.signal,
            ),
          stillWanted: () => mountedRef.current,
          addAndSwitch: sessions.addAndSwitch,
          add: sessions.add,
        },
        `${peer.name}:${peer.bridgePort}`,
        password,
      );
      // This frame lasts through the wait, and has no more use for it.
      password = "";
      applyJoinStep(await running);
    },
    [applyJoinStep, safeSetPhase, sessions],
  );

  function handlePasteSubmit(): void {
    const text = pastedLink;
    // Cleared at once: the field never keeps a rendered copy of the secret.
    setPastedLink("");
    if (text.trim().length === 0) return;
    intake(pairingLinkFromText(text));
  }

  function handleConfirm(): void {
    const pending = pendingLinkRef.current;
    if (pending === null) return;
    void startPairing(pending);
  }

  function backToEntry(): void {
    pendingLinkRef.current = null;
    safeSetPhase({ kind: "scan" });
  }

  return (
    <View style={[styles.container, cardRoot]}>
      <Text style={styles.title}>{t(language, "pair.title")}</Text>

      {phase.kind === "checking" && <ActivityIndicator color={theme.colors.primary} />}

      {phase.kind === "alreadyPaired" && (
        <>
          <Text style={styles.label}>
            {t(language, platformKey("pair.alreadyPaired", PLATFORM))}
          </Text>
          <TouchableOpacity style={styles.button} onPress={() => router.replace("/dashboard")}>
            <Text style={styles.buttonText}>{t(language, "nav.dashboard")}</Text>
          </TouchableOpacity>
        </>
      )}

      {phase.kind === "clearFailed" && (
        <>
          <Text style={styles.errorText}>
            {t(language, platformKey("pair.clearFailed", PLATFORM))}
          </Text>
          <TouchableOpacity style={styles.button} onPress={() => void retryClear()}>
            <Text style={styles.buttonText}>{t(language, "common.retry")}</Text>
          </TouchableOpacity>
        </>
      )}

      {phase.kind === "scan" && (
        <>
          {ownPeer !== undefined && (
            <JoinHereForm
              name={ownPeer.name}
              failure={joinFailure}
              onSubmit={(password) => void startJoin(ownPeer, password)}
            />
          )}
          <Text style={styles.label}>{t(language, "pair.pasteLink")}</Text>
          <TextInput
            style={styles.input}
            value={pastedLink}
            onChangeText={setPastedLink}
            onSubmitEditing={handlePasteSubmit}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="https://…/pair#…"
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
          <Text style={styles.label}>{t(language, platformKey("pair.trustSystem", PLATFORM))}</Text>
          <Text style={styles.label}>{t(language, "pair.deviceName")}</Text>
          <TextInput
            style={styles.input}
            value={deviceName}
            onChangeText={setDeviceName}
            autoCorrect={false}
          />
          <TouchableOpacity style={styles.button} onPress={handleConfirm}>
            <Text style={styles.buttonText}>{t(language, "pair.confirmButton")}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={backToEntry}>
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
          <Text style={styles.errorText}>
            {t(language, platformKey(errorKey(phase.failure), PLATFORM))}
          </Text>
          <TouchableOpacity
            style={styles.button}
            onPress={
              phase.failure === "check-failed" ? () => void checkAlreadyPaired() : backToEntry
            }
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
    paddingTop: 48,
    paddingBottom: 34,
    gap: 10,
    width: "100%",
    maxWidth: 480,
    alignSelf: "center",
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.font.size.xl,
    fontFamily: theme.font.bold,
    textAlign: "auto",
    alignSelf: "stretch",
    marginBottom: 6,
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
