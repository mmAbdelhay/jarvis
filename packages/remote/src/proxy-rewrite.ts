// The sidecar proxy's pure request/response rewriting (M11, "sidecar
// proxy"): everything the listener needs to turn `/s/{handle}/...` into a
// loopback request and rewrite the sidecar's reply back into the handle's
// own path space, with no `node:http` dependency of its own — the listener
// hands in plain header records exactly as Node gives them
// (`Record<string, string | string[] | undefined>`) and gets the same
// shape back. Nothing here opens a socket, reads a clock, or draws
// randomness; the listener (behind `@jarvis/remote/listen`) is the only
// caller that ever does. The only import is `KEY_PATTERN`/`COOKIE_PATTERN`
// from sidecar-registry.ts (fix round 1, M2) — one definition of each
// security-relevant regex, not two copies that could drift apart.
//
// `parseProxyPath` decodes nothing except to check for a `..` segment
// (ruling: never trust percent-encoding to mean the same thing twice) —
// the query string and the rest of the path reach the sidecar exactly as
// the phone sent them. `requestHeaders`/`responseHeaders` are the two
// invariants from the plan's "sidecar proxy invariants" made concrete: the
// phone's cookie jar, Authorization and credential-bearing Referer never
// reach the sidecar, and the sidecar's Location/Set-Cookie never name
// anything outside `/s/{handle}`.
// Final review, I1: a present `Origin` is rewritten to the loopback target
// exactly like `Host` already is — the phone has already been authenticated
// by the proxy's own `SameSite=Strict` cookie, so a same-origin check on the
// sidecar's side has nothing left to protect, and code-server's own origin
// check otherwise 403s every WebSocket the phone opens.

import { COOKIE_PATTERN, KEY_PATTERN } from "./sidecar-registry.js";

export type Headers = Record<string, string | string[] | undefined>;

const PROXY_PATH_PATTERN = /^\/s\/([0-9a-f]{32})(\/.*)?$/;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Preserved verbatim in `requestHeaders` when the caller passes `{ upgrade: true }` — never dropped as hop-by-hop, never filtered by the incoming Connection header. */
const UPGRADE_PRESERVED = new Set([
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
]);

/**
 * Final review, M1: dropped unconditionally in both modes, alongside
 * cookie/authorization/host. DbGate's `trust proxy: 'loopback, …'` and
 * code-server's `getHost` both honour these over the real `Host`/socket
 * address; the proxy is itself loopback, so a paired (already-authenticated)
 * phone that sent one of these could otherwise make a sidecar log or decide
 * things about a client the sidecar never actually saw. No privilege turns
 * on it, but ruling 9's intent — the sidecar sees the client as loopback —
 * is only true if the phone can't override it.
 */
