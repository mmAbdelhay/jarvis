// The pure HTML builder for the terminal page (task-6-brief.md, ruling 1 +
// ruling 13). No filesystem access here — `build-terminal-html.mjs` reads
// every input and hands it to `buildTerminalHtml`, which only does string
// work: wrap the three vendored xterm modules so they no longer need ESM
// `import`/`export`, assemble one inline <script>, and hash its exact text
// for the CSP.
//
// Types: see terminal-html.d.mts.

import { createHash } from "node:crypto";

const UNSAFE_SCRIPT_CLOSE = "</script";
const SOURCEMAP_LINE_PATTERN = /(\r?\n)?[ \t]*\/\/# sourceMappingURL=[^\r\n]*[ \t]*$/;
const TRAILING_EXPORT_PATTERN = /export\{([A-Za-z_$][\w$]*) as ([A-Za-z_$][\w$]*)\};$/;
const ANY_EXPORT_PATTERN = /export\{[^}]*\};?/g;
const TOP_LEVEL_IMPORT_PATTERN = /^[ \t]*import\b/m;
// Fix round 1, M8: catches every other ESM export form (`export const`,
// `export default`, `export function`, `export class`, `export let`,
// `export var`, `export * from`, a second `export{...}`, ...) — anything
// with a space (or any whitespace) after the word `export`. The one
// legitimate `export{<ident> as <name>};` never matches this, because
// there's no whitespace between `export` and `{`. None of today's vendor
// files use another export form, so this only bites on a future vendor
// bump that does — exactly the point: fail the build, not the page.
const OTHER_EXPORT_KEYWORD_PATTERN = /\bexport\s/;

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256Base64(text) {
  return createHash("sha256").update(text, "utf8").digest("base64");
}

/**
 * Turns one vendored xterm ESM module into an IIFE that assigns its export
 * onto `globalThis.__jarvisTerm`, so it can sit inline in a page with no
 * module loader and no `import`/`export` at runtime.
 */
export function wrapVendorModule(source, exportName) {
  if (source.includes(UNSAFE_SCRIPT_CLOSE)) {
    throw new Error(
      `wrapVendorModule(${exportName}): input contains an unsafe "</script" sequence`,
    );
  }
  if (TOP_LEVEL_IMPORT_PATTERN.test(source)) {
    throw new Error(`wrapVendorModule(${exportName}): a top-level "import" was found`);
  }
  if (source.includes("import(")) {
    throw new Error(`wrapVendorModule(${exportName}): a dynamic "import(" was found`);
  }
  if (source.includes("import.meta")) {
    throw new Error(`wrapVendorModule(${exportName}): "import.meta" was found`);
  }

  const body = source.replace(/\s+$/, "").replace(SOURCEMAP_LINE_PATTERN, "").replace(/\s+$/, "");

  const allExports = body.match(ANY_EXPORT_PATTERN) ?? [];
  if (allExports.length !== 1) {
    throw new Error(
      `wrapVendorModule(${exportName}): expected exactly one export{...} statement, found ${allExports.length}`,
    );
  }

  const tailMatch = body.match(TRAILING_EXPORT_PATTERN);
  if (!tailMatch) {
    throw new Error(
      `wrapVendorModule(${exportName}): the module must end with export{<ident> as ${exportName}};`,
    );
  }

  const [statement, ident, actualExportName] = tailMatch;
  if (actualExportName !== exportName) {
    throw new Error(
      `wrapVendorModule(${exportName}): expected "export{... as ${exportName}}", got "export{... as ${actualExportName}}"`,
    );
  }

  const bodyWithoutExport = body.slice(0, body.length - statement.length);

  if (OTHER_EXPORT_KEYWORD_PATTERN.test(bodyWithoutExport)) {
    throw new Error(
      `wrapVendorModule(${exportName}): found another "export " form besides the trailing export{...} statement`,
    );
  }

  return `(function(){"use strict";${bodyWithoutExport};globalThis.__jarvisTerm.${exportName}=${ident};})();`;
}

