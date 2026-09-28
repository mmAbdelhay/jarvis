// What the desktop app will open in the system browser for the core.
//
// The core asks for one thing only: the web client, remote:openWebClient's
// URL, built from the bridge's own status. The app does not take that on
// trust — in daemon mode the request arrives over a socket — so before
// shell.openExternal it checks the URL against the bridge's current status:
// https:, the host the bridge's certificate names, and the web client's port
// or the bridge's own. Anything else (file:, javascript:, a custom scheme,
// another host) is dropped and logged by scheme and host alone: a pairing
// link carries its secret in the fragment, and a query may carry one too.
//
// The in-process host (main.ts) and the socket adapter
// (core/socket-core-client.ts) both go through openBridgeWebUrl, so the rule
// is the same wherever the core runs. No electron here.
import type { RemoteStatus } from "@jarvis/remote";

export function isBridgeWebUrl(url: string, status: RemoteStatus): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  const certificateName = status.listening?.certificate.hostname;
  if (certificateName === undefined || certificateName === "") return false;
  if (parsed.hostname.toLowerCase() !== certificateName.toLowerCase()) return false;
  const port = parsed.port === "" ? 443 : Number(parsed.port);
  const allowed = new Set<number>();
  if (status.listening !== undefined) allowed.add(status.listening.port);
  if (status.web?.kind === "on") allowed.add(status.web.port);
  return allowed.has(port);
}

/** The URL as a log may show it: scheme and host, never path, query or
 *  fragment. */
export function urlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host === "" ? parsed.protocol : `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "an unparseable URL";
  }
}

/** Opens `url` only if it is the bridge's web client (isBridgeWebUrl). */
export async function openBridgeWebUrl(
  url: string,
  deps: {
    status(): Promise<RemoteStatus>;
    open(url: string): Promise<void>;
    log(line: string): void;
  },
): Promise<void> {
  const status = await deps.status();
  if (!isBridgeWebUrl(url, status)) {
    deps.log(`refused to open ${urlForLog(url)} (not the bridge's web client)`);
    return;
  }
  await deps.open(url);
}
