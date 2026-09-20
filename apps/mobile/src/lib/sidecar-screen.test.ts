// The sidecar WebView screen (app/sidecar-view.tsx) has no companion
// `sidecar-screen.ts` — unlike docker-screen.ts/session-screen.ts, its only
// non-trivial logic (the "Desktop site" toggle's WebView props) already
// lives in the plain, directly-tested `sidecar-webview-config.ts`
// (sidecar-webview-config.test.ts covers `sidecarDesktopWebViewProps`
// itself: userAgent + zoom props present when the toggle is on, an empty
// object when it's off). This file is the wiring check, in the same
// "source scan" style terminal-webview-config.test.ts uses for
// TerminalWebView.tsx: it reads app/sidecar-view.tsx as text (app/ isn't
// under vitest.config.mts's `test.include`, so it can't be imported and
// rendered directly) and asserts the screen actually spreads that
// function's result onto the WebView and threads a real toggle through.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sidecarDesktopWebViewProps } from "./sidecar-webview-config";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR_VIEW_SOURCE = readFileSync(join(HERE, "..", "..", "app", "sidecar-view.tsx"), "utf8");

describe("sidecarDesktopWebViewProps drives the sidecar WebView's props", () => {
  it("toggle on: the WebView receives userAgent and the zoom props", () => {
    const props = sidecarDesktopWebViewProps(true, "android");
    expect(props).toMatchObject({
      userAgent: expect.any(String),
      setBuiltInZoomControls: true,
      setDisplayZoomControls: false,
      injectedJavaScriptBeforeContentLoaded: expect.any(String),
    });
  });

  it(
    "toggle off: the WebView receives none of them " +
      "[bite-proof: leave a desktop prop set when off and this fails]",
    () => {
      const props = sidecarDesktopWebViewProps(false, "android");
      expect(props).not.toHaveProperty("userAgent");
      expect(props).not.toHaveProperty("setBuiltInZoomControls");
      expect(props).not.toHaveProperty("setDisplayZoomControls");
      expect(props).not.toHaveProperty("injectedJavaScriptBeforeContentLoaded");
    },
  );
});