function assertNoUnsafeScriptClose(name, text) {
  if (text.includes(UNSAFE_SCRIPT_CLOSE)) {
    throw new Error(`buildTerminalHtml: input "${name}" contains an unsafe "</script" sequence`);
  }
}

function buildBootCode(theme, fontFamily, scrollback, fontSize) {
  const themeJson = JSON.stringify(theme);
  const fontFamilyJson = JSON.stringify(fontFamily);
  const scrollbackJson = JSON.stringify(scrollback);
  const fontSizeJson = JSON.stringify(fontSize);

  return (
    "(function(){" +
    `var theme=${themeJson};` +
    `var fontFamily=${fontFamilyJson};` +
    `var scrollback=${scrollbackJson};` +
    `var fontSize=${fontSizeJson};` +
    "var Terminal=globalThis.__jarvisTerm.Terminal;" +
    "var FitAddon=globalThis.__jarvisTerm.FitAddon;" +
    "var Unicode11Addon=globalThis.__jarvisTerm.Unicode11Addon;" +
    "var term=new Terminal({disableStdin:true,cursorBlink:false,allowProposedApi:true," +
    "scrollback:scrollback,fontSize:fontSize,fontFamily:fontFamily,theme:theme," +
    "linkHandler:{activate:function(){}}});" +
    "var fitAddon=new FitAddon();" +
    "term.loadAddon(fitAddon);" +
    "term.loadAddon(new Unicode11Addon());" +
    'term.unicode.activeVersion="11";' +
    'term.open(document.getElementById("t"));' +
    'var textarea=document.querySelector("textarea");' +
    "if(textarea){" +
    "textarea.readOnly=true;" +
    'textarea.setAttribute("inputmode","none");' +
    "}" +
    "var controller=createPageController({" +
    "term:term," +
    "fit:function(){fitAddon.fit();}," +
    "post:function(s){window.ReactNativeWebView.postMessage(s);}" +
    "});" +
    'window.addEventListener("message",function(e){controller.receive(e.data);});' +
    'document.addEventListener("message",function(e){controller.receive(e.data);});' +
    'window.addEventListener("resize",function(){controller.layoutChanged();});' +
    "controller.start();" +
    "})();"
  );
}

const CSP =
  "default-src 'none'; " +
  "script-src 'sha256-__SCRIPT_HASH__'; " +
  "style-src 'unsafe-inline'; " +
  "img-src 'none'; " +
  "font-src 'none'; " +
  "connect-src 'none'; " +
  "frame-src 'none'; " +
  "base-uri 'none'; " +
  "form-action 'none'";

const STYLE =
  "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;}" +
  "#t{width:100%;height:100%;}";

export function buildTerminalHtml(inputs) {
  const { xtermJs, fitJs, unicode11Js, xtermCss, pageJs, theme, fontFamily, scrollback, fontSize } =
    inputs;

  assertNoUnsafeScriptClose("xtermJs", xtermJs);
  assertNoUnsafeScriptClose("fitJs", fitJs);
  assertNoUnsafeScriptClose("unicode11Js", unicode11Js);
  assertNoUnsafeScriptClose("xtermCss", xtermCss);
  assertNoUnsafeScriptClose("pageJs", pageJs);

  const wrappedTerminal = wrapVendorModule(xtermJs, "Terminal");
  const wrappedFit = wrapVendorModule(fitJs, "FitAddon");
  const wrappedUnicode11 = wrapVendorModule(unicode11Js, "Unicode11Addon");
  const bootCode = buildBootCode(theme, fontFamily, scrollback, fontSize);

  const scriptText =
    "globalThis.__jarvisTerm={};" +
    wrappedTerminal +
    wrappedFit +
    wrappedUnicode11 +
    pageJs +
    bootCode;

  const scriptSha256 = sha256Base64(scriptText);
  const csp = CSP.replace("__SCRIPT_HASH__", scriptSha256);

  const html =
    "<!doctype html>" +
    '<html dir="ltr">' +
    "<head>" +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<style>${xtermCss}${STYLE}</style>` +
    "</head>" +
    "<body>" +
    '<div id="t"></div>' +
    `<script>${scriptText}</script>` +
    "</body>" +
    "</html>";

  return { html, scriptSha256 };
}
