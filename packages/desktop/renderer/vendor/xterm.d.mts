// The vendored copy is imported by a real relative path so the browser can
// resolve it under the app's `script-src 'self'` CSP (a bare specifier like
// "@xterm/xterm" would survive tsc's emit unresolved and 404 at runtime).
// Types still come from the installed package, so the vendored file and its
// declarations can never drift apart.
export * from "@xterm/xterm";
