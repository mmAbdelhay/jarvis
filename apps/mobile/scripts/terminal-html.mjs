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
    // Bug 8: a fixed size from native (the pty's real cols/rows) gets the
    // largest font in [11,14]px whose `cols` columns fit the WebView's
    // current width (the controller's fixedFont), measured with a scratch
    // canvas rather than xterm's own (fontSize-dependent) internals. A pty
    // wider than 11px fits overflows and pans sideways instead of shrinking
    // to an unreadable size. xterm rounds its cell width to device pixels,
    // so the rendered screen can still come out wider than the canvas
    // estimate — its real width decides the pan too, or the right edge is
    // cut off with no way to reach it.
    'var fitCanvas=document.createElement("canvas");' +
    'var fitCtx=fitCanvas.getContext("2d");' +
    "function charWidthAt(size){" +
    'fitCtx.font=size+"px "+fontFamily;' +
    'return fitCtx.measureText("M").width;' +
    "}" +
    "function applyFixedSize(cols,rows){" +
    'var container=document.getElementById("t");' +
    "var width=container.clientWidth;" +
    "var font=controller.fixedFont(cols,width,charWidthAt);" +
    "term.options.fontSize=font.size;" +
    "term.resize(cols,rows);" +
    'var screen=container.querySelector(".xterm-screen");' +
    "var overflowing=font.overflowing||(screen!==null&&screen.scrollWidth>width);" +
    'container.style.overflowX=overflowing?"auto":"hidden";' +
    'container.style.touchAction=overflowing?"pan-x":"none";' +
    "}" +
    // Fit toggle: back to fitting the WebView — no pan, and fitAddon's own
    // font size rather than whatever the fixed size last picked.
    "function fitToView(){" +
    'var container=document.getElementById("t");' +
    "term.options.fontSize=fontSize;" +
    'container.style.overflowX="hidden";' +
    'container.style.touchAction="none";' +
    "fitAddon.fit();" +
    "}" +
    // Bug 9: `term` is passed straight through as `PageDeps.term` — real
    // xterm 6 already shapes `.write`/`.reset`/`.cols`/`.rows`/`.modes`/
    // `.buffer.active.type`/`.scrollLines` exactly like `PageTerminal`, so
    // no adapter object is needed here.
    "var controller=createPageController({" +
    "term:term," +
    "fit:fitToView," +
    // Task 13: the same script also runs in the browser build, as the
    // static terminal.html in a sandboxed iframe (TerminalWebView.web.tsx)
    // with no ReactNativeWebView bridge — there it posts to its parent.
    // `"*"` is unavoidable: the sandboxed frame has an opaque origin and
    // no referrer, so it cannot name its parent's origin; the parent
    // filters on `event.source` instead, and only ready/resize/modes/wheel
    // (never terminal content) is ever posted.
    "post:function(s){" +
    "if(window.ReactNativeWebView){window.ReactNativeWebView.postMessage(s);}" +
    'else if(window.parent!==window){window.parent.postMessage(s,"*");}' +
    "}," +
    "applyFixedSize:applyFixedSize," +
    'lineHeightPx:function(){return document.getElementById("t").clientHeight/term.rows;},' +
    // Getting around the scrollback: xterm's own buffer and viewport,
    // read and moved here; only geometry and a found/not-found bit ever
    // go back to native (terminal-page.ts).
    "nav:{" +
    "viewportY:function(){return term.buffer.active.viewportY;}," +
    "baseY:function(){return term.buffer.active.baseY;}," +
    "lineCount:function(){return term.buffer.active.length;}," +
    'lineText:function(y){var l=term.buffer.active.getLine(y);return l?l.translateToString(true):"";},' +
    "scrollToLine:function(y){term.scrollToLine(y);}," +
    "scrollToBottom:function(){term.scrollToBottom();}," +
    "select:function(c,r,n){term.select(c,r,n);}" +
    "}" +
    "});" +
    // The laptop's shell integration marks each prompt with OSC 133;A.
    // Each one becomes a stop for "previous / next command"; returning
    // false leaves the sequence to xterm's own (no-op) handling.
    "term.parser.registerOscHandler(133,function(data){" +
    'if(data.charAt(0)==="A"){var m=term.registerMarker(0);if(m)controller.commandMark(m);}' +
    "return false;" +
    "});" +
    "term.onScroll(function(){controller.viewChanged();});" +
    // In the iframe, only the parent (the app) may drive the terminal; the
    // native WebView's own injected events carry no source, and are
    // accepted exactly as before.
    'window.addEventListener("message",function(e){' +
    "if(!window.ReactNativeWebView&&e.source!==window.parent)return;" +
    "controller.receive(e.data);" +
    "});" +
    'document.addEventListener("message",function(e){controller.receive(e.data);});' +
    'window.addEventListener("resize",function(){controller.layoutChanged();});' +
    // Bug 9: touch scrolling — xterm 6's own viewport is wheel-only, so
    // every touch gesture on the terminal element is turned into
    // scrollLines()/wheel calls by the controller itself — a mostly
    // sideways one excepted, which is the native "pan-x" pan (its axis is
    // locked in the controller, so it never scrolls as well). `{passive:true}`
    // throughout: CSS `touch-action` (STYLE, and applyFixedSize's
    // "pan-x" override) is what stops the WebView's own default handling,
    // not preventDefault() here.
    "var touchY=0;" +
    "var touchX=0;" +
    'document.getElementById("t").addEventListener("touchstart",function(e){' +
    "var t0=e.touches[0];" +
    "if(!t0)return;" +
    "touchY=t0.clientY;" +
    "touchX=t0.clientX;" +
    "controller.touchStart();" +
    "},{passive:true});" +
    'document.getElementById("t").addEventListener("touchmove",function(e){' +
    "var t0=e.touches[0];" +
    "if(!t0)return;" +
    "var dy=t0.clientY-touchY;" +
    "var dx=t0.clientX-touchX;" +
    "touchY=t0.clientY;" +
    "touchX=t0.clientX;" +
    "controller.touchMove(dy,dx);" +
    "},{passive:true});" +
    'document.getElementById("t").addEventListener("touchend",function(){' +
    "controller.touchEnd();" +
    "},{passive:true});" +
    'document.getElementById("t").addEventListener("touchcancel",function(){' +
    "controller.touchEnd();" +
    "},{passive:true});" +
    // Wide layout: the browser build tells its parent what is selected,
    // so a copy chord in the app can copy it (the app's capture element
    // holds the keyboard focus, not this frame). Never on native.
    "term.onSelectionChange(function(){" +
    "if(window.ReactNativeWebView)return;" +
    "controller.selectionChanged();" +
    "});" +
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

