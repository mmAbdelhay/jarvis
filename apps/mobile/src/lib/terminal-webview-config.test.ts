import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allowTerminalNavigation, TERMINAL_WEBVIEW_PROPS } from "./terminal-webview-config";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Strips comments so a "never calls Linking" scan isn't tripped up by a
 * comment that merely *explains* why Linking isn't called (as this file's
 * own source, and terminal-webview-config.ts's, both do). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("TERMINAL_WEBVIEW_PROPS", () => {
  const expected: Record<string, unknown> = {
    // Fix round 1, I1: `["*"]`, not `["about:blank"]` — see
    // terminal-webview-config.ts for why. [bite-proof: restore
    // `["about:blank"]` here or in the source and this test fails.]
    originWhitelist: ["*"],
    javaScriptEnabled: true,
    domStorageEnabled: false,
    cacheEnabled: false,
    incognito: true,
    allowFileAccess: false,
    allowFileAccessFromFileURLs: false,
    allowUniversalAccessFromFileURLs: false,
    allowingReadAccessToURL: undefined,
    mixedContentMode: "never",
    setSupportMultipleWindows: false,
    javaScriptCanOpenWindowsAutomatically: false,
    allowsLinkPreview: false,
    // An array, not a string: the Fabric spec types it as one and the string
    // form aborted Android on first device run.
    dataDetectorTypes: ["none"],
    geolocationEnabled: false,
    allowsInlineMediaPlayback: false,
    mediaPlaybackRequiresUserAction: true,
    thirdPartyCookiesEnabled: false,
    sharedCookiesEnabled: false,
    keyboardDisplayRequiresUserAction: true,
    hideKeyboardAccessoryView: true,
    bounces: false,
    overScrollMode: "never",
    textZoom: 100,
  };

  for (const [key, value] of Object.entries(expected)) {
    it(`has ${key} = ${JSON.stringify(value)} [bite-proof: flip this and the test fails]`, () => {
      expect((TERMINAL_WEBVIEW_PROPS as Record<string, unknown>)[key]).toEqual(value);
    });
  }

  it("has exactly the props rule 7 names, nothing extra", () => {
    expect(Object.keys(TERMINAL_WEBVIEW_PROPS).sort()).toEqual(Object.keys(expected).sort());
  });

  it("is frozen", () => {
    expect(Object.isFrozen(TERMINAL_WEBVIEW_PROPS)).toBe(true);
  });

  it(
    "originWhitelist itself is frozen (M6): a shallow freeze of the props " +
      "object doesn't stop the array inside it from being mutated",
    () => {
      expect(Object.isFrozen(TERMINAL_WEBVIEW_PROPS.originWhitelist)).toBe(true);
    },
  );
});

describe("allowTerminalNavigation", () => {
  it("allows about:blank", () => {
    expect(allowTerminalNavigation("about:blank")).toBe(true);
  });

  it("refuses https://example.com", () => {
    expect(allowTerminalNavigation("https://example.com")).toBe(false);
  });

  it("refuses http://example.com", () => {
    expect(allowTerminalNavigation("http://example.com")).toBe(false);
  });

  it("refuses file:///etc/hosts", () => {
    expect(allowTerminalNavigation("file:///etc/hosts")).toBe(false);
  });

  it("refuses about:srcdoc", () => {
    expect(allowTerminalNavigation("about:srcdoc")).toBe(false);
  });

  it("refuses javascript:alert(1)", () => {
    expect(allowTerminalNavigation("javascript:alert(1)")).toBe(false);
  });

  it("refuses data:text/html,x", () => {
    expect(allowTerminalNavigation("data:text/html,x")).toBe(false);
  });

  // Fix round 1, I1: with originWhitelist now ["*"], this function is the
  // *only* gate, so its coverage has to include what the review's
  // navigation-lock case list names: tel:/mailto:/intent: (native URL
  // schemes the library used to hand to Linking.openURL), the app's own
  // jarvis:// deep-link scheme, and about:blank look-alikes that must not
  // pass an exact-match check.
  it("refuses tel:+15555550100", () => {
    expect(allowTerminalNavigation("tel:+15555550100")).toBe(false);
  });

  it("refuses mailto:someone@example.com", () => {
    expect(allowTerminalNavigation("mailto:someone@example.com")).toBe(false);
  });

  it("refuses intent://scan/#Intent;scheme=zxing;end", () => {
    expect(allowTerminalNavigation("intent://scan/#Intent;scheme=zxing;end")).toBe(false);
  });

  it("refuses jarvis://pair?x=1 (the app's own deep-link scheme)", () => {
    expect(allowTerminalNavigation("jarvis://pair?x=1")).toBe(false);
  });

  it("refuses about:blank#x", () => {
    expect(allowTerminalNavigation("about:blank#x")).toBe(false);
  });

  it("refuses about:blank?x=1", () => {
    expect(allowTerminalNavigation("about:blank?x=1")).toBe(false);
  });

  it("refuses about:blank/ (trailing slash)", () => {
    expect(allowTerminalNavigation("about:blank/")).toBe(false);
  });

  it("refuses ABOUT:BLANK (case)", () => {
    expect(allowTerminalNavigation("ABOUT:BLANK")).toBe(false);
  });

  it("refuses a trailing-space variant", () => {
    expect(allowTerminalNavigation("about:blank ")).toBe(false);
  });
});

describe("TerminalWebView.tsx source scan", () => {
  const source = readFileSync(join(HERE, "..", "components", "TerminalWebView.tsx"), "utf8");

  it("spreads TERMINAL_WEBVIEW_PROPS onto the WebView", () => {
    expect(source).toContain("{...TERMINAL_WEBVIEW_PROPS}");
  });

  it(
    "wires onShouldStartLoadWithRequest to allowTerminalNavigation " +
      "[bite-proof: change this to a different gate and the test fails]",
    () => {
      expect(source).toContain("onShouldStartLoadWithRequest");
      expect(source).toMatch(/onShouldStartLoadWithRequest=\{[^}]*allowTerminalNavigation\(/);
    },
  );

  it("never uses injectedJavaScript", () => {
    expect(source).not.toContain("injectedJavaScript");
  });

  // Fix round 1, I1: the whole point of originWhitelist: ["*"] is that
  // react-native-webview's own pre-check never fires its Linking.openURL
  // fallback. Nothing of ours should call Linking either, on either file
  // that makes up the navigation lock.
  it("never imports or calls react-native's Linking", () => {
    expect(stripComments(source)).not.toMatch(/\bLinking\b/);
  });
});

describe("terminal-webview-config.ts source scan", () => {
  const configSource = readFileSync(join(HERE, "terminal-webview-config.ts"), "utf8");

  it("never imports or calls react-native's Linking", () => {
    expect(stripComments(configSource)).not.toMatch(/\bLinking\b/);
  });
});
