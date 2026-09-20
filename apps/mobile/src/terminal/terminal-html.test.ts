// Proves the committed src/terminal/terminal-html.generated.ts is exactly
// what scripts/build-terminal-html.mjs would produce right now from the
// desktop's vendored xterm build (task-6-brief.md, "Tests"). This is one of
// the two stated exceptions in global-constraints.md allowing apps/mobile
// tests to read packages/desktop/renderer directly.
//
// Fix round 1, M5: input loading, page stripping (including the CLI's
// "exactly one export" assertion, which this file's own earlier copy
// silently skipped) and the font formula now come from terminal-inputs.mjs,
// shared with the CLI, instead of a second copy of the same logic.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildTerminalHtml, sha256Hex, wrapVendorModule } from "../../scripts/terminal-html.mjs";
import { readTerminalInputs } from "../../scripts/terminal-inputs.mjs";
import {
  TERMINAL_HTML,
  TERMINAL_SCRIPT_SHA256,
  TERMINAL_SOURCE_SHA256,
} from "./terminal-html.generated";

async function regenerate() {
  const inputs = await readTerminalInputs();
  const { html, scriptSha256 } = buildTerminalHtml(inputs);

  return { html, scriptSha256, inputs: inputs.raw };
}

describe("terminal-html.generated.ts drift", () => {
  it(
    "building from the real inputs equals the committed TERMINAL_HTML exactly " +
      "[bite-proof: change one byte of the generated HTML; regenerate with " +
      "`pnpm --dir apps/mobile run build:terminal-html` and this test flags the drift]",
    async () => {
      const { html } = await regenerate();
      expect(html).toBe(TERMINAL_HTML);
    },
  );

  it("keeps the desktop palette, font and scrollback with the phone font size", async () => {
    const inputs = await readTerminalInputs();
    expect(inputs.fontSize).toBe(12);
    expect(inputs.fontFamily).toBe('"JetBrains Mono", ui-monospace, monospace, monospace');
    expect(inputs.scrollback).toBe(5000);
    expect(inputs.theme.background).toBe("#060a0f");
    expect(inputs.theme.foreground).toBe("#e6f3f8");
    expect(/disableStdin:\s*true/.test(TERMINAL_HTML)).toBe(true);
  });

  // Fix round 3, m-r1-1 (the remaining five of six): pins on `inputs`
  // (checked above) only protect against changing the *inputs* module —
  // they don't catch a builder-template edit (e.g. hard-coding a live
  // `linkHandler` or `textarea.readOnly=false` in `buildBootCode`)
  // followed by a regeneration, because the drift test only compares
  // builder(inputs) to the committed output, never the HTML's own content.
  // These are literal substring checks on the committed TERMINAL_HTML
  // itself, so a builder change that regenerates a differently-hardened
  // page still fails here even though the drift test stays green.
  it(
    "the boot code hard-codes the security-relevant xterm options literally " +
      "[bite-proof: change any one of these in buildBootCode, regenerate, and the " +
      "matching assertion fails even though the drift test above still passes]",
    () => {
      expect(TERMINAL_HTML).toContain("textarea.readOnly=true;");
      expect(TERMINAL_HTML).toContain('textarea.setAttribute("inputmode","none");');
      expect(TERMINAL_HTML).toContain("linkHandler:{activate:function(){}}");
      expect(TERMINAL_HTML).toContain("var fontSize=12;");
      expect(TERMINAL_HTML).toContain("var scrollback=5000;");
    },
  );

  it("TERMINAL_SOURCE_SHA256 matches each input", async () => {
    const { inputs } = await regenerate();
    expect(TERMINAL_SOURCE_SHA256["xterm.mjs"]).toBe(sha256Hex(inputs.xtermJs));
    expect(TERMINAL_SOURCE_SHA256["addon-fit.mjs"]).toBe(sha256Hex(inputs.fitJs));
    expect(TERMINAL_SOURCE_SHA256["addon-unicode11.mjs"]).toBe(sha256Hex(inputs.unicode11Js));
    expect(TERMINAL_SOURCE_SHA256["xterm.css"]).toBe(sha256Hex(inputs.xtermCss));
    expect(TERMINAL_SOURCE_SHA256["terminal-theme.ts"]).toBe(sha256Hex(inputs.themeSource));
    expect(TERMINAL_SOURCE_SHA256["terminal-page.ts"]).toBe(sha256Hex(inputs.pageSource));
  });

  it(
    "the CSP's sha256 equals SHA-256 over the exact <script> text " +
      "[bite-proof: append a space to the script in the builder without rehashing]",
    () => {
      const scriptMatch = TERMINAL_HTML.match(/<script>([\s\S]*)<\/script>/);
      expect(scriptMatch).not.toBeNull();
      const scriptText = scriptMatch?.[1] ?? "";
      const actualHash = createHash("sha256").update(scriptText, "utf8").digest("base64");
      expect(actualHash).toBe(TERMINAL_SCRIPT_SHA256);
      expect(TERMINAL_HTML).toContain(`script-src 'sha256-${TERMINAL_SCRIPT_SHA256}'`);
    },
  );

  it('has exactly one <script>, no src= attribute, no http:/https: in any attribute, and dir="ltr"', () => {
    const scriptOpenCount = (TERMINAL_HTML.match(/<script/g) ?? []).length;
    expect(scriptOpenCount).toBe(1);

    // "no src= attribute anywhere" / "no http:/https: in any attribute" are
    // about the HTML markup's own tags, not about text that merely sits
    // inside the <script> or <style> payloads (the vendored xterm bundle
    // compares a variable to the XHTML namespace URI in plain JS, and
    // xterm.css carries a license comment with a URL — neither is an HTML
    // attribute). Strip those payloads before scanning the shell markup.
    const shell = TERMINAL_HTML.replace(/<script>[\s\S]*<\/script>/, "<script></script>").replace(
      /<style>[\s\S]*<\/style>/,
      "<style></style>",
    );
    expect(shell).not.toContain("src=");
    expect(shell).not.toMatch(/="https?:/);
    expect(TERMINAL_HTML).toContain('<html dir="ltr">');
  });

  it("the CSP has default-src 'none', connect-src 'none', frame-src 'none' and no unsafe-eval", () => {
    expect(TERMINAL_HTML).toContain("default-src 'none'");
    expect(TERMINAL_HTML).toContain("connect-src 'none'");
    expect(TERMINAL_HTML).toContain("frame-src 'none'");
    expect(TERMINAL_HTML).not.toContain("unsafe-eval");
  });
});

describe("wrapVendorModule", () => {
  it('throws for a source with "import x from"', () => {
    expect(() =>
      wrapVendorModule('import x from "y";var a=1;export{a as Terminal};', "Terminal"),
    ).toThrow();
  });

  it('throws for a source with "import("', () => {
    expect(() =>
      wrapVendorModule('var a=1;var b=import("y");export{a as Terminal};', "Terminal"),
    ).toThrow();
  });

  it("throws for a source with two export{...} statements", () => {
    expect(() =>
      wrapVendorModule("var a=1;var b=2;export{a as Terminal};export{b as Terminal};", "Terminal"),
    ).toThrow();
  });

  it("throws for a wrong export name", () => {
    expect(() => wrapVendorModule("var a=1;export{a as FitAddon};", "Terminal")).toThrow();
  });

  // Fix round 1, M8: other ESM export forms would survive stripping into
  // the IIFE as a runtime syntax error (an `export` keyword inside a
  // plain function body). None of today's vendor files use them, but a
  // future vendor bump could.
  it('throws for a source with "export const"', () => {
    expect(() => wrapVendorModule("export const a=1;export{a as Terminal};", "Terminal")).toThrow();
  });

  it('throws for a source with "export default"', () => {
    expect(() =>
      wrapVendorModule("var a=1;export default a;export{a as Terminal};", "Terminal"),
    ).toThrow();
  });

  it('throws for a source with "export function"', () => {
    expect(() =>
      wrapVendorModule("export function f(){}\nvar a=1;export{a as Terminal};", "Terminal"),
    ).toThrow();
  });

  it("returns a wrapper assigning globalThis.__jarvisTerm.Terminal for a minimal module", () => {
    const source = "var a=1;export{a as Terminal};\n//# sourceMappingURL=x.map";
    const wrapper = wrapVendorModule(source, "Terminal");

    const jarvisTerm: Record<string, unknown> = {};
    const fn = new Function("globalThis", wrapper);
    fn({ __jarvisTerm: jarvisTerm });

    expect(jarvisTerm.Terminal).toBe(1);
  });

  it('throws when the input contains "</script"', () => {
    expect(() =>
      wrapVendorModule('var a="</script>";export{a as Terminal};', "Terminal"),
    ).toThrow();
  });
});