const ALWAYS_DROPPED = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
]);

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * True iff `pathOnly` is unsafe once decoded: any raw `/`-separated segment
 * that, after percent-decoding, is itself `..`, contains a further `/` or
 * `\` splitting off a `..` piece (fix round 1, Important 1 — a segment like
 * `..%2f..%2fetc` decodes to `../../etc`, which the old raw-segment-only
 * check missed entirely since the decoded text is not itself exactly
 * `".."`), or decodes to something containing a control character or a raw
 * `\` (closes `%5c`/`%0a`, which the top-level raw checks in
 * `parseProxyPath` only ever saw as harmless percent-encoded text). A
 * segment whose percent-encoding is malformed (an unterminated `%`, an
 * invalid hex pair) is treated as unsafe too — the caller rejects the
 * whole request rather than guessing at what unparseable encoding meant.
 */
function hasUnsafeSegment(pathOnly: string): boolean {
  for (const rawSegment of pathOnly.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      return true;
    }
    if (decoded.includes("\\") || hasControlChar(decoded)) return true;
    for (const piece of decoded.split(/[/\\]/)) {
      if (piece === "..") return true;
    }
  }
  return false;
}

/**
 * Splits `/s/{handle}/...` off the front of a raw request `url` (path plus
 * query, exactly as `http.IncomingMessage.url` gives it). `rest` keeps
 * whatever followed the handle untouched — no percent-decoding except the
 * `..` check below, so query strings and encoded path segments the sidecar
 * itself needs to see arrive exactly as the phone sent them.
 */
export function parseProxyPath(url: string): { handle: string; rest: string } | undefined {
  const match = PROXY_PATH_PATTERN.exec(url);
  if (match === null) return undefined;
  const handle = match[1] as string;
  const rest = match[2] ?? "/";

  if (rest.includes("\\") || hasControlChar(rest)) return undefined;
  const queryIndex = rest.indexOf("?");
  const pathOnly = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  if (hasUnsafeSegment(pathOnly)) return undefined;

  return { handle, rest };
}

/**
 * Pulls the proxy's one-time `?k=` out of `rest`'s query string, returning
 * it alongside `rest` with that one param removed (other params keep their
 * order and their own encoding untouched; a `?` with nothing left after it
 * is dropped entirely). `undefined` for no `k`, more than one `k`, or a `k`
 * that fails KEY_PATTERN — the caller then falls back to cookie auth.
 */
export function takeKey(rest: string): { key: string; rest: string } | undefined {
  const queryIndex = rest.indexOf("?");
  if (queryIndex === -1) return undefined;
  const path = rest.slice(0, queryIndex);
  const query = rest.slice(queryIndex + 1);
  const params = query.length === 0 ? [] : query.split("&");

  let key: string | undefined;
  let keyCount = 0;
  const kept: string[] = [];
  for (const param of params) {
    const eq = param.indexOf("=");
    const name = eq === -1 ? param : param.slice(0, eq);
    if (name === "k") {
      keyCount++;
      key = eq === -1 ? "" : param.slice(eq + 1);
      continue;
    }
    kept.push(param);
  }
  if (keyCount !== 1 || key === undefined || !KEY_PATTERN.test(key)) return undefined;

  const newRest = kept.length === 0 ? path : `${path}?${kept.join("&")}`;
  return { key, rest: newRest };
}

/** The value of `jarvis_s_<handle>` from an RFC 6265 `;`-separated Cookie header — the first match if more than one names the same handle, `undefined` if absent or malformed. */
export function cookieFor(cookieHeader: string | undefined, handle: string): string | undefined {
  if (cookieHeader === undefined) return undefined;
  const target = `jarvis_s_${handle}`;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) !== target) continue;
    const value = trimmed.slice(eq + 1);
    return COOKIE_PATTERN.test(value) ? value : undefined;
  }
  return undefined;
}

function connectionTokens(value: string | string[] | undefined): Set<string> {
  const text = Array.isArray(value) ? value.join(",") : (value ?? "");
  const tokens = new Set<string>();
  for (const token of text.split(",")) {
    const trimmed = token.trim().toLowerCase();
    if (trimmed.length > 0) tokens.add(trimmed);
  }
  return tokens;
}

/**
 * The headers to send the loopback sidecar: `incoming` minus everything the
 * plan's invariants forbid it from seeing (cookies, Authorization, hop-by-
 * hop headers, anything the incoming Connection header names — except, in
 * upgrade mode, the handful of headers a WebSocket handshake needs
 * preserved verbatim), `Host` forced to the loopback target, and DbGate's
 * basic credential injected when given. Never mutates `incoming`.
 */
export function requestHeaders(
  incoming: Headers,
  options: {
    port: number;
    basicAuth?: { login: string; password: string };
    upgrade?: boolean;
    /** Drop `Accept-Encoding` so the sidecar answers uncompressed — set only
     *  for a document the proxy intends to rewrite (see rewriteClusterHtml). */
    identity?: boolean;
  },
): Headers {
  const upgrade = options.upgrade === true;
  const namedInConnection = connectionTokens(incoming.connection);
  // fix round 1, M7: a null-prototype object so a client-named header (in
  // principle never `__proto__`/`constructor`/`prototype` from Node's own
  // `IncomingMessage.headers`, but this makes it structurally impossible
  // regardless of caller) can never reach `Object.prototype`.
  const output: Headers = Object.create(null);

  for (const [rawName, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (
      name === "cookie" ||
      name === "authorization" ||
      name === "host" ||
      name === "origin" ||
      name === "referer"
    ) {
      continue;
    }
    if (ALWAYS_DROPPED.has(name)) continue;
    if (options.identity === true && name === "accept-encoding") continue;
    if (upgrade && UPGRADE_PRESERVED.has(name)) {
      output[name] = value;
      continue;
    }
    if (HOP_BY_HOP.has(name)) continue;
    if (namedInConnection.has(name)) continue;
    output[name] = value;
  }

  output.host = `127.0.0.1:${options.port}`;
  // I1: rewritten, not dropped — an absent Origin stays absent (a plain GET
  // never carries one), but a present one (every WebSocket handshake sends
  // one) must name the loopback target the request is actually going to,
  // in both plain and upgrade mode alike.
  if (incoming.origin !== undefined) {
    output.origin = `http://127.0.0.1:${options.port}`;
  }
  if (options.basicAuth !== undefined) {
    const { login, password } = options.basicAuth;
    output.authorization = `Basic ${Buffer.from(`${login}:${password}`, "utf8").toString("base64")}`;
  }

  return output;
}

// Port optional, scheme http or https, and whatever follows the host (a
// path, a bare query, or nothing at all) captured as one optional group —
// fix round 1, M3. The old pattern required `:<port>` and a `/`-led path,
// so `http://127.0.0.1:9001` (no path) or `http://localhost/foo` (no port)
// passed through unchanged and carried the sidecar's loopback port to the
// phone; the plan invariant is that the port never reaches the phone,
// regardless of what shape the sidecar's own Location happens to take.
const LOOPBACK_LOCATION_PATTERN = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?([/?].*)?$/;

function rewriteLocationValue(value: string, handle: string): string {
  if (value.startsWith("/")) return `/s/${handle}${value}`;
  const match = LOOPBACK_LOCATION_PATTERN.exec(value);
  if (match === null) return value;
  const remainder = match[1] ?? "";
  const path = remainder === "" ? "/" : remainder.startsWith("?") ? `/${remainder}` : remainder;
  return `/s/${handle}${path}`;
}

