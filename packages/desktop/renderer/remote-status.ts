import type { RemoteStatus } from "@jarvis/remote";
import type { RendererApi } from "../src/ipc.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { currentView } from "./views.js";

// The renderer-wide picture of the remote bridge: one cached RemoteStatus,
// pushed here from main (onRemoteStatus) and pulled once at startup
// (remoteStatus), fanned out to whoever wants to know (Settings' pair area
// and device list) without each of them holding its own subscription or
// racing the initial fetch against the first push.
//
// No innerHTML anywhere below: every device name and the pairing link carry
// attacker-reachable text (a phone names itself; the link embeds a secret),
// so both are always assigned via textContent/text nodes, names isolated in
// a <bdi> — never concatenated into markup.

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

let latest: RemoteStatus | undefined;
let lastListeningAddress: { host: string; port: number } | undefined;
const listeners = new Set<(status: RemoteStatus) => void>();
let decide: RendererApi["decideRemotePairing"] | undefined;

/** The request the dialog is currently built for, whether shown or already
 *  decided — reset only when a *different* requestId arrives, so a fresh
 *  request always regains its own once-only guard. */
let dialogRequestId: string | undefined;
/** The requestId Approve/Deny has already resolved — set on the first click
 *  (or Escape) and checked before ever calling decideRemotePairing again, so
 *  a double click, an Escape after a click, or the same status pushed twice
 *  cannot call it a second time, and cannot resurrect a dialog whose buttons
 *  would then be dead (bound to a request nobody can decide any more). */
let decidedRequestId: string | undefined;
let dialogKeyListener: ((event: KeyboardEvent) => void) | undefined;
/** What had focus before the dialog opened, restored when it closes. */
let focusBeforeDialog: HTMLElement | undefined;

/** The countdown bar's own 1s clock: armed when the dialog opens, cleared
 *  when it hides. app.ts already runs a 1s tick for the clock/prayer ring,
 *  but this module doesn't import app.ts (app.ts imports *this* module,
 *  and reaching back would be a cycle), so the bar keeps its own timer
 *  rather than reuse that one. */
let countdownTimer: ReturnType<typeof setInterval> | undefined;
let countdownExpiresAt: number | undefined;
/** The window's length as observed at the moment the bar was armed — the
 *  bar's 100% reference point. Not the pairing TTL constant (this module
 *  never imports @jarvis/remote's policy): whatever was left of the window
 *  when the dialog opened is "full" for the purposes of this bar. */
let countdownWindowMs: number | undefined;
/** Under this many ms remaining, the bar switches from accent to amber. */
const COUNTDOWN_WARN_MS = 30_000;

/** `before`/`after` come from MESSAGES.*Parts — the template split on its
 *  own placeholder, not on the name itself (see messages.ts). Rebuilt as
 *  text-before / a <bdi>name</bdi> / text-after, so an attacker-chosen
 *  device name can never become markup, no matter what characters — or
 *  which of the template's own words — it contains. Exported: settings.ts's
 *  "waiting to confirm" note needs the same construction. */
export function withNameInBdi(before: string, name: string, after: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(document.createTextNode(before));
  const bdi = document.createElement("bdi");
  bdi.textContent = name;
  fragment.append(bdi);
  fragment.append(document.createTextNode(after));
  return fragment;
}

/** Called once, at app startup: pulls the current status, subscribes to
 *  pushes, and renders the indicator and the confirmation dialog from
 *  whichever arrives. A rejected initial pull is logged rather than thrown —
 *  a broken first read must not break the rest of startup (the same reason
 *  app.ts wraps this call in its own try/catch), but it must not vanish
 *  silently either. */
export function initRemoteStatus(
  api: Pick<RendererApi, "remoteStatus" | "onRemoteStatus" | "decideRemotePairing">,
): void {
  decide = api.decideRemotePairing;
  wireIndicatorClick();
  wireConfirmButtons();
  api.onRemoteStatus((status) => {
    try {
      handleStatus(status);
    } catch (error) {
      console.error(`remote-status: rendering a pushed status failed: ${String(error)}`);
    }
  });
  api
    .remoteStatus()
    .then((status) => handleStatus(status))
    .catch((error: unknown) => {
      console.error(`remote-status: initial remoteStatus() failed: ${String(error)}`);
    });
}

function handleStatus(status: RemoteStatus): void {
  latest = status;
  renderRemoteIndicator(status);
  renderPairingConfirmation(status);
  for (const listener of [...listeners]) listener(status);
}

export function latestRemoteStatus(): RemoteStatus | undefined {
  return latest;
}

