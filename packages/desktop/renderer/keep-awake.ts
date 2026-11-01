import type { RendererApi } from "../src/ipc.js";
import type { AwakeStatus } from "../src/keep-awake.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { attachHoverTip } from "./hover-tip.js";

// Keep awake (Task 18), the renderer's side: one cached AwakeStatus, read
// once at startup and kept current by awake:changed, drawn on the topbar
// button and fanned out to Settings' status line (remote-status.ts's
// pattern). A click turns it off, or back to the last mode that was not off.

type AwakeApi = Pick<RendererApi, "awakeStatus" | "setAwake" | "onAwakeChanged">;

let latest: AwakeStatus | undefined;
/** The mode a click turns back on: the last non-off mode seen. */
let lastOn: "on" | "agents" | undefined;
const listeners = new Set<(status: AwakeStatus) => void>();

/** What a click on the button sets the mode to. */
export function awakeToggleTarget(
  mode: AwakeStatus["mode"],
  lastNonOff: "on" | "agents" | undefined,
): AwakeStatus["mode"] {
  return mode === "off" ? (lastNonOff ?? "on") : "off";
}

export function latestAwakeStatus(): AwakeStatus | undefined {
  return latest;
}

export function onAwakeStatusChange(listener: (status: AwakeStatus) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function render(button: HTMLElement, status: AwakeStatus): void {
  const label = MESSAGES.awakeButtonLabel(status, PRIMARY_LANGUAGE);
  button.setAttribute("aria-label", label);
  // hover-tip.ts draws this; no `title` too, or two tooltips would show.
  button.dataset.tip = label;
  button.setAttribute("aria-pressed", String(status.mode !== "off"));
  button.classList.toggle("icon-btn--on", status.active);
  button.classList.toggle("icon-btn--armed", status.mode !== "off" && !status.active);
}

function apply(button: HTMLElement, status: AwakeStatus): void {
  latest = status;
  if (status.mode !== "off") lastOn = status.mode;
  render(button, status);
  for (const listener of [...listeners]) {
    try {
      listener(status);
    } catch {
      // One listener failing must not stop the others.
    }
  }
}

/** Wires #awake-button. Absent markup (a test harness) is a no-op. */
export async function initKeepAwake(api: AwakeApi): Promise<void> {
  const button = document.getElementById("awake-button");
  if (button === null) return;
  attachHoverTip(button);
  api.onAwakeChanged((status) => apply(button, status));
  button.addEventListener("click", () => {
    const mode = awakeToggleTarget(latest?.mode ?? "off", lastOn);
    void api
      .setAwake({ mode })
      .then((status) => apply(button, status))
      .catch((error: unknown) => console.error(`keep awake: ${String(error)}`));
  });
  try {
    apply(button, await api.awakeStatus());
  } catch {
    // No status yet: the first push draws it.
  }
}