// Bug 9: touch-action:none on the terminal element so the WebView never
// natively scrolls it — every touch gesture reaches the page's own
// touchstart/touchmove handlers instead, which turn a vertical drag into
// term.scrollLines() (or, in the alternate screen buffer with mouse
// tracking on, an SGR wheel sequence). applyFixedSize() (bug 8) is the only
// thing that ever relaxes this, to "pan-x" for whatever a size that cannot
// shrink to the WebView's width still overflows by.
const STYLE =
  "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;}" +
  "#t{width:100%;height:100%;touch-action:none;}";

/** The page's one script, exactly as both the native inline page and the
 *  browser's external terminal.<hash>.js carry it. */
function buildTerminalScript(inputs) {
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

  return (
    "globalThis.__jarvisTerm={};" +
    wrappedTerminal +
    wrappedFit +
    wrappedUnicode11 +
    pageJs +
    bootCode
  );
}

export function buildTerminalHtml(inputs) {
  const scriptText = buildTerminalScript(inputs);

  const scriptSha256 = sha256Base64(scriptText);
  const csp = CSP.replace("__SCRIPT_HASH__", scriptSha256);

  const html =
    "<!doctype html>" +
    '<html dir="ltr">' +
    "<head>" +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<style>${inputs.xtermCss}${STYLE}</style>` +
    "</head>" +
    "<body>" +
    '<div id="t"></div>' +
    `<script>${scriptText}</script>` +
    "</body>" +
    "</html>";

  return { html, scriptSha256 };
}

// Task 13 (controller ruling): the browser build loads the terminal as a
// static page, `<iframe src="/terminal.html" sandbox="allow-scripts">`,
// instead of an inline srcdoc — so the web app's own CSP never has to
// allow an inline script. Same script, split out into external files.
// 'self' is the server that served terminal.html: a sandboxed frame's
// origin is opaque, but CSP matches 'self' against the page's URL. Styles
// keep 'unsafe-inline' (xterm sets element styles at runtime), as the
// native page does; scripts never do.
const WEB_CSP =
  "default-src 'none'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'none'; " +
  "font-src 'none'; " +
  "connect-src 'none'; " +
  "frame-src 'none'; " +
  "base-uri 'none'; " +
  "form-action 'none'";

function contentName(text, extension) {
  return `terminal.${sha256Hex(text).slice(0, 16)}.${extension}`;
}

export function buildTerminalWebPage(inputs) {
  const script = buildTerminalScript(inputs);
  const style = inputs.xtermCss + STYLE;
  const scriptName = contentName(script, "js");
  const styleName = contentName(style, "css");
  const html =
    "<!doctype html>" +
    '<html dir="ltr">' +
    "<head>" +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">' +
    `<meta http-equiv="Content-Security-Policy" content="${WEB_CSP}">` +
    '<meta name="referrer" content="no-referrer">' +
    `<link rel="stylesheet" href="${styleName}">` +
    "</head>" +
    "<body>" +
    '<div id="t"></div>' +
    `<script src="${scriptName}"></script>` +
    "</body>" +
    "</html>";
  return { html, script, style, scriptName, styleName };
}

const SCRIPT_ELEMENT_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/** Every <script> element in `html` that is not a bodiless external one. */
export function findInlineScripts(html) {
  const offenders = [];
  for (const match of html.matchAll(SCRIPT_ELEMENT_PATTERN)) {
    const [element, attributes, body] = match;
    if (!/(?:^|\s)src\s*=/i.test(attributes) || body.trim() !== "") offenders.push(element);
  }
  return offenders;
}