describe("app/sidecar-view.tsx source scan", () => {
  it(
    "spreads sidecarDesktopWebViewProps(desktopSite, Platform.OS, zoom) onto the WebView " +
      "[bite-proof: wire a different/no prop source, or drop the zoom so DbGate first loads at 100%, and this fails]",
    () => {
      expect(SIDECAR_VIEW_SOURCE).toMatch(
        /\{\.\.\.sidecarDesktopWebViewProps\(desktopSite,\s*Platform\.OS,\s*zoom\)\}/,
      );
    },
  );

  it("imports sidecarDesktopWebViewProps from the tested config module", () => {
    const importBlock = SIDECAR_VIEW_SOURCE.match(
      /import\s*\{[\s\S]*?\}\s*from\s*["']@\/lib\/sidecar-webview-config["']/,
    )?.[0];
    expect(importBlock, "no import from @/lib/sidecar-webview-config found").toBeDefined();
    expect(importBlock).toContain("sidecarDesktopWebViewProps");
  });

  it("keeps originWhitelist wide open and the sole gate on isOnSidecarOrigin, unchanged", () => {
    expect(SIDECAR_VIEW_SOURCE).toContain('originWhitelist={["*"]}');
    expect(SIDECAR_VIEW_SOURCE).toMatch(
      /onShouldStartLoadWithRequest=\{[\s\S]*?isOnSidecarOrigin\(/,
    );
  });

  it("persists the toggle through prefs.ts's sidecarDesktopSite field", () => {
    expect(SIDECAR_VIEW_SOURCE).toContain("sidecarDesktopSite");
    const importBlock = SIDECAR_VIEW_SOURCE.match(
      /import\s*\{[\s\S]*?\}\s*from\s*["']@\/lib\/prefs["']/,
    )?.[0];
    expect(importBlock, "no import from @/lib/prefs found").toBeDefined();
    expect(importBlock).toContain("loadPrefs");
    expect(importBlock).toContain("savePrefs");
  });

  it("shows the toggle bilingually via the sidecars.desktopSite i18n key, not raw text", () => {
    expect(SIDECAR_VIEW_SOURCE).toContain('"sidecars.desktopSite"');
  });

  it("never touches the terminal's own config or component", () => {
    expect(SIDECAR_VIEW_SOURCE).not.toContain("terminal-webview-config");
    expect(SIDECAR_VIEW_SOURCE).not.toContain("TerminalWebView");
  });
});

// Zoom fix: the −/label/+ controls, their persistence and the imperative
// injectJavaScript wiring are all covered directly by
// sidecar-webview-config.test.ts (nextZoom/zoomScript's own unit tests).
// This is the wiring check, same source-scan style as the rest of this
// file — that the screen actually calls those pure helpers and feeds the
// result to the ref, rather than reimplementing the math or the script
// inline.
describe("app/sidecar-view.tsx source scan: zoom controls", () => {
  it(
    'the −/+ buttons call applyZoom("out")/applyZoom("in"), which is built on nextZoom ' +
      "[bite-proof: wire a button straight to setZoom and this fails]",
    () => {
      expect(SIDECAR_VIEW_SOURCE).toContain('applyZoom("out")');
      expect(SIDECAR_VIEW_SOURCE).toContain('applyZoom("in")');
      expect(SIDECAR_VIEW_SOURCE).toMatch(/const next = nextZoom\(previous,\s*direction\)/);
    },
  );

  it(
    "applying a zoom pushes it to the live page via webViewRef.current?.injectJavaScript(zoomScript(...)) " +
      "[bite-proof: drop the injectJavaScript call and the on-screen page would never update]",
    () => {
      expect(SIDECAR_VIEW_SOURCE).toMatch(
        /webViewRef\.current\?\.injectJavaScript\(zoomScript\(next\)\)/,
      );
    },
  );

  it(
    "re-applies the current zoom on every onLoadEnd, not just the first load " +
      '[bite-proof: this is the brief\'s own "the page may re-render" requirement]',
    () => {
      expect(SIDECAR_VIEW_SOURCE).toMatch(/onLoadEnd=\{handleLoadEnd\}/);
      expect(SIDECAR_VIEW_SOURCE).toMatch(
        /webViewRef\.current\?\.injectJavaScript\(zoomScript\(zoom\)\)/,
      );
    },
  );

  it("imports the zoom helpers from the tested config module, not a local reimplementation", () => {
    const importBlock = SIDECAR_VIEW_SOURCE.match(
      /import\s*\{[\s\S]*?\}\s*from\s*["']@\/lib\/sidecar-webview-config["']/,
    )?.[0];
    expect(importBlock, "no import from @/lib/sidecar-webview-config found").toBeDefined();
    expect(importBlock).toContain("nextZoom");
    expect(importBlock).toContain("zoomScript");
  });

  it("persists the zoom through prefs.ts's sidecarZoom field, keyed by kind", () => {
    expect(SIDECAR_VIEW_SOURCE).toMatch(/sidecarZoom:\s*\{\s*\.\.\.current\.sidecarZoom/);
  });

  it("the WebView is wired to a ref (required for the imperative injectJavaScript calls above)", () => {
    expect(SIDECAR_VIEW_SOURCE).toMatch(/const webViewRef = useRef<WebView>\(null\)/);
    expect(SIDECAR_VIEW_SOURCE).toContain("ref={webViewRef}");
  });
});

// Landscape fix: expo-screen-orientation's own lockAsync/unlockAsync have
// no pure logic of their own to unit-test (they're native calls) — this
// scan is the only proof the screen actually calls them, in the right
// place (a useFocusEffect, so unlock/re-lock track this screen's own
// focus, not the app's lifetime).
describe("app/sidecar-view.tsx source scan: landscape orientation", () => {
  it(
    "unlocks orientation inside a useFocusEffect " +
      "[bite-proof: unlock outside focus tracking and every other screen could rotate too]",
    () => {
      expect(SIDECAR_VIEW_SOURCE).toMatch(/useFocusEffect\(/);
      expect(SIDECAR_VIEW_SOURCE).toMatch(/ScreenOrientation\.unlockAsync\(\)/);
    },
  );

  it(
    "re-locks to PORTRAIT_UP in that same effect's cleanup (covers both blur and unmount) " +
      "[bite-proof: this is the brief's own requirement — useFocusEffect's cleanup fires for both]",
    () => {
      expect(SIDECAR_VIEW_SOURCE).toMatch(
        /ScreenOrientation\.lockAsync\(ScreenOrientation\.OrientationLock\.PORTRAIT_UP\)/,
      );
    },
  );

  it("imports expo-screen-orientation, the package pinned in package.json", () => {
    expect(SIDECAR_VIEW_SOURCE).toMatch(
      /import \* as ScreenOrientation from ["']expo-screen-orientation["']/,
    );
  });
});

// Slim-header fix: the header is now a single fixed-height row this screen
// draws itself — `_layout.tsx`'s own `Stack.Screen` entry for
// "sidecar-view" sets `headerShown: false` so the native header (whose
// title/right-button layout used to grow to two lines) never renders.
describe("app/sidecar-view.tsx source scan: slim single-row header", () => {
  it(
    "the header row is a fixed 44px tall, never a second line " +
      "[bite-proof: drop the fixed height and a long title could wrap again]",
    () => {
      expect(SIDECAR_VIEW_SOURCE).toMatch(/header:\s*\{[^}]*height:\s*44/);
    },
  );

  it("back, title, zoom row and the desktop-site toggle are all children of that one header row", () => {
    const headerBlock = SIDECAR_VIEW_SOURCE.slice(
      SIDECAR_VIEW_SOURCE.indexOf("<View style={styles.header}>"),
      SIDECAR_VIEW_SOURCE.indexOf("</View>\n      </View>"),
    );
    expect(headerBlock).toContain("styles.iconButton");
    expect(headerBlock).toContain("styles.title");
    expect(headerBlock).toContain("styles.zoomRow");
    expect(headerBlock).toContain("styles.desktopToggle");
  });

  it(
    "the title is single-line with ellipsis, not left to wrap " +
      '[bite-proof: this is exactly the "2 lines tall" bug the brief describes]',
    () => {
      expect(SIDECAR_VIEW_SOURCE).toMatch(/numberOfLines=\{1\}\s+ellipsizeMode="tail"/);
    },
  );

  it(
    "the desktop-site control is icon-only now, not the old text pill " +
      "[bite-proof: the old desktopToggleText/desktopToggleTextActive styles are gone]",
    () => {
      expect(SIDECAR_VIEW_SOURCE).not.toContain("desktopToggleText");
      expect(SIDECAR_VIEW_SOURCE).toContain("desktopToggleGlyph");
    },
  );

  it("keeps the desktop-site toggle's accessibilityLabel and switch semantics", () => {
    expect(SIDECAR_VIEW_SOURCE).toContain('accessibilityRole="switch"');
    expect(SIDECAR_VIEW_SOURCE).toMatch(
      /accessibilityLabel=\{t\(language,\s*"sidecars\.desktopSite"\)\}/,
    );
  });

  it("the zoom buttons carry their own bilingual accessibilityLabel (icon-only, no visible text)", () => {
    expect(SIDECAR_VIEW_SOURCE).toMatch(
      /accessibilityLabel=\{t\(language,\s*"sidecars\.zoomOut"\)\}/,
    );
    expect(SIDECAR_VIEW_SOURCE).toMatch(
      /accessibilityLabel=\{t\(language,\s*"sidecars\.zoomIn"\)\}/,
    );
  });
});
