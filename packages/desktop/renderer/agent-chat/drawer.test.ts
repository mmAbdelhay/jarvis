// @vitest-environment jsdom
//
// The terminal drawer's window onto the live terminal: the rows that hold the
// agent's screen, not the empty ones under them.
import { beforeEach, describe, expect, it } from "vitest";
import { createDrawer } from "./drawer.js";

beforeEach(() => {
  document.body.replaceChildren();
});

function build(
  rows: { rows: number; anchor: number } | undefined,
  slotHeight: number,
  screenHeight = 800,
) {
  const host = document.createElement("div");
  const live = document.createElement("div");
  live.className = "terminal-live";
  const xterm = document.createElement("div");
  xterm.className = "xterm";
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  xterm.append(screen);
  live.append(xterm);
  host.append(live);
  const slot = document.createElement("div");
  document.body.append(host, slot);
  const box = (height: number) => () =>
    ({
      left: 0,
      top: 0,
      width: 600,
      height,
      right: 600,
      bottom: height,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect;
  host.getBoundingClientRect = box(900);
  slot.getBoundingClientRect = box(slotHeight);
  screen.getBoundingClientRect = box(screenHeight);
  const state = { rows };
  const drawer = createDrawer(host, { screen: () => state.rows });
  return { host, live, slot, drawer, state };
}

const shift = (live: HTMLElement) => live.style.getPropertyValue("--drawer-shift");

describe("the drawer's window of rows", () => {
  it("puts the last row with content at the slot's bottom when the content is taller than the slot", () => {
    // 40 rows of 20px; content to row 29 (30 rows = 600px) in a 260px slot.
    const t = build({ rows: 40, anchor: 29 }, 260);
    t.drawer.open(t.slot);
    expect(shift(t.live)).toBe("-340px");
  });

  it("aligns short content to the top", () => {
    const t = build({ rows: 40, anchor: 5 }, 260);
    t.drawer.open(t.slot);
    expect(shift(t.live)).toBe("0px");
  });

  it("follows the screen when it changes and the layout moves", () => {
    const t = build({ rows: 40, anchor: 29 }, 260);
    t.drawer.open(t.slot);
    t.state.rows = { rows: 40, anchor: 35 };
    t.drawer.place();
    expect(shift(t.live)).toBe("-460px");
  });

  it("leaves the window alone when the pane gives no screen, and clears it on close", () => {
    const t = build(undefined, 260);
    t.drawer.open(t.slot);
    expect(shift(t.live)).toBe("0px");
    const u = build({ rows: 40, anchor: 29 }, 260);
    u.drawer.open(u.slot);
    u.drawer.close();
    expect(shift(u.live)).toBe("");
  });
});
