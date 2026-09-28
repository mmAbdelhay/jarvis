// Phase 1: what Settings shows for browser access, as pure functions of
// the bridge's own RemoteStatus — never of the unsaved draft. Type-only
// imports, so the renderer (settings.ts) can import this by value
// (no-value-imports.test.ts), and dispatch.ts's remote:openWebClient uses
// the same URL the QR shows.
import type { RemoteStatus } from "@jarvis/remote";

export type RemoteWebState =
  | "off"
  | "port-conflict"
  | "listen-failed"
  | "needs-certificate"
  | "needs-owner-password"
  | "not-built"
  | "on";

/** The state line's key. A status from before the web gate existed (no
 *  `web`) reads as off. */
export function remoteWebState(status: RemoteStatus): RemoteWebState {
  const web = status.web;
  if (web === undefined) return "off";
  if (web.kind === "off") return web.reason ?? "off";
  return web.kind;
}

/**
 * The browser URL Settings links to and draws as a QR: while a pairing
 * window is open, the pairing link (it carries the pairing secret, so it
 * lives exactly as long as the window does); otherwise the web client's
 * root. `undefined` whenever the web listener is not on.
 */
export function remoteWebUrl(status: RemoteStatus): string | undefined {
  if (status.web?.kind !== "on") return undefined;
  if (status.pairing.kind === "open" && status.pairing.webUri !== undefined) {
    return status.pairing.webUri;
  }
  return `${status.web.origin}/`;
}

/** Phase 1: how a paired device is labelled — the browser build or the app. */
export function remoteDeviceClient(device: RemoteStatus["devices"][number]): "web" | "app" {
  return device.client === "web" ? "web" : "app";
}
