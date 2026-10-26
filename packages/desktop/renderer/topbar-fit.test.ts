// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { TOPBAR_COLLAPSE_ORDER, TOPBAR_COLLAPSED_CLASS, fitTopbar } from "./topbar-fit.js";

const html = readFileSync("packages/desktop/renderer/index.html", "utf8");
const css = readFileSync("packages/desktop/renderer/styles.css", "utf8");

function loadTopbar(): HTMLElement {
  document.body.innerHTML = html.match(/<div class="topbar">[\s\S]*?\n {2}<\/div>/)?.[0] ?? "";
  return document.querySelector(".topbar") as HTMLElement;
}

const collapsed = (bar: HTMLElement): string[] =>
  [...bar.querySelectorAll(`.${TOPBAR_COLLAPSED_CLASS}`)].map((el) => el.id || el.className);

describe("fitTopbar", () => {
  let bar: HTMLElement;
  beforeEach(() => {
    bar = loadTopbar();
  });

  it("hides nothing when the bar fits", () => {
    expect(fitTopbar(bar, () => false)).toBe(0);
    expect(collapsed(bar)).toEqual([]);
  });

  it("hides in order until the bar fits", () => {
    let budget = 3;
    expect(fitTopbar(bar, () => budget-- > 0)).toBe(3);
    expect(bar.querySelector("#clock-date")?.classList.contains(TOPBAR_COLLAPSED_CLASS)).toBe(true);
    expect(bar.querySelector("#remote-pill-text")?.classList.contains(TOPBAR_COLLAPSED_CLASS)).toBe(
      true,
    );
    expect(bar.querySelectorAll(`.metric-net.${TOPBAR_COLLAPSED_CLASS}`)).toHaveLength(2);
    expect(bar.querySelector("#header-prayer")?.classList.contains(TOPBAR_COLLAPSED_CLASS)).toBe(
      false,
    );
  });

  it("starts over on each fit, so a wider window gets items back", () => {
    fitTopbar(bar, () => true);
    expect(collapsed(bar).length).toBeGreaterThan(0);
    fitTopbar(bar, () => false);
    expect(collapsed(bar)).toEqual([]);
  });

  it("matches a real element for every step", () => {
    for (const selector of TOPBAR_COLLAPSE_ORDER) {
      expect(bar.querySelectorAll(selector).length, selector).toBeGreaterThan(0);
    }
  });

  it("never hides the nav, the pills, the time or the end buttons", () => {
    fitTopbar(bar, () => true);
    for (const id of [
      "history-button",
      "awake-button",
      "clock-time",
      "running-pill",
      "voice-state",
    ]) {
      expect(bar.querySelector(`#${id}`)?.closest(`.${TOPBAR_COLLAPSED_CLASS}`), id).toBeNull();
    }
    expect(bar.querySelector(".nav")?.closest(`.${TOPBAR_COLLAPSED_CLASS}`)).toBeNull();
  });
});

describe("the collapsed class", () => {
  it("hides whatever it is on", () => {
    expect(css).toMatch(/\.topbar \.topbar-collapsed \{ display: none !important; \}/);
  });
});
