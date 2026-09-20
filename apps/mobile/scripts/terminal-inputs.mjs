// Fix round 1, M5: shared by build-terminal-html.mjs (the CLI) and
// terminal-html.test.ts (the drift test) — reads every real input the
// generated page is built from, strips terminal-page.ts the same way in
// both places (including the CLI's "exactly one export" assertion, which
// the test's own copy used to silently skip), and applies the
// fontFamily/fontSize/scrollback formula ruling 18 specifies. One copy of
// this logic instead of two that could drift from each other.

import { stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = join(HERE, "..");
const REPO_ROOT = join(MOBILE_ROOT, "..", "..");
const VENDOR_DIR = join(REPO_ROOT, "packages", "desktop", "renderer", "vendor");
const THEME_FILE = join(REPO_ROOT, "packages", "desktop", "renderer", "terminal-theme.ts");
const PAGE_FILE = join(MOBILE_ROOT, "src", "terminal", "terminal-page.ts");

// ruling 18: font size is phone-specific, not the desktop's.
export const FONT_SIZE = 12;

/**
 * `terminal-page.ts`, stripped to plain JS and with its single `export `
 * removed, ready to inline into the page's <script>. Throws if the
 * stripped output doesn't have exactly one `export` — the file is meant
 * to hold exactly one exported function and nothing else runtime-visible.
 */
export function stripPageController(source) {
  const stripped = stripTypeScriptTypes(source, { mode: "strip" });
  const exportCount = (stripped.match(/export/g) ?? []).length;
  if (exportCount !== 1) {
    throw new Error(
      `expected exactly one "export" in the stripped terminal-page.ts, found ${exportCount}`,
    );
  }
  const exportIndex = stripped.indexOf("export ");
  if (exportIndex === -1) {
    throw new Error('expected "export " before createPageController');
  }
  return stripped.slice(0, exportIndex) + stripped.slice(exportIndex + "export ".length);
}

/**
 * Reads the four vendor files, the desktop's theme module (via Node's
 * native TS loading) and this app's page controller, and returns exactly
 * what `buildTerminalHtml` needs, plus the raw (unstripped, unprocessed)
 * source text of every input for hashing (`TERMINAL_SOURCE_SHA256`).
 */
export async function readTerminalInputs() {
  const xtermJs = readFileSync(join(VENDOR_DIR, "xterm.mjs"), "utf8");
  const fitJs = readFileSync(join(VENDOR_DIR, "addon-fit.mjs"), "utf8");
  const unicode11Js = readFileSync(join(VENDOR_DIR, "addon-unicode11.mjs"), "utf8");
  const xtermCss = readFileSync(join(VENDOR_DIR, "xterm.css"), "utf8");
  const themeSource = readFileSync(THEME_FILE, "utf8");
  const pageSource = readFileSync(PAGE_FILE, "utf8");

  const themeModule = await import(pathToFileURL(THEME_FILE).href);
  const { TERMINAL_THEME, TERMINAL_FONT, SCROLLBACK_LINES } = themeModule;

  const pageJs = stripPageController(pageSource);

  return {
    xtermJs,
    fitJs,
    unicode11Js,
    xtermCss,
    pageJs,
    theme: TERMINAL_THEME,
    // ruling 18, rule 2: the desktop's fontFamily, plus ", monospace" —
    // literally, even though the desktop's own value already ends in
    // ", monospace" (see task-6-report.md, M2).
    fontFamily: `${TERMINAL_FONT.fontFamily}, monospace`,
    scrollback: SCROLLBACK_LINES,
    fontSize: FONT_SIZE,
    raw: { xtermJs, fitJs, unicode11Js, xtermCss, themeSource, pageSource },
  };
}
