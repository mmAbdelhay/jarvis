// @vitest-environment jsdom
//
// The Workspace nav control: the Workspace button itself (unchanged for every
// existing caller) plus a chevron that opens a menu with Tabs and Office.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGES } from "../src/messages.js";
import { currentView, showView } from "./views.js";
import { initWorkspaceMenu } from "./workspace-menu.js";

const html = readFileSync("packages/desktop/renderer/index.html", "utf8");

function fragment(open: RegExp): string {
  const match = open.exec(html);
  if (match === null) throw new Error(`index.html has no ${String(open)}`);
  return match[0];
}

function layout(): void {
  document.body.innerHTML = `
    <div class="topbar"><div class="nav">
      ${fragment(/<span class="nav-split">[\s\S]*?<\/span>\s*(?=<button id="nav-settings")/)}
    </div></div>
    ${fragment(/<div id="nav-workspace-menu"[\s\S]*?<\/div>/)}
    <div id="view-workspace" hidden></div><div id="view-office" hidden></div>
    <div id="view-dashboard"></div>`;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing #${id}`);
  return found as T;
};
const key = (target: Element, name: string) =>
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
  );

let visible: boolean[];
beforeEach(() => {
  layout();
  visible = [];
  (window as unknown as { jarvis: unknown }).jarvis = {
    setWorkspaceVisible: (value: boolean) => {
      visible.push(value);
      return Promise.resolve();
    },
  };
  showView("workspace");
  visible.length = 0;
});

function setup() {
  const openTabs = vi.fn();
  const openOffice = vi.fn();
  const menu = initWorkspaceMenu({ openTabs, openOffice });
  if (menu === undefined) throw new Error("no menu");
  return { menu, openTabs, openOffice };
}

describe("the Workspace nav control", () => {
  it("keeps #nav-workspace a plain button whose click still reaches existing callers", () => {
    const clicked = vi.fn();
    $("nav-workspace").addEventListener("click", clicked);
    setup();
    $("nav-workspace").click();
    expect(clicked).toHaveBeenCalledTimes(1);
    expect($("nav-workspace-menu").hidden).toBe(true);
  });

  it("is a menu button: aria-haspopup, aria-expanded and menu items", () => {
    setup();
    const more = $("nav-workspace-more");
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    more.click();
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect($("nav-workspace-menu").getAttribute("role")).toBe("menu");
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.map((item) => item.id)).toEqual(["nav-menu-tabs", "nav-menu-office"]);
    expect(document.activeElement).toBe(items[0]);
  });

  it("moves with the arrow keys, wraps, and jumps with Home and End", () => {
    setup();
    $("nav-workspace-more").click();
    const [tabs, office] = [$("nav-menu-tabs"), $("nav-menu-office")];
    key(tabs, "ArrowDown");
    expect(document.activeElement).toBe(office);
    key(office, "ArrowDown");
    expect(document.activeElement).toBe(tabs);
    key(tabs, "ArrowUp");
    expect(document.activeElement).toBe(office);
    key(office, "Home");
    expect(document.activeElement).toBe(tabs);
    key(tabs, "End");
    expect(document.activeElement).toBe(office);
  });

  it("opens from the chevron with ArrowDown and ArrowUp", () => {
    setup();
    key($("nav-workspace-more"), "ArrowUp");
    expect($("nav-workspace-menu").hidden).toBe(false);
    expect(document.activeElement).toBe($("nav-menu-office"));
  });

  it("closes on Escape and returns focus to the chevron", () => {
    setup();
    $("nav-workspace-more").click();
    key($("nav-menu-tabs"), "Escape");
    expect($("nav-workspace-menu").hidden).toBe(true);
    expect($("nav-workspace-more").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe($("nav-workspace-more"));
  });

  it("closes on an outside click but not on a click inside", () => {
    setup();
    $("nav-workspace-more").click();
    $("nav-workspace-menu").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect($("nav-workspace-menu").hidden).toBe(false);
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect($("nav-workspace-menu").hidden).toBe(true);
  });

  it("toggles from the chevron", () => {
    setup();
    $("nav-workspace-more").click();
    $("nav-workspace-more").click();
    expect($("nav-workspace-menu").hidden).toBe(true);
  });

  it("chooses Tabs or Office, closes, and returns focus", () => {
    const { openTabs, openOffice } = setup();
    $("nav-workspace-more").click();
    $("nav-menu-office").click();
    expect(openOffice).toHaveBeenCalledTimes(1);
    expect($("nav-workspace-menu").hidden).toBe(true);
    $("nav-workspace-more").click();
    $("nav-menu-tabs").click();
    expect(openTabs).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe($("nav-workspace-more"));
  });

  it("shows the raised hands on the Office item and on the chevron, and clears at zero", () => {
    const { menu } = setup();
    menu.setHands(3);
    expect($("nav-office-count").textContent).toBe("3");
    expect($("nav-office-count").hidden).toBe(false);
    expect($("nav-office-dot").hidden).toBe(false);
    expect($("nav-office-dot").textContent).toBe("3");
    expect($("nav-workspace-more").getAttribute("aria-label")).toContain("3");
    menu.setHands(0);
    expect($("nav-office-count").hidden).toBe(true);
    expect($("nav-office-dot").hidden).toBe(true);
    expect($("nav-workspace-more").getAttribute("aria-label")).toBe(MESSAGES.officeMoreLabel("en"));
  });

  it("keeps the hosted page off screen while the menu is open on the Workspace route", () => {
    setup();
    $("nav-workspace-more").click();
    expect(visible.at(-1)).toBe(false);
    key($("nav-menu-tabs"), "Escape");
    expect(visible.at(-1)).toBe(true);
  });

  it("does nothing, and says so, when its markup is absent", () => {
    document.body.innerHTML = "";
    expect(initWorkspaceMenu({ openTabs: vi.fn(), openOffice: vi.fn() })).toBeUndefined();
  });

  it("does not change which route is current", () => {
    setup();
    $("nav-workspace-more").click();
    expect(currentView()).toBe("workspace");
  });
});
