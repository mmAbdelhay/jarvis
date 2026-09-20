// The one place the phone decides whether a URL the laptop handed back for
// an Editor/Database/Cluster "open" is actually a sidecar the proxy meant
// to give it (task-6-brief.md rule 3, ruling 7). A failing check is treated
// as an error and the URL is never handed to the WebView — a loopback
// address, a stray `/rpc`, or a handle-shaped path on the wrong host must
// never load, even once.
//
// Deliberately not `new URL(...)`: the app's own `pairing-link.ts` and
// `proxy-rewrite.ts` (its server-side counterpart) both parse by exact
// string shape rather than trusting a URL parser's own notion of what a
// host or a default port is — the same discipline applies here.

const HANDLE_PATTERN = /^[0-9a-f]{32}$/;

const DEFAULT_HTTPS_PORT = 443;

export function sidecarOrigin(name: string, port: number): string {
  return `https://${name}:${port}`;
}

// WebKit and Chromium report navigation/origin URLs with the default HTTPS
// port stripped (M2, final review): a bridge configured with `remote.port:
// 443` composes `https://<name>:443/…` but the WebView hands back
// `https://<name>/…`. `sidecarOrigin` still always includes the port it was
// given — this only computes the *alternate* shape a caller should also
// accept when that port happens to be 443, as a literal string suffix
// removal (not a URL re-parse), so a name that merely ends in the digits
// "443" is untouched (the suffix checked is `:443`, colon included).
function defaultPortOrigin(origin: string): string | undefined {
  const suffix = `:${DEFAULT_HTTPS_PORT}`;
  return origin.endsWith(suffix) ? origin.slice(0, -suffix.length) : undefined;
}

/**
 * `https:` only, host exactly `name`, port exactly `port`, path starting
 * `/s/` + a 32-char lowercase-hex handle + `/`. The origin is matched as a
 * literal string prefix (`sidecarOrigin(name, port) + "/"`), so an IP
 * literal, a different name, or a different port never matches — string
 * equality, not host/port field comparison, so there is no default-port or
 * case-folding behaviour to get wrong. The one exception (M2): when `port`
 * is 443, the default-port-omitted shape (`https://<name>/…`) is accepted
 * alongside the explicit one, since that is the only shape a `port: 443`
 * bridge's WebView ever reports.
 */
export function isAllowedSidecarUrl(url: string, name: string, port: number): boolean {
  const prefix = `${sidecarOrigin(name, port)}/`;
  const altPrefix = port === DEFAULT_HTTPS_PORT ? `https://${name}/` : undefined;
  const matchedPrefix = url.startsWith(prefix)
    ? prefix
    : altPrefix !== undefined && url.startsWith(altPrefix)
      ? altPrefix
      : undefined;
  if (matchedPrefix === undefined) return false;

  const afterOrigin = url.slice(matchedPrefix.length - 1); // keeps the leading "/"
  const pathOnly = afterOrigin.split(/[?#]/, 1)[0] ?? "";
  const segments = pathOnly.split("/");
  // segments[0] is "" (text before the leading "/"); segments[1] must be
  // "s"; segments[2] must be the handle; segments[3] existing (even as "")
  // is what proves a trailing "/" followed the handle.
  if (segments[1] !== "s") return false;
  const handle = segments[2];
  if (handle === undefined || !HANDLE_PATTERN.test(handle)) return false;
  return segments.length >= 4;
}

/**
 * The WebView screen's navigation gate (task-6 review, fix round 1,
 * Important 1): `react-native-webview` 13.16.1 hands a URL that fails its
 * own `originWhitelist` to `Linking.openURL` *before*
 * `onShouldStartLoadWithRequest` is ever consulted (see
 * `sidecar-view.tsx`'s file comment for the full story) — so a wide
 * `originWhitelist={["*"]}` plus this function as the *sole* gate inside
 * the handler is what actually keeps an off-origin navigation from
 * escaping to the system browser. Not `isAllowedSidecarUrl`: this only
 * needs to keep in-page navigation on the sidecar's own origin (any path
 * under it, not just `/s/<handle>/…`), so a same-origin relative link
 * still works. `about:blank` is allowed — RNWV itself navigates there for
 * some internal transitions, and it can never carry a cross-origin
 * payload.
 *
 * A boundary check, not a prefix check: `origin + "/"` as a literal
 * prefix (rather than bare `origin`) is what refuses
 * `https://<name>:<port>.evil/x` and `https://<name>:<port>0/x` — both of
 * which start with the bare `origin` string but are a different host and
 * a different port respectively.
 *
 * M2 (final review): when `origin` ends `:443`, the same boundary check is
 * additionally run against the default-port-omitted shape, since that is
 * the only shape the WebView ever reports a navigation on such an origin
 * with. The `.evil`/trailing-digit refusals above apply to that alternate
 * shape too — it is the same boundary check, just against a shorter
 * literal.
 */
export function isOnSidecarOrigin(url: string, origin: string): boolean {
  if (url === "about:blank") return true;
  if (url === origin || url.startsWith(`${origin}/`)) return true;

  const altOrigin = defaultPortOrigin(origin);
  return altOrigin !== undefined && (url === altOrigin || url.startsWith(`${altOrigin}/`));
}
