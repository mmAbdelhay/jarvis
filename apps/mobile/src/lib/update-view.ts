// What the Settings Updates card and the Home banner show for each updater
// state. Pure: the store decides what happens; this only words it.
import { t, type Language } from "./i18n";
import type { PhoneUpdateView, UpdateState } from "./phone-update-types";

export type UpdateCardView = {
  installed: string;
  /** The newer version on offer; wherever the platform checks. */
  newest: string | undefined;
  lastChecked: string | undefined;
  status: string | undefined;
  error: string | undefined;
  /** Release notes, drawn collapsed; Android only. */
  notes: string | undefined;
  /** Undefined where the platform never checks (web). */
  check: { label: string; disabled: boolean } | undefined;
  /** Undefined when there is nothing to install, or the platform cannot. */
  update: { label: string; disabled: boolean } | undefined;
  /** 0..1 while downloading. */
  progress: number | undefined;
};

const BUSY: ReadonlySet<UpdateState["kind"]> = new Set(["checking", "downloading", "verifying"]);

function offeredVersion(state: UpdateState): string | undefined {
  switch (state.kind) {
    case "available":
    case "downloading":
    case "verifying":
    case "ready":
      return state.version;
    case "failed":
      return state.version;
    default:
      return undefined;
  }
}

function percent(progress: number): number {
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}

function errorText(language: Language, state: UpdateState): string | undefined {
  if (state.kind !== "failed") return undefined;
  switch (state.reason) {
    case "offline":
      return t(language, "updates.error.offline");
    case "download":
      return t(language, "updates.error.download");
    case "checksum":
      return t(language, "updates.error.checksum");
    case "install":
      return t(language, "updates.error.install");
  }
}

function statusText(language: Language, state: UpdateState, current: string): string | undefined {
  switch (state.kind) {
    case "checking":
      return t(language, "updates.checking");
    case "current":
      return t(language, "updates.current", { version: current });
    case "ready":
      return t(language, "updates.ready", { version: state.version });
    default:
      return undefined;
  }
}

function updateButton(
  language: Language,
  state: UpdateState,
): { label: string; disabled: boolean } | undefined {
  switch (state.kind) {
    case "available":
    case "ready":
      return { label: t(language, "updates.update"), disabled: false };
    case "downloading":
      return {
        label: t(language, "updates.downloading", { percent: percent(state.progress) }),
        disabled: true,
      };
    case "verifying":
      return { label: t(language, "updates.verifying"), disabled: true };
    case "failed":
      // A failed check has nothing to install; a failed update can retry.
      return state.version === undefined
        ? undefined
        : { label: t(language, "updates.update"), disabled: false };
    default:
      return undefined;
  }
}

export function updateCardView(view: PhoneUpdateView, language: Language): UpdateCardView {
  const { state } = view;
  const offered = view.canCheck ? offeredVersion(state) : undefined;
  return {
    installed: t(language, "updates.installed", { version: view.current }),
    newest: offered === undefined ? undefined : t(language, "updates.newest", { version: offered }),
    lastChecked:
      view.lastCheckedAt !== undefined
        ? t(language, "updates.lastChecked", {
            time: new Date(view.lastCheckedAt).toLocaleString(language === "ar" ? "ar" : "en-US", {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          })
        : undefined,
    status: statusText(language, state, view.current),
    error: errorText(language, state),
    notes:
      view.canInstall && state.kind === "available" && state.notes.trim() !== ""
        ? state.notes
        : undefined,
    check: view.canCheck
      ? { label: t(language, "updates.checkNow"), disabled: BUSY.has(state.kind) }
      : undefined,
    update: view.canInstall ? updateButton(language, state) : undefined,
    progress: view.canInstall && state.kind === "downloading" ? state.progress : undefined,
  };
}

/** Home's "Update available" banner text, or undefined when there is none:
 *  only an update this phone can install, waiting or downloaded. */
export function updateBannerText(view: PhoneUpdateView, language: Language): string | undefined {
  if (!view.canInstall) return undefined;
  const { state } = view;
  if (state.kind === "available") {
    return t(language, "updates.bannerAvailable", { version: state.version });
  }
  if (state.kind === "ready") {
    return t(language, "updates.bannerReady", { version: state.version });
  }
  return undefined;
}