export function onRemoteStatusChange(listener: (status: RemoteStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Tracks which actual DOM elements already carry a listener, rather than a
// plain module-level boolean: production markup never replaces these
// elements, but a test harness rebuilds the DOM (and re-imports nothing)
// between cases, and a boolean would leave the second harness's button
// silently unwired.
const wired = new WeakSet<Element>();

function wireIndicatorClick(): void {
  const pill = $("remote-pill");
  if (wired.has(pill)) return;
  wired.add(pill);
  pill.addEventListener("click", () => {
    $("nav-settings").click();
  });
}

export function renderRemoteIndicator(status: RemoteStatus): void {
  const pill = $("remote-pill");
  // The topbar's board 0 replaces the coloured dot with a wifi glyph
  // (green listening / amber idle-armed / grey off) — an SVG whose
  // `stroke="currentColor"` picks up whichever of these classes is set, the
  // same tri-state the dot used to carry in its own three modifier classes.
  const glyph = pill.querySelector<HTMLElement>(".remote-glyph");
  glyph?.classList.remove("remote-glyph--good", "remote-glyph--warn", "remote-glyph--off");
  if (status.listening === undefined) {
    const idleDisabled = status.idle?.kind === "disabled" ? status.idle : undefined;
    pill.hidden = idleDisabled === undefined || lastListeningAddress === undefined;
    if (pill.hidden || idleDisabled === undefined || lastListeningAddress === undefined) return;
    $("remote-pill-text").textContent = `${lastListeningAddress.host}:${lastListeningAddress.port}`;
    glyph?.classList.add("remote-glyph--off");
    pill.title = MESSAGES.remoteIdleDisabled(
      idleDisabled.at,
      idleDisabled.afterMinutes,
      PRIMARY_LANGUAGE,
    );
    return;
  }

  const { host, port } = status.listening;
  lastListeningAddress = { host, port };
  pill.hidden = false;
  const pairingOpen = status.pairing.kind !== "closed";
  $("remote-pill-text").textContent = `${host}:${port}`;
  if (status.idle?.kind === "armed") {
    glyph?.classList.add("remote-glyph--warn");
    pill.title = MESSAGES.remoteIndicatorIdleAt(status.idle.disableAt, PRIMARY_LANGUAGE);
  } else {
    glyph?.classList.add("remote-glyph--good");
    pill.title = MESSAGES.remoteIndicator(host, port, pairingOpen, PRIMARY_LANGUAGE);
  }
}

function stopDialogKeyListener(): void {
  if (dialogKeyListener === undefined) return;
  document.removeEventListener("keydown", dialogKeyListener);
  dialogKeyListener = undefined;
}

function stopCountdown(): void {
  if (countdownTimer !== undefined) {
    clearInterval(countdownTimer);
    countdownTimer = undefined;
  }
  countdownExpiresAt = undefined;
  countdownWindowMs = undefined;
}

/** One frame of the countdown bar: shrinks linearly from 100% (armed) to 0%
 *  (expiresAt), turning amber under COUNTDOWN_WARN_MS remaining. Reads the
 *  clock itself rather than taking `now` as a parameter — both its callers
 *  (the arm below and the 1s interval) want "right now" and neither has a
 *  more meaningful instant to pass instead. */
function renderCountdownBar(): void {
  if (countdownExpiresAt === undefined || countdownWindowMs === undefined) return;
  const remainingMs = Math.max(0, countdownExpiresAt - Date.now());
  const pct = Math.min(100, (remainingMs / countdownWindowMs) * 100);
  const bar = $("remote-confirm-countdown-bar");
  // inlineSize, not width: styles.css's rule for this bar transitions
  // inline-size, keeping this element on the same logical-properties-only
  // discipline as the rest of the redesigned dialog.
  bar.style.inlineSize = `${pct}%`;
  bar.classList.toggle("remote-confirm-countdown-bar--warn", remainingMs <= COUNTDOWN_WARN_MS);
}

function startCountdown(expiresAt: number): void {
  stopCountdown();
  countdownExpiresAt = expiresAt;
  // Guard against a zero/negative window (an already-expired request, or a
  // clock skewed against the bridge's) — a zero divisor would render NaN%.
  countdownWindowMs = Math.max(1, expiresAt - Date.now());
  renderCountdownBar();
  countdownTimer = setInterval(renderCountdownBar, 1000);
}

function hideConfirm(): void {
  $("remote-confirm").hidden = true;
  stopDialogKeyListener();
  stopCountdown();
  focusBeforeDialog?.focus();
  focusBeforeDialog = undefined;
}

function resolvePairing(requestId: string, approve: boolean): void {
  // Guards a double click, and an Escape that lands after a click already
  // resolved this same request — decideRemotePairing must fire exactly once
  // per requestId.
  if (decidedRequestId === requestId) return;
  decidedRequestId = requestId;
  decide?.(requestId, approve)?.catch((error: unknown) => {
    console.error(`remote-status: decideRemotePairing failed: ${String(error)}`);
  });
  hideConfirm();
}

/** Keeps Tab cycling between the dialog's only two controls while it is
 *  open, alongside the Escape-denies behaviour — one listener, one
 *  lifecycle, both stopped together by stopDialogKeyListener. */
function dialogKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    if (dialogRequestId !== undefined) resolvePairing(dialogRequestId, false);
    return;
  }
  if (event.key !== "Tab") return;
  const approve = $("remote-confirm-approve");
  const deny = $("remote-confirm-deny");
  const active = document.activeElement;
  if (active !== approve && active !== deny) return;
  event.preventDefault();
  (active === approve ? deny : approve).focus();
}

