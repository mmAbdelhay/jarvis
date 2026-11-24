// The Chat view's layout, pinned at the source (jsdom computes no layout, so
// like terminal-layout-css.test.ts this reads styles.css as text). What goes
// wrong without these is invisible to every other test: a switch floated over
// the pane's corner sits on a block's buttons or on the Plan/Reviews/sidebar
// switches; a hidden terminal that is `display: none` through the wrong
// selector hides the palette with it; a feed that cannot shrink pushes the
// composer out of the pane.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

function ruleBodyFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  const body = match?.[1];
  if (body === undefined) throw new Error(`No CSS rule found for selector ${selector}`);
  return body;
}

describe("the agent chat's layout", () => {
  it("keeps the switch in the pane's flow, so it overlaps no toggle in any split", () => {
    const body = ruleBodyFor(".agent-bar");
    expect(body).not.toMatch(/position\s*:\s*(absolute|fixed)/);
    expect(body).toMatch(/flex\s*:\s*0\s+0\s+auto/);
    expect(ruleBodyFor(".agent-bar[hidden]")).toMatch(/display\s*:\s*none/);
  });

  it("hides only the terminal's own surfaces while the chat shows", () => {
    const body = ruleBodyFor('.terminal-pane[data-view="chat"] > [data-term-surface]');
    expect(body).toMatch(/display\s*:\s*none/);
    // The palette, find bar and completion dropdown live in the pane too and
    // must keep working from the chat.
    expect(css).not.toMatch(/\[data-view="chat"\]\s*>\s*\*/);
  });

  it("lets the feed shrink and scroll, keeping the composer in the pane", () => {
    const feed = ruleBodyFor(".agent-chat__feed");
    expect(feed).toMatch(/min-height\s*:\s*0/);
    expect(feed).toMatch(/overflow-y\s*:\s*auto/);
    const chat = ruleBodyFor(".agent-chat");
    expect(chat).toMatch(/min-height\s*:\s*0/);
    expect(ruleBodyFor(".agent-chat[hidden]")).toMatch(/display\s*:\s*none/);
  });

  it("draws the user's bubble with the shared token", () => {
    expect(ruleBodyFor(".agent-chat__bubble")).toContain("var(--user-bubble)");
  });

  it("gives every control a visible keyboard focus", () => {
    for (const selector of [
      ".agent-switch__tab:focus-visible",
      ".agent-chat__input:focus-visible",
      ".agent-chat__send:focus-visible",
      ".agent-chat__option:focus-visible",
      ".agent-chat__feed:focus-visible",
      ".agent-chat__link:focus-visible",
    ]) {
      expect(ruleBodyFor(selector)).toMatch(/outline\s*:/);
    }
  });

  it("dims a disabled composer", () => {
    expect(ruleBodyFor(".agent-chat__input:disabled")).toMatch(/opacity/);
    expect(ruleBodyFor(".agent-chat__send:disabled")).toMatch(/opacity/);
  });

  it("centres a 820px column and gives the side panel 320px", () => {
    expect(ruleBodyFor(".ac-column")).toMatch(/width\s*:\s*min\(820px,\s*100%\)/);
    expect(ruleBodyFor(".ac-lower")).toMatch(/width\s*:\s*min\(820px,\s*100%\)/);
    expect(ruleBodyFor(".ac-side")).toMatch(/width\s*:\s*320px/);
  });

  it("lets rows skip their layout while off screen, so thousands scroll smoothly", () => {
    expect(ruleBodyFor(".ac-row")).toMatch(/content-visibility\s*:\s*auto/);
  });

  it("lays the live terminal over the card's slot for the drawer, anchored to its bottom rows", () => {
    const drawer = ruleBodyFor(
      '.terminal-pane[data-view="chat"][data-drawer="on"] > .terminal-live',
    );
    expect(drawer).toMatch(/display\s*:\s*block/);
    expect(drawer).toMatch(/position\s*:\s*absolute/);
    const xterm = ruleBodyFor(
      '.terminal-pane[data-view="chat"][data-drawer="on"] > .terminal-live .xterm',
    );
    expect(xterm).toMatch(/transform\s*:\s*translateY\(var\(--drawer-shift/);
    // Wide agent screens scroll sideways instead of being cut.
    expect(drawer).toMatch(/overflow-x\s*:\s*auto/);
  });

  it("stops its animations for people who ask for reduced motion", () => {
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{[^}]*ac-working svg[^}]*animation\s*:\s*none/,
    );
  });

  it("uses logical properties for what sits at the start or end, so Arabic mirrors", () => {
    expect(ruleBodyFor(".ac-side")).toMatch(/border-inline-start/);
    expect(ruleBodyFor(".agent-chat__bubble")).toMatch(/margin-inline-start\s*:\s*auto/);
    expect(ruleBodyFor(".ac-msg__actions")).toMatch(/inset-inline-end/);
  });

  it("gives the new controls a visible keyboard focus", () => {
    for (const selector of [
      ".ac-jump:focus-visible",
      ".ac-file:focus-visible",
      ".ac-menu:focus-visible",
    ]) {
      expect(css).toContain(selector);
    }
  });

  it("draws one focus ring, on the composer's box, not on the field inside it", () => {
    expect(ruleBodyFor(".agent-chat__input:focus-visible")).toMatch(/outline\s*:\s*none/);
    expect(ruleBodyFor(".agent-chat__composer:focus-within")).toMatch(/outline\s*:\s*2px solid/);
  });

  it("keeps code, commands and diffs left aligned whatever the interface language", () => {
    expect(ruleBodyFor(".ac-code, .ac-cmd, .ac-diff, .ac-output__text")).toMatch(
      /text-align\s*:\s*left/,
    );
  });

  it("hides the tab's toolbar strip, and its band, while every pane shows Chat", () => {
    expect(ruleBodyFor(".terminal-split[data-chat-only]")).toMatch(/padding-block-start\s*:\s*0/);
    expect(css).toMatch(
      /\.terminal-split\[data-chat-only\] > :is\([^)]*\.reviews-toggle[^)]*\) \{\s*display: none;/,
    );
  });

  it("gives every chat scroller a themed thumb on a transparent track (classic scrollbars show a white track otherwise)", () => {
    const selectors = [
      ".agent-chat__feed",
      ".ac-side",
      ".ac-code",
      ".ac-diff",
      ".ac-output__text",
      ".ac-menu",
      ".ac-popover",
      ".ac-question__plan",
      '.terminal-pane[data-view="chat"] > .terminal-live',
    ];
    const rule =
      /(?:^|\n)\s*([^{}\n]*scrollbar-color[^{}\n]*|[^{}]*)\{[^}]*scrollbar-color\s*:\s*var\(--text-faint\)\s+transparent[^}]*\}/g;
    const heads = [...css.matchAll(rule)].map((m) => m[0]);
    const block = heads.join("\n");
    for (const selector of selectors) expect(block).toContain(selector);
  });
});
