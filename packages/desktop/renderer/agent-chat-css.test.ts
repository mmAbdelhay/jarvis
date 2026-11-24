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
});
