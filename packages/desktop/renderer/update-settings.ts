import type { RunningCounts, UpdateError, UpdateState } from "../src/updater.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { PERSONAL_PROJECT } from "../src/personal.js";
import { formatAgo, formatBytes } from "./format.js";

// Settings → General → Updates. Main's updater (updater.ts) checks once at
// launch and once a day, as the user chose; Check now asks it again. The
// request is one GET to GitHub's public releases API: no token, nothing
// about this machine. This card only draws the updater's state and passes
// the user's presses back; it decides nothing about what to install.

/** Release notes are a preview; Full notes opens the whole page. */
const NOTE_LINES = 20;

const language = PRIMARY_LANGUAGE;

/** Errors a fresh download can get past. The install blockers (read-only,
 *  translocated, not-appimage, dev-build) need the user to move or rerun the app
 *  first, so downloading again would only fail the same way. */
const RETRYABLE: ReadonlySet<UpdateError | undefined> = new Set<UpdateError | undefined>([
  "download",
  "mismatch",
  "no-sums",
  "swap",
  "offline",
]);

const $ = (id: string): HTMLElement | null => document.getElementById(id);

type Ui = {
  check: HTMLButtonElement;
  version: HTMLElement;
  status: HTMLElement;
  card: HTMLElement;
  title: HTMLElement;
  notes: HTMLElement;
  progress: HTMLElement;
  fill: HTMLElement;
  bytes: HTMLElement;
  cancel: HTMLButtonElement;
  confirm: HTMLElement;
  confirmText: HTMLElement;
  installNow: HTMLButtonElement;
  later: HTMLButtonElement;
  install: HTMLButtonElement;
  notesLink: HTMLButtonElement;
};

/** The card's elements, or undefined when the page has no Updates card. */
function findUi(): Ui | undefined {
  const button = (id: string): HTMLButtonElement | undefined => {
    const element = $(id);
    return element instanceof HTMLButtonElement ? element : undefined;
  };
  const ui = {
    check: button("settings-update-check"),
    version: $("settings-update-version"),
    status: $("settings-update-status"),
    card: $("settings-update-card"),
    title: $("settings-update-title"),
    notes: $("settings-update-notes"),
    progress: $("settings-update-progress"),
    fill: $("settings-update-fill"),
    bytes: $("settings-update-bytes"),
    cancel: button("settings-update-cancel"),
    confirm: $("settings-update-confirm"),
    confirmText: $("settings-update-confirm-text"),
    installNow: button("settings-update-install-now"),
    later: button("settings-update-later"),
    install: button("settings-update-install"),
    notesLink: button("settings-update-notes-link"),
  };
  return Object.values(ui).every((element) => element !== undefined && element !== null)
    ? (ui as Ui)
    : undefined;
}