function wireConfirmButtons(): void {
  const approve = $("remote-confirm-approve");
  if (!wired.has(approve)) {
    wired.add(approve);
    approve.addEventListener("click", () => {
      if (dialogRequestId !== undefined) resolvePairing(dialogRequestId, true);
    });
  }
  const deny = $("remote-confirm-deny");
  if (!wired.has(deny)) {
    wired.add(deny);
    deny.addEventListener("click", () => {
      if (dialogRequestId !== undefined) resolvePairing(dialogRequestId, false);
    });
  }
}

export function renderPairingConfirmation(status: RemoteStatus): void {
  if (status.pairing.kind !== "confirming") {
    dialogRequestId = undefined;
    hideConfirm();
    return;
  }

  const { requestId, deviceName, address, expiresAt } = status.pairing;

  // Already decided (Approve/Deny/Escape already fired for this exact
  // request): never resurrect the dialog — its buttons would call
  // decideRemotePairing again for a request the bridge has already
  // resolved, and the main process would just ignore the second call, but
  // the phone's user would see a dialog that looks live and isn't.
  if (decidedRequestId === requestId) {
    hideConfirm();
    return;
  }

  const isNewRequest = requestId !== dialogRequestId;
  if (isNewRequest) {
    dialogRequestId = requestId;
    // A hosted WebContentsView (an Editor/Database/Cluster/Chat/API tab
    // inside the Workspace route) is a native child of the window and
    // ignores CSS z-index entirely — same reason setup-overlay only ever
    // shows on a route with no hosted view (styles.css). Route to Settings
    // first, the same target the pill's own click already uses, so the
    // dialog is never rendered invisibly underneath a native view.
    if (currentView() === "workspace") $("nav-settings").click();
  }

  $("remote-confirm-title").textContent = MESSAGES.remoteConfirmTitle(PRIMARY_LANGUAGE);
  $("remote-confirm-subtitle").textContent = MESSAGES.remoteConfirmSubtitle(PRIMARY_LANGUAGE);
  $("remote-confirm-device-label").textContent =
    MESSAGES.remoteConfirmDeviceLabel(PRIMARY_LANGUAGE);
  $("remote-confirm-from-label").textContent = MESSAGES.remoteConfirmFromLabel(PRIMARY_LANGUAGE);
  // The facts row's "Device" value: just the name, isolated in a <bdi> —
  // never a sentence here (the warning line below carries the sentence).
  $("remote-confirm-body").replaceChildren(withNameInBdi("", deviceName, ""));
  // P15/D4: the connecting address, so the person deciding can tell a
  // photographed QR — same claimed name, different address — from the
  // device sitting in front of them. Not user-supplied text (it is the
  // socket's own remote address, node-io.ts), but still textContent, never
  // baked into markup, matching the rest of this dialog's discipline.
  // The row is already labelled "From" (remoteConfirmFromLabel); the value is
  // the bare address, not a second sentence saying "From address:" again.
  $("remote-confirm-from").textContent = address;
  // The warning line: the spec's "what approving this grants" sentence,
  // the name spliced in the same withNameInBdi way as the facts row above.
  const warningParts = MESSAGES.remoteConfirmBodyParts(PRIMARY_LANGUAGE);
  $("remote-confirm-warning-text").replaceChildren(
    withNameInBdi(warningParts.before, deviceName, warningParts.after),
  );
  $("remote-confirm-approve").textContent = MESSAGES.remoteConfirmApprove(PRIMARY_LANGUAGE);
  $("remote-confirm-deny").textContent = MESSAGES.remoteConfirmDeny(PRIMARY_LANGUAGE);

  const dialog = $("remote-confirm");
  const wasHidden = dialog.hidden;

  // Show/focus/attach-listeners only on the transition into view — a status
  // re-pushed for the same still-undecided request (a periodic refresh, a
  // second onRemoteStatus firing) must not steal focus back to Deny if the
  // user has since tabbed elsewhere in the dialog, or reopen listeners that
  // are already attached.
  if (isNewRequest || wasHidden) {
    focusBeforeDialog =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.hidden = false;
    $("remote-confirm-deny").focus();

    stopDialogKeyListener();
    dialogKeyListener = dialogKeydown;
    document.addEventListener("keydown", dialogKeyListener);

    startCountdown(expiresAt);
  }
}
