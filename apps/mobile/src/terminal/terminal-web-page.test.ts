// The browser build's static terminal page (Task 13, controller ruling):
// dist-web/terminal.html plus hashed external terminal.<hash>.js/.css,
// built from the same inputs as the native inline page, with no inline
// <script> anywhere.
import { describe, expect, it } from "vitest";
import {
  buildTerminalHtml,
  buildTerminalWebPage,
  findInlineScripts,
} from "../../scripts/terminal-html.mjs";
import { readTerminalInputs } from "../../scripts/terminal-inputs.mjs";

describe("buildTerminalWebPage", () => {
  it("emits terminal.html that loads only external, content-hashed script and style", async () => {
    const page = buildTerminalWebPage(await readTerminalInputs());
    expect(page.scriptName).toMatch(/^terminal\.[0-9a-f]{16}\.js$/);
    expect(page.styleName).toMatch(/^terminal\.[0-9a-f]{16}\.css$/);
    expect(page.html).toContain(`<script src="${page.scriptName}"></script>`);
    expect(page.html).toContain(`<link rel="stylesheet" href="${page.styleName}">`);
    expect(findInlineScripts(page.html)).toEqual([]);
    expect(page.html).not.toContain("<style");
    expect(page.html).toContain('dir="ltr"');
  });

  it("runs exactly the native page's script (same inputs, same behaviour)", async () => {
    const inputs = await readTerminalInputs();
    const page = buildTerminalWebPage(inputs);
    const native = buildTerminalHtml(inputs).html;
    expect(native).toContain(`<script>${page.script}</script>`);
  });

  it("the CSP allows scripts and styles only from the page's own origin, never inline script", async () => {
    const { html } = buildTerminalWebPage(await readTerminalInputs());
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
  });

  it("changes the file names when the content changes", async () => {
    const inputs = await readTerminalInputs();
    const a = buildTerminalWebPage(inputs);
    const b = buildTerminalWebPage({ ...inputs, fontSize: inputs.fontSize + 1 });
    expect(b.scriptName).not.toBe(a.scriptName);
    expect(b.styleName).toBe(a.styleName);
  });
});

describe("findInlineScripts", () => {
  it("flags a script element without src, and one with src but a body", () => {
    expect(findInlineScripts("<script>alert(1)</script>")).toHaveLength(1);
    expect(findInlineScripts('<script type="module">x</script>')).toHaveLength(1);
    expect(findInlineScripts('<script src="a.js">x</script>')).toHaveLength(1);
    expect(findInlineScripts("<SCRIPT >x</SCRIPT>")).toHaveLength(1);
  });

  it("accepts external scripts only", () => {
    expect(findInlineScripts('<script src="/a.js" defer></script>')).toEqual([]);
    expect(findInlineScripts("<p>no scripts</p>")).toEqual([]);
  });
});