export function initUpdateSettings(): void {
  const ui = findUi();
  if (ui === undefined) return;
  const {
    check,
    version,
    status,
    card,
    title,
    notes,
    progress,
    fill,
    bytes,
    cancel,
    confirm,
    confirmText,
    installNow,
    later,
    install,
    notesLink,
  } = ui;
  const dot = $("nav-settings-dot");

  check.textContent = MESSAGES.updateCheckNow(language);
  cancel.textContent = MESSAGES.updateCancel(language);
  installNow.textContent = MESSAGES.updateInstallNow(language);
  later.textContent = MESSAGES.updateLater(language);
  notesLink.textContent = MESSAGES.updateFullNotes(language);
  if (dot !== null) dot.title = MESSAGES.updateNavDot(language);

  let state: UpdateState | undefined;
  /** The confirm is open: ready, and the user has not said Later. */
  let confirming = false;
  /** Undefined while asking, or when the core could not answer. */
  let counts: RunningCounts | undefined;
  /** A press already sent and not yet answered; a second press is dropped. */
  let downloadSent = false;
  let installSent = false;

  function render(): void {
    if (state === undefined) return;
    const { phase } = state;
    const named = MESSAGES.updateVersion(state.current, language);
    version.textContent =
      state.lastChecked === undefined
        ? named
        : `${named} · ${MESSAGES.updateLastChecked(
            formatAgo(state.lastChecked, Date.now(), language),
            language,
          )}`;
    check.disabled =
      phase === "checking" ||
      phase === "downloading" ||
      phase === "verifying" ||
      phase === "installing";

    status.textContent =
      phase === "checking"
        ? MESSAGES.updateChecking(language)
        : phase === "current"
          ? MESSAGES.updateCurrent(state.current, language)
          : phase === "installing"
            ? MESSAGES.updateInstalling(language)
            : phase === "error" && state.error !== undefined
              ? MESSAGES.updateError(state.error, language)
              : "";
    status.classList.toggle("settings-note--warning", phase === "error");

    const latest = state.latest;
    card.hidden = latest === undefined && state.url === undefined;
    title.textContent =
      latest === undefined
        ? ""
        : phase === "ready"
          ? MESSAGES.updateReady(latest, language)
          : MESSAGES.updateNewer(latest, state.current, language);
    // Plain text only: a release body is never parsed as markup.
    notes.textContent = (state.notes ?? "").split("\n").slice(0, NOTE_LINES).join("\n");
    notes.hidden = notes.textContent === "";
    notesLink.hidden = state.url === undefined || phase === "installing";

    progress.hidden = !(phase === "downloading" || phase === "verifying");
    cancel.hidden = phase !== "downloading";
    if (phase === "downloading") {
      const received = state.received ?? 0;
      const total = state.total ?? 0;
      const share = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
      fill.style.width = `${share}%`;
      bytes.textContent = MESSAGES.updateDownloading(
        formatBytes(received),
        formatBytes(total),
        language,
      );
    } else if (phase === "verifying") {
      fill.style.width = "100%";
      bytes.textContent = MESSAGES.updateVerifying(language);
    }

    confirm.hidden = !(phase === "ready" && confirming);
    if (!confirm.hidden) confirmText.textContent = MESSAGES.updateRestartEnds(counts, language);

    // Available, or a failed download or install that a fresh download can
    // retry. Ready after Later offers Install now, which asks again.
    const canDownload =
      latest !== undefined &&
      (phase === "available" || (phase === "error" && RETRYABLE.has(state.error)));
    install.hidden = !(canDownload || (phase === "ready" && !confirming));
    install.textContent =
      phase === "ready" ? MESSAGES.updateInstallNow(language) : MESSAGES.updateInstall(language);
    install.disabled = downloadSent;
    installNow.disabled = installSent;

    if (dot !== null) dot.hidden = !(phase === "available" || phase === "ready");
  }

  function openConfirm(): void {
    confirming = true;
    counts = undefined;
    render();
    void window.jarvis
      .updateCounts()
      .then((answer) => {
        counts = answer;
      })
      .catch(() => {
        counts = undefined;
      })
      .finally(render);
  }

  function apply(next: UpdateState): void {
    const before = state?.phase;
    state = next;
    if (next.phase !== "ready") confirming = false;
    if (next.phase !== "installing") installSent = false;
    // A download that just finished asks once. Ready again after Later, a
    // re-check, or Windows' installer opening does not ask on its own.
    if (next.phase === "ready" && (before === "downloading" || before === "verifying")) {
      openConfirm();
      return;
    }
    render();
  }

  window.jarvis.onUpdateState(apply);

  check.addEventListener("click", () => {
    check.disabled = true;
    void window.jarvis
      .updateCheck()
      .then(apply)
      .catch(() => {
        // Before any state arrived, render() draws nothing, so the button
        // must come back here.
        check.disabled = false;
        render();
      });
  });

  install.addEventListener("click", () => {
    if (state?.phase === "ready") {
      openConfirm();
      return;
    }
    if (downloadSent) return;
    downloadSent = true;
    install.disabled = true;
    void window.jarvis
      .updateDownload()
      .then(apply)
      .catch(() => undefined)
      .finally(() => {
        downloadSent = false;
        render();
      });
  });

  cancel.addEventListener("click", () => {
    void window.jarvis.updateCancel().then(apply, () => render());
  });

  installNow.addEventListener("click", () => {
    if (installSent) return;
    installSent = true;
    installNow.disabled = true;
    void window.jarvis
      .updateInstall()
      .then(apply)
      .catch(() => {
        installSent = false;
        render();
      });
  });

  later.addEventListener("click", () => {
    confirming = false;
    render();
  });

  // In the Personal browser, which belongs to no project — a release page
  // is not project work.
  notesLink.addEventListener("click", () => {
    const url = state?.url;
    if (url !== undefined) void window.jarvis.openTab(PERSONAL_PROJECT, url);
  });

  // "last checked 5m ago" is drawn when state arrives; redraw it whenever
  // Settings is opened so it does not keep saying "just now".
  $("nav-settings")?.addEventListener("click", render);
}
