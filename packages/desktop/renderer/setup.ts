import type { PrerequisiteId, PrerequisiteStatus } from "@jarvis/platform";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";

// The first-run prerequisites screen.
//
// An overlay rather than a route: it has no nav button, it sits above
// whatever is behind it, and Skip closes it for good — which it did not do
// until the CSS beneath it was fixed, because `.setup-overlay` set `display`
// on its base rule and out-cascaded the UA `[hidden]` rule. See
// setup-overlay-css.test.ts. It is never a gate — the
// app is behind it and working, and a user who wants to get on with things
// can.
//
// It opens on a first run, and on any launch where a *required* prerequisite
// is missing, because an app with no agent CLI has nothing to offer and
// finding that out one failed session at a time is the experience this
// replaces.

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

/** Ticked on open. Required rows are ticked and cannot be unticked; anything
 *  Jarvis can install without root starts ticked; everything else is a line
 *  to read. */
function initialSelection(statuses: readonly PrerequisiteStatus[]): Set<PrerequisiteId> {
  return new Set(statuses.filter((s) => s.installable).map((s) => s.id));
}

type SetupBridge = {
  platform: NodeJS.Platform;
  checkPrerequisites(): Promise<PrerequisiteStatus[]>;
  installPrerequisite(id: string): Promise<{ ok: boolean; detail?: string }>;
  onInstallOutput(cb: (chunk: string) => void): void;
};

let selected = new Set<PrerequisiteId>();
let statuses: PrerequisiteStatus[] = [];
let installing = false;
/** Why a row failed, kept across the re-render that follows an install run.
 *  Without it the reason vanished the moment the run finished — and the
 *  reason is the whole of what this screen has to offer over the error
 *  messages it replaces. */
const failures = new Map<PrerequisiteId, string>();

/** Whether this document actually carries the overlay.
 *
 *  Every test harness in this codebase lays down only the markup its own
 *  subject needs, and this screen is not most subjects' concern. A boot step
 *  that threw on a document without it would fail dozens of unrelated tests
 *  for a screen they never open — so absence is a no-op rather than an error,
 *  the same way blockNav being undefined leaves a pane's keys to xterm. */
function present(): boolean {
  return document.getElementById("setup-overlay") !== null;
}

/** Wires the overlay's own controls once. Called from app.ts at boot. */
export function initSetup(bridge: SetupBridge): void {
  if (!present()) return;
  bridge.onInstallOutput((chunk) => appendOutput(chunk));
  $("setup-skip").addEventListener("click", () => closeSetup());
  $("setup-install").addEventListener("click", () => void install(bridge));
}

/** Opens the overlay if there is a reason to. Returns whether it opened, so
 *  a caller can tell "nothing to do" from "shown". */
export async function openSetupIfNeeded(bridge: SetupBridge, firstRun: boolean): Promise<boolean> {
  if (!present()) return false;
  statuses = await bridge.checkPrerequisites();
  const missingRequired = statuses.some((s) => isRequired(s.id) && !s.installed);
  if (!firstRun && !missingRequired) return false;
  openSetup(bridge);
  return true;
}

/** Opens it unconditionally — the Settings button. */
export async function openSetup(bridge: SetupBridge): Promise<void> {
  if (!present()) return;
  statuses = await bridge.checkPrerequisites();
  selected = initialSelection(statuses);
  render(bridge);
  $("setup-overlay").hidden = false;
}

export function closeSetup(): void {
  if (!present()) return;
  $("setup-overlay").hidden = true;
}

/** The catalogue's one required entry. Hard-coded here rather than imported,
 *  because a renderer module may not import a value from a workspace package
 *  — see the conventions doc. The id is asserted against the catalogue in
 *  setup.test.ts so the two cannot drift. */
const REQUIRED: readonly PrerequisiteId[] = ["agent"];
function isRequired(id: PrerequisiteId): boolean {
  return REQUIRED.includes(id);
}

function appendOutput(chunk: string): void {
  const log = $("setup-output");
  log.hidden = false;
  log.textContent = `${log.textContent ?? ""}${chunk}`;
  log.scrollTop = log.scrollHeight;
}

function render(bridge: SetupBridge): void {
  const language = PRIMARY_LANGUAGE;
  $("setup-title").textContent = MESSAGES.setupTitle(language);
  $("setup-intro").textContent = MESSAGES.setupIntro(language);

  // No notice today. It carried "Jarvis does not run on Windows yet", which
  // stopped being true when the Windows port landed; the element stays so
  // the next thing worth saying here has somewhere to go.
  $("setup-notice").hidden = true;

  const list = $("setup-list");
  list.replaceChildren();

  for (const status of statuses) {
    // Nothing to show for something already installed that is also not
    // interesting — but a tick beside what is there is most of the
    // reassurance this screen offers, so they stay.
    list.append(row(status, language, bridge));
  }

  updateInstallButton(language);
}

