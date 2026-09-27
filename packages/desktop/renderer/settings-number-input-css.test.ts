// A source assertion over styles.css, the same shape as history-overlay-css
// and running-pill-css: jsdom cannot lay out real UA form controls (a
// number input's spin buttons are UA chrome, not something getComputedStyle
// reports on), so the fix is pinned at the CSS source instead.
//
// Bug 4: `.settings-row input[type="text"]` and `.settings-field
// input[type="text"]` (plus their :focus variants) set the dark colours,
// but excluded `input[type="number"]` — so prayer latitude/longitude/
// notify-minutes rendered dark text on the light UA default background.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

function ruleBody(pattern: RegExp): string {
  const match = pattern.exec(css);
  if (match === null) throw new Error(`No CSS rule found for ${pattern}`);
  const body = match[1];
  if (body === undefined) throw new Error(`No CSS rule found for ${pattern}`);
  return body;
}

describe("settings number inputs get the dark colour rule", () => {
  it(".settings-row covers input[type=number] alongside input[type=text], with color-scheme: dark", () => {
    const body = ruleBody(
      /\.settings-row input\[type="text"\],\s*\.settings-row input\[type="number"\],\s*\.settings-row select \{([^}]*)\}/,
    );
    expect(body).toMatch(/color:\s*var\(--text\)/);
    expect(body).toMatch(/color-scheme:\s*dark/);
  });

  it(".settings-row:focus covers input[type=number] alongside input[type=text]", () => {
    const body = ruleBody(
      /\.settings-row input\[type="text"\]:focus,\s*\.settings-row input\[type="number"\]:focus,\s*\.settings-row select:focus \{([^}]*)\}/,
    );
    expect(body).toMatch(/border-color:\s*var\(--accent\)/);
  });

  it(".settings-field covers input[type=number] alongside input[type=text], with color-scheme: dark", () => {
    const body = ruleBody(
      /\.settings-field input\[type="text"\],\s*\.settings-field input\[type="number"\],\s*\.settings-field select \{([^}]*)\}/,
    );
    expect(body).toMatch(/color:\s*var\(--text\)/);
    expect(body).toMatch(/color-scheme:\s*dark/);
  });
});
