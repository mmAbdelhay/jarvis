// The Workspace nav control's menu (Tabs | Office). The Workspace button
// itself is untouched — every caller that clicks #nav-workspace still lands
// on the tabs — and the chevron beside it opens this menu. While the menu
// is open on the Workspace route the hosted browser page is kept off screen
// (views.ts), since a native view would paint over the menu's lower rows.
//
// All text goes in through textContent; the raised-hands count shows on the
// Office item and as a small count on the chevron.

import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { setWorkspaceMenuOpen } from "./views.js";

export type WorkspaceMenu = {
  /** How many hands are raised in the Office; 0 clears the badges. */
  setHands(count: number): void;
  close(): void;
  isOpen(): boolean;
};

export type WorkspaceMenuDeps = {
  openTabs(): void;
  openOffice(): void;
  doc?: Document;
  language?: "ar" | "en";
};

export function initWorkspaceMenu(deps: WorkspaceMenuDeps): WorkspaceMenu | undefined {
  const doc = deps.doc ?? document;
  const L = deps.language ?? PRIMARY_LANGUAGE;
  const found = {
    more: doc.getElementById("nav-workspace-more"),
    menu: doc.getElementById("nav-workspace-menu"),
    tabsItem: doc.getElementById("nav-menu-tabs"),
    officeItem: doc.getElementById("nav-menu-office"),
    dot: doc.getElementById("nav-office-dot"),
    count: doc.getElementById("nav-office-count"),
  };
  if (Object.values(found).some((element) => element === null)) return undefined;
  const { more, menu, tabsItem, officeItem, dot, count } = found as {
    [K in keyof typeof found]: HTMLElement;
  };
  const items = [tabsItem, officeItem];
  const anchor = more.closest(".nav-split") ?? more;
  let hands = 0;

  // The static labels: index.html carries the English defaults.
  more.setAttribute("aria-label", MESSAGES.officeMoreLabel(L));
  menu.setAttribute("aria-label", MESSAGES.officeMenuLabel(L));
  if (tabsItem.firstChild !== null) tabsItem.firstChild.textContent = MESSAGES.officeMenuTabs(L);
  if (officeItem.firstChild !== null)
    officeItem.firstChild.textContent = MESSAGES.officeMenuOffice(L);

  function isOpen(): boolean {
    return !menu.hidden;
  }

  function focusItem(index: number): void {
    const at = (index + items.length) % items.length;
    items[at]?.focus();
  }

  function open(focus: "first" | "last"): void {
    if (isOpen()) return;
    const rect = anchor.getBoundingClientRect();
    const view = doc.defaultView;
    const rtl = doc.documentElement.dir === "rtl";
    menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    if (rtl && view !== null) {
      menu.style.right = `${Math.round(view.innerWidth - rect.right)}px`;
      menu.style.left = "auto";
    } else {
      menu.style.left = `${Math.round(rect.left)}px`;
      menu.style.right = "auto";
    }
    menu.hidden = false;
    more.setAttribute("aria-expanded", "true");
    setWorkspaceMenuOpen(true);
    focusItem(focus === "first" ? 0 : items.length - 1);
  }

  function close(returnFocus: boolean): void {
    if (!isOpen()) return;
    menu.hidden = true;
    more.setAttribute("aria-expanded", "false");
    setWorkspaceMenuOpen(false);
    if (returnFocus) more.focus();
  }

  more.addEventListener("click", () => {
    if (isOpen()) close(true);
    else open("first");
  });
  more.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    open(event.key === "ArrowDown" ? "first" : "last");
  });
  menu.addEventListener("keydown", (event) => {
    const at = items.indexOf(doc.activeElement as HTMLElement);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusItem(at + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusItem(at - 1);
        break;
      case "Home":
        event.preventDefault();
        focusItem(0);
        break;
      case "End":
        event.preventDefault();
        focusItem(items.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
    }
  });
  doc.addEventListener("pointerdown", (event) => {
    if (!isOpen()) return;
    const target = event.target as Node | null;
    if (target !== null && (menu.contains(target) || more.contains(target))) return;
    close(false);
  });
  doc.defaultView?.addEventListener("blur", () => close(false));
  doc.defaultView?.addEventListener("resize", () => close(false));

  tabsItem.addEventListener("click", () => {
    close(true);
    deps.openTabs();
  });
  officeItem.addEventListener("click", () => {
    close(true);
    deps.openOffice();
  });

  function setHands(next: number): void {
    hands = Math.max(0, Math.floor(next));
    const text = String(hands);
    for (const badge of [dot, count]) {
      badge.textContent = hands === 0 ? "" : text;
      badge.hidden = hands === 0;
    }
    more.setAttribute(
      "aria-label",
      hands === 0 ? MESSAGES.officeMoreLabel(L) : MESSAGES.officeMoreLabelHands(hands, L),
    );
  }

  return { setHands, close: () => close(false), isOpen };
}
