import { describe, expect, it } from "vitest";
import { isSafeHref, normalizeInput, SEARCH_PREFIX } from "./url.js";

describe("normalizeInput", () => {
  it("keeps an explicit https URL as typed", () => {
    expect(normalizeInput("https://github.com/anthropics")).toEqual({
      kind: "url",
      url: "https://github.com/anthropics",
    });
  });

  it("keeps an explicit http URL as typed", () => {
    expect(normalizeInput("http://example.com")).toEqual({
      kind: "url",
      url: "http://example.com",
    });
  });

  it("promotes a bare hostname to https", () => {
    expect(normalizeInput("github.com")).toEqual({ kind: "url", url: "https://github.com" });
  });

  it("keeps a path on a bare hostname", () => {
    expect(normalizeInput("github.com/anthropics/claude-code")).toEqual({
      kind: "url",
      url: "https://github.com/anthropics/claude-code",
    });
  });

  // A dev server is the second reason this browser exists; https://localhost
  // fails the TLS handshake on every one of them.
  it("sends localhost to http, not https", () => {
    expect(normalizeInput("localhost:3000")).toEqual({ kind: "url", url: "http://localhost:3000" });
  });

  it("sends a loopback IP to http", () => {
    expect(normalizeInput("127.0.0.1:8069")).toEqual({ kind: "url", url: "http://127.0.0.1:8069" });
  });

  it("treats prose as a search", () => {
    expect(normalizeInput("how do I rebase in git")).toEqual({
      kind: "search",
      url: `${SEARCH_PREFIX}how%20do%20I%20rebase%20in%20git`,
    });
  });

  // "odoo" has no dot: it is a word, not a host.
  it("treats a single dotless word as a search", () => {
    expect(normalizeInput("odoo")).toEqual({ kind: "search", url: `${SEARCH_PREFIX}odoo` });
  });

  it("trims surrounding whitespace before deciding", () => {
    expect(normalizeInput("  github.com  ")).toEqual({ kind: "url", url: "https://github.com" });
  });

  it("rejects empty input", () => {
    expect(normalizeInput("   ")).toEqual({ kind: "rejected", reason: "empty" });
  });

  // The security cases. A hosted view has a persistent partition and full
  // Chromium; file: turns the address bar into a local file reader, and
  // javascript:/data: are script injection into whatever origin is loaded.
  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<b>x",
    "about:blank",
    "chrome://settings",
    "blob:https://x/y",
  ])("rejects %s", (input) => {
    expect(normalizeInput(input)).toEqual({ kind: "rejected", reason: "unsupported-scheme" });
  });

  // Case and whitespace must not smuggle a scheme past the gate.
  it("rejects a scheme however it is cased or padded", () => {
    expect(normalizeInput("  JaVaScRiPt:alert(1)")).toEqual({
      kind: "rejected",
      reason: "unsupported-scheme",
    });
  });
});

describe("isSafeHref", () => {
  it("accepts http and https", () => {
    expect(isSafeHref("https://example.com")).toBe(true);
    expect(isSafeHref("http://example.com")).toBe(true);
  });

  it("refuses every other scheme", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("file:///etc/passwd")).toBe(false);
    expect(isSafeHref("data:text/html,x")).toBe(false);
  });

  // Links inside a markdown document are often relative or in-page. They are
  // not navigations to a foreign scheme, so they are safe to render.
  it("accepts a relative or in-page link", () => {
    expect(isSafeHref("./other.md")).toBe(true);
    expect(isSafeHref("#section")).toBe(true);
  });
});