function row(status: PrerequisiteStatus, language: "ar" | "en", bridge: SetupBridge): HTMLElement {
  const element = document.createElement("div");
  element.className = "setup-row";

  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "setup-row__box";
  box.checked = selected.has(status.id);
  // Required stays ticked: unticking the one thing without which the app has
  // no purpose is not a choice worth offering.
  box.disabled = !status.installable || isRequired(status.id) || installing;
  box.addEventListener("change", () => {
    if (box.checked) selected.add(status.id);
    else selected.delete(status.id);
    updateInstallButton(language);
  });
  element.append(box);

  const text = document.createElement("div");
  text.className = "setup-row__text";

  const name = document.createElement("div");
  name.className = "setup-row__name";
  name.textContent = MESSAGES.prerequisiteName(status.id, language);
  if (isRequired(status.id)) {
    const badge = document.createElement("span");
    badge.className = "setup-row__badge";
    badge.textContent = MESSAGES.setupRequired(language);
    name.append(badge);
  }
  text.append(name);

  const unlocks = document.createElement("div");
  unlocks.className = "setup-row__unlocks";
  unlocks.textContent = MESSAGES.prerequisiteUnlocks(status.id, language);
  if (status.id === "voice-en" || status.id === "voice-ar") {
    // The one install with a download cost worth knowing before ticking it.
    unlocks.textContent += ` · ${MESSAGES.setupVoiceSize(language)}`;
  }
  text.append(unlocks);

  if (status.manual !== undefined) {
    // Needs root, so Jarvis will not run it. The line the user can paste,
    // written for the package manager actually found on this machine.
    const manual = document.createElement("div");
    manual.className = "setup-row__manual";
    const command = document.createElement("code");
    command.textContent = status.manual;
    // A page is opened, a command is copied. Offering to "run" a URL in a
    // terminal is an instruction that does not work.
    const isPage = status.manual.startsWith("http");
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "setup-row__copy";
    copy.textContent = isPage ? MESSAGES.setupOpenHint(language) : MESSAGES.setupCopyHint(language);
    copy.addEventListener("click", () => {
      if (isPage) window.open(status.manual, "_blank");
      else void navigator.clipboard?.writeText(status.manual ?? "");
    });
    manual.append(command, copy);
    text.append(manual);
  }

  element.append(text);

  const state = document.createElement("div");
  state.className = "setup-row__state";
  state.id = `setup-state-${status.id}`;
  const failure = failures.get(status.id);
  if (failure !== undefined && !status.installed) {
    state.textContent = failure;
    state.classList.add("setup-row__state--bad");
  } else {
    state.textContent = status.installed
      ? MESSAGES.setupInstalled(language)
      : status.installable || status.manual !== undefined
        ? ""
        : MESSAGES.setupUnavailable(language);
  }
  element.append(state);

  void bridge;
  return element;
}

function updateInstallButton(language: "ar" | "en"): void {
  const button = $("setup-install") as HTMLButtonElement;
  const count = selected.size;
  button.textContent = installing
    ? MESSAGES.setupInstalling(language)
    : MESSAGES.setupInstallCount(count, language);
  button.disabled = installing || count === 0;
}

async function install(bridge: SetupBridge): Promise<void> {
  if (installing) return;
  installing = true;
  const language = PRIMARY_LANGUAGE;
  updateInstallButton(language);

  for (const id of [...selected]) {
    const state = document.getElementById(`setup-state-${id}`);
    if (state !== null) state.textContent = MESSAGES.setupInstalling(language);

    appendOutput(`\n$ ${MESSAGES.prerequisiteName(id, language)}\n`);
    const result = await bridge.installPrerequisite(id);

    // One row failing does not abandon the rest the user ticked, and a failed
    // row keeps its output on screen — "npm ERR! EACCES" is the whole of the
    // diagnosis, and hiding it would make this screen as useless as the
    // errors it replaces.
    if (result.ok) failures.delete(id);
    else failures.set(id, MESSAGES.setupFailed(id, result.detail ?? "", language));

    if (state !== null) {
      state.textContent = result.ok ? MESSAGES.setupDone(language) : (failures.get(id) ?? "");
    }
  }

  installing = false;
  statuses = await bridge.checkPrerequisites();
  selected = new Set([...selected].filter((id) => !statuses.find((s) => s.id === id)?.installed));
  render(bridge);
}
