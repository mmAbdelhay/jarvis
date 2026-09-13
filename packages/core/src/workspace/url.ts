/**
 * What the address bar does with what a person typed. A hosted tab is real
 * Chromium with a persistent partition, so the scheme gate here is a
 * security boundary, not a convenience: `file:` would make the address bar
 * a local file reader, and `javascript:`/`data:` are script injection into
 * whatever origin the tab currently holds. Only http and https are ever
 * loaded, and the decision lives in `core` — pure, and therefore directly
 * testable — rather than inside the Electron wiring that consumes it.
 */
export type UrlInput =
  | { kind: "url"; url: string }
  | { kind: "search"; url: string }
  | { kind: "rejected"; reason: "empty" | "unsupported-scheme" };

export const SEARCH_PREFIX = "https://duckduckgo.com/?q=";

// RFC 3986 scheme grammar. Anchored, so a path segment containing a colon
// ("github.com/a:b") is not mistaken for a scheme.
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const WEB_SCHEMES = new Set(["http", "https"]);

// Something that could be a host: at least one dot with no whitespace, or a
// loopback name. Anything else a person types is prose.
const HOSTLIKE = /^[^\s/?#]+\.[^\s/?#]+/;
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

export function normalizeInput(text: string): UrlInput {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "rejected", reason: "empty" };

  // Loopback is tested BEFORE the scheme gate, and the order is load-bearing:
  // "localhost:3000" is also a syntactically valid scheme ("localhost")
  // followed by a colon, so a scheme-first reading rejects the single most
  // common thing anyone will type into this bar. A real URL keeps its
  // scheme regardless — "http://localhost:3000" fails this anchored test and
  // falls through to the gate below.
  //
  // A dev server almost never speaks TLS, so loopback goes to http.
  if (LOOPBACK.test(trimmed)) return { kind: "url", url: `http://${trimmed}` };

  const scheme = SCHEME.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    return WEB_SCHEMES.has(scheme)
      ? { kind: "url", url: trimmed }
      : { kind: "rejected", reason: "unsupported-scheme" };
  }

  // Every other bare host goes to https: defaulting to plaintext for the
  // wider internet would silently downgrade a site that supports both.
  if (HOSTLIKE.test(trimmed)) return { kind: "url", url: `https://${trimmed}` };

  return { kind: "search", url: `${SEARCH_PREFIX}${encodeURIComponent(trimmed)}` };
}

/**
 * Whether a link found inside a markdown document may be rendered as a link
 * at all. Relative and in-page links are kept (a doc tree is full of them);
 * anything carrying a scheme must be http or https, so a document written by
 * an agent cannot put a `javascript:` href into the privileged renderer.
 */
export function isSafeHref(href: string): boolean {
  const scheme = SCHEME.exec(href.trim())?.[1]?.toLowerCase();
  return scheme === undefined || WEB_SCHEMES.has(scheme);
}
