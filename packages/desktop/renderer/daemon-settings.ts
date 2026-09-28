// Settings → General: "Keep Jarvis running in the background" (Task 23).
//
// The toggle commits on change — no Save — because what it does is not a
// draft edit: the Electron host confirms, then installs or removes the
// background service and moves the core (daemon/mode.ts). The status line
// is the host's own reading (background:status), drawn by the pure
// daemonSettingsView below and refreshed every few seconds while Settings
// is on screen. No innerHTML: every string goes in through textContent.
import type { ChangeResult, DaemonStatus } from "../src/daemon/mode.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";

type Language = "ar" | "en";

export const DAEMON_STATUS_POLL_MS = 2_000;

export type DaemonSettingsView = {
  toggleOn: boolean;
  /** The status line. */
  line: string;
  /** The daemon log's last line, under a failure. */
  logLine?: string;
  warning: boolean;
  /** Restart daemon and Stop now act on a running daemon: shown only while
   *  the core is in it. */
  showDaemonActions: boolean;
};

/** What the General section shows for `status` — pure, so the mapping is
 *  tested without a DOM. */
export function daemonSettingsView(status: DaemonStatus, language: Language): DaemonSettingsView {
  const base = { toggleOn: status.enabled, showDaemonActions: !status.inApp };
  const { state } = status;
  switch (state.kind) {
    case "starting":
      return { ...base, line: MESSAGES.daemonStateStarting(language), warning: false };
    case "running":
      return {
        ...base,
        line: MESSAGES.daemonStateRunning(
          state.pid,
          MESSAGES.daemonUptime(state.uptimeMs, language),
          language,
        ),
        warning: false,
      };
    case "failed":
      return {
        ...base,
        line: MESSAGES.daemonStateFailed(state.reason, language),
        ...(state.lastLogLine === undefined
          ? {}
          : { logLine: MESSAGES.daemonLastLogLine(state.lastLogLine, language) }),
        warning: true,
      };
    case "off":
      return {
        ...base,
        line:
          status.enabled && status.inApp
            ? MESSAGES.daemonStateOffSession(language)
            : MESSAGES.daemonStateOff(language),
        warning: false,
      };
  }
}

/** The line a change that did not happen leaves; undefined when it did or
 *  the user cancelled. */
export function changeMessage(result: ChangeResult, language: Language): string | undefined {
  if (result.ok) return undefined;
  switch (result.reason) {
    case "cancelled":
      return undefined;
    case "busy":
      return MESSAGES.daemonBusy(language);
    case "failed":
      return MESSAGES.daemonChangeFailed(result.detail, language);
  }
}

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

let pending = false;
let message: string | undefined;
let last: DaemonStatus | undefined;

function render(): void {
  const language = PRIMARY_LANGUAGE;
  // Not laid down (a test harness drawing other routes only): nothing to draw.
  if (document.getElementById("settings-daemon-enabled") === null) return;
  const toggle = $("settings-daemon-enabled") as HTMLInputElement;
  const state = $("settings-daemon-state");
  const log = $("settings-daemon-log");
  const restart = $("settings-daemon-restart") as HTMLButtonElement;
  const stop = $("settings-daemon-stop") as HTMLButtonElement;
  toggle.disabled = pending || last === undefined;
  if (last === undefined) return;
  const view = daemonSettingsView(
    pending ? { ...last, state: { kind: "starting" } } : last,
    language,
  );
  toggle.checked = view.toggleOn;
  state.textContent = message ?? view.line;
  state.classList.toggle("settings-note--warning", message !== undefined || view.warning);
  log.textContent = view.logLine ?? "";
  log.hidden = view.logLine === undefined;
  restart.hidden = !view.showDaemonActions;
  stop.hidden = !view.showDaemonActions;
  restart.disabled = pending;
  stop.disabled = pending;
}

async function refresh(): Promise<void> {
  try {
    last = await window.jarvis.backgroundStatus();
  } catch {
    // The last reading stands.
  }
  render();
}

async function change(run: () => Promise<ChangeResult>): Promise<void> {
  if (pending) return;
  pending = true;
  message = undefined;
  render();
  let result: ChangeResult;
  try {
    result = await run();
  } catch (error) {
    result = {
      ok: false,
      reason: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  pending = false;
  message = changeMessage(result, PRIMARY_LANGUAGE);
  await refresh();
}

/** Once, at app start (initSettings): the labels and the listeners. */
export function initDaemonSettings(): void {
  const language = PRIMARY_LANGUAGE;
  $("settings-general-title").textContent = MESSAGES.daemonGeneral(language).toUpperCase();
  const nav = document.getElementById("settings-nav-general");
  if (nav) nav.textContent = MESSAGES.daemonGeneral(language);
  $("settings-daemon-label").textContent = MESSAGES.daemonTitle(language);
  $("settings-daemon-note").textContent = MESSAGES.daemonDescription(language);
  $("settings-daemon-restart").textContent = MESSAGES.daemonRestart(language);
  $("settings-daemon-stop").textContent = MESSAGES.daemonStopNow(language);

  const toggle = $("settings-daemon-enabled") as HTMLInputElement;
  toggle.addEventListener("change", () => {
    const wanted = toggle.checked;
    // Drawn from the host's answer, not the click: a cancelled confirm
    // leaves the switch where it was.
    toggle.checked = !wanted;
    void change(() => window.jarvis.setBackgroundEnabled(wanted));
  });
  $("settings-daemon-restart").addEventListener("click", () => {
    void change(() => window.jarvis.restartBackground());
  });
  $("settings-daemon-stop").addEventListener("click", () => {
    void change(() => window.jarvis.stopBackgroundNow());
  });

  // Uptime and a reconnecting daemon, kept current while Settings shows.
  setInterval(() => {
    const view = document.getElementById("view-settings");
    if (view !== null && !view.hidden && !pending) void refresh();
  }, DAEMON_STATUS_POLL_MS);
}

/** Every time Settings opens. */
export function refreshDaemonSettings(): Promise<void> {
  message = undefined;
  return refresh();
}
