// A source assertion over index.html and styles.css. See
// view-display-css.test.ts for why: jsdom special-cases `hidden` outside the
// cascade, so a computed-style check here would not see what the real
// window renders.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
const html = readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

describe("the running-sessions pill", () => {
  // It used to be hidden at zero, which made "nothing is running" look like
  // "there is no indicator". It must be on screen before the first sessions
  // update arrives, too — that update only comes when something changes.
  it("is in the topbar from the first paint, reading 0 running", () => {
    const pill = html.match(/<button id="running-pill"[^>]*>/)?.[0] ?? "";
    expect(pill).not.toBe("");
    expect(pill).not.toMatch(/\shidden[\s>]/);
    expect(html).toContain('<span id="running-count" class="mono">0 running</span>');
  });

  it("has a dimmed idle style", () => {
    expect(css).toMatch(/\.pill--running\.pill--idle \{/);
  });
});

describe("M3 Settings polish carried into M4", () => {
  it("the Off/On state label is no longer monospace", () => {
    const state = html.match(/<span id="settings-remote-state"[^>]*>/)?.[0] ?? "";
    expect(state).not.toBe("");
    expect(state).not.toMatch(/class="[^"]*\bmono\b/);
  });

  it("disabled .settings-add buttons (e.g. New code while off) get the dimmed style", () => {
    expect(css).toMatch(/\.settings-add:disabled \{/);
  });
});

describe("the remote-bridge listening pill", () => {
  // Unlike the running-sessions pill, this one really is hidden until the
  // bridge reports it is listening — so it needs the opposite guard from
  // running-pill above: an explicit `display: none` that out-cascades
  // `.pill`'s own unconditional `display: flex`.
  it("is hidden at first paint", () => {
    const pill = html.match(/<button id="remote-pill"[^>]*>/)?.[0] ?? "";
    expect(pill).not.toBe("");
    expect(pill).toMatch(/\shidden[\s>]/);
  });

  it("has a [hidden] override in the CSS", () => {
    expect(css).toMatch(/\.pill--remote\[hidden\] \{[^}]*display:\s*none/);
  });
});