function rewriteSetCookieValue(value: string, handle: string): string {
  const segments = value.split(";").map((segment) => segment.trim());
  const nameValue = segments[0] ?? "";
  const attributes = segments.slice(1);

  const output: string[] = [];
  let pathSeen = false;
  let secureSeen = false;

  for (const attribute of attributes) {
    const eq = attribute.indexOf("=");
    const attrName = (eq === -1 ? attribute : attribute.slice(0, eq)).toLowerCase();
    if (attrName === "domain") continue;
    if (attrName === "path") {
      pathSeen = true;
      const originalPath = eq === -1 ? "" : attribute.slice(eq + 1);
      output.push(
        originalPath.startsWith("/") ? `Path=/s/${handle}${originalPath}` : `Path=/s/${handle}`,
      );
      continue;
    }
    if (attrName === "secure") secureSeen = true;
    output.push(attribute);
  }
  if (!pathSeen) output.push(`Path=/s/${handle}`);
  if (!secureSeen) output.push("Secure");

  return [nameValue, ...output].join("; ");
}

/**
 * The headers to send the phone: `outgoing` minus hop-by-hop headers and
 * `www-authenticate` (the sidecar's own auth challenge must never reach the
 * phone), with `Location` and `Set-Cookie` rewritten into the handle's own
 * path space. Bodies are never touched here or anywhere else in the proxy.
 * Never mutates `outgoing`.
 */
export function responseHeaders(outgoing: Headers, handle: string): Headers {
  // fix round 1, M7 — see the matching comment in requestHeaders.
  const output: Headers = Object.create(null);
  for (const [rawName, value] of Object.entries(outgoing)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name)) continue;
    if (name === "www-authenticate") continue;
    if (name === "location") {
      output[name] = Array.isArray(value)
        ? value.map((entry) => rewriteLocationValue(entry, handle))
        : rewriteLocationValue(value, handle);
      continue;
    }
    if (name === "set-cookie") {
      output[name] = Array.isArray(value)
        ? value.map((entry) => rewriteSetCookieValue(entry, handle))
        : rewriteSetCookieValue(value, handle);
      continue;
    }
    output[name] = value;
  }
  return output;
}

/** The `Set-Cookie` value the proxy hands the phone right after a key redeem (ruling 7). */
export function setCookieHeader(handle: string, cookie: string): string {
  return `jarvis_s_${handle}=${cookie}; Path=/s/${handle}; HttpOnly; Secure; SameSite=Strict`;
}

// ---------------------------------------------------------------------------
// Cluster (Headlamp) document rewrite.
//
// Headlamp's frontend is built for the root of its origin: its index.html
// names every asset by absolute path (`/assets/index-*.js`) and its bundle
// prefixes every API and WebSocket URL with `window.headlampBaseUrl`, which
// the served index.html sets to `'/'`. Behind `/s/{handle}` the phone would
// fetch `/assets/...` at the proxy's root, hit nothing, and sit on the splash
// spinner forever. headlamp-server has `-base-url` for exactly this, but it
// is one static prefix per process while a handle is minted per phone, per
// publish — so the proxy applies the same three in-memory replacements the
// server's own `baseURLReplace` makes, with the handle as the base. Only the
// document is touched: the module bundle imports its chunks relative to its
// own URL and reads the base at runtime, so once index.html is right every
// other request already carries the handle.
// ---------------------------------------------------------------------------

/** True when the phone is asking for a document, not an asset or an API call. */
export function acceptsHtml(accept: string | string[] | undefined): boolean {
  const value = Array.isArray(accept) ? accept.join(",") : accept;
  return value?.toLowerCase().includes("text/html") === true;
}

/** True for a response body the proxy may rewrite: HTML, and not compressed. */
export function isPlainHtml(outgoing: Headers): boolean {
  const type = outgoing["content-type"];
  const encoding = outgoing["content-encoding"];
  const typeValue = Array.isArray(type) ? type[0] : type;
  const encodingValue = Array.isArray(encoding) ? encoding[0] : encoding;
  if (typeValue === undefined || !typeValue.toLowerCase().startsWith("text/html")) return false;
  return encodingValue === undefined || encodingValue.toLowerCase() === "identity";
}

/**
 * Headlamp's index.html re-based under `/s/{handle}`: the exact replacements
 * headlamp-server's `-base-url` makes, applied here instead. `href="//..."`
 * and `src="//..."` (protocol-relative) are left alone.
 */
export function rewriteClusterHtml(html: string, handle: string): string {
  const base = `/s/${handle}`;
  return html
    .replaceAll("headlampBaseUrl = '/'", `headlampBaseUrl = '${base}'`)
    .replaceAll("__baseUrl__ = '/", `__baseUrl__ = '${base}/`)
    .replaceAll(/(href|src)="\/(?!\/)/g, `$1="${base}/`);
}
