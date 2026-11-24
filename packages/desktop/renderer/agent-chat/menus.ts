// The chat's listboxes: the `/` and `@` suggestions, and the mode and model
// pickers. A listbox is a role=listbox with role=option rows; arrows move,
// Enter or Tab picks, Escape closes. Keys typed while an IME is composing are
// never taken. A suggestion list keeps the focus in the textarea (the owner
// forwards its keys to handleKey); a picker takes the focus itself.
import { el } from "./dom.js";

export type MenuItem = {
  id: string;
  label: string;
  note?: string;
  /** The current choice (selected on open). */
  current?: boolean;
  /** Label in the code font (commands, file names). */
  mono?: boolean;
};

export type Menu = {
  element: HTMLElement;
  /** Shows the items; `pick` runs with the chosen one and the menu closes. */
  open(items: readonly MenuItem[], pick: (item: MenuItem) => void): void;
  /** Replaces the items of an open menu (a filter changed). */
  setItems(items: readonly MenuItem[]): void;
  close(): void;
  isOpen(): boolean;
  /** For an owner that keeps the focus: true when the key was the menu's. */
  handleKey(event: KeyboardEvent): boolean;
  /** The id of the highlighted row, for aria-activedescendant. */
  activeId(): string | undefined;
};

let counter = 0;

export function createMenu(options: {
  label: string;
  /** Takes the focus on open and gives it back on close (a picker). */
  focusable?: boolean;
  onClose?: () => void;
  empty?: string;
}): Menu {
  const uid = `ac-menu-${++counter}`;
  const element = el("div", "ac-menu");
  element.setAttribute("role", "listbox");
  element.setAttribute("aria-label", options.label);
  element.hidden = true;
  if (options.focusable === true) element.tabIndex = -1;
  let items: readonly MenuItem[] = [];
  let active = 0;
  let pick: ((item: MenuItem) => void) | undefined;
  let returnFocus: Element | null = null;

  function paint(): void {
    element.replaceChildren();
    if (items.length === 0 && options.empty !== undefined) {
      element.append(el("div", "ac-menu__empty", options.empty));
    }
    items.forEach((item, index) => {
      const row = el("div", "ac-menu__row");
      row.id = `${uid}-${index}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === active));
      row.dataset["active"] = String(index === active);
      const label = el(
        "span",
        item.mono === true ? "ac-menu__label ac-mono" : "ac-menu__label",
        item.label,
      );
      label.dir = "auto";
      row.append(label, el("span", "ac-spacer"));
      if (item.note !== undefined && item.note !== "")
        row.append(el("span", "ac-menu__note", item.note));
      row.addEventListener("mousedown", (event) => event.preventDefault());
      row.addEventListener("mousemove", () => {
        if (active !== index) move(index);
      });
      row.addEventListener("click", () => choose(index));
      element.append(row);
    });
    if (items.length > 0) element.setAttribute("aria-activedescendant", `${uid}-${active}`);
    else element.removeAttribute("aria-activedescendant");
  }

  function move(index: number): void {
    if (items.length === 0) return;
    active = (index + items.length) % items.length;
    for (const [at, row] of [...element.querySelectorAll<HTMLElement>(".ac-menu__row")].entries()) {
      row.setAttribute("aria-selected", String(at === active));
      row.dataset["active"] = String(at === active);
    }
    element.setAttribute("aria-activedescendant", `${uid}-${active}`);
    element.querySelector<HTMLElement>(`#${uid}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }

  function choose(index: number): void {
    const item = items[index];
    const run = pick;
    close();
    if (item !== undefined) run?.(item);
  }

  function close(): void {
    const wasOpen = !element.hidden;
    element.hidden = true;
    element.replaceChildren();
    items = [];
    pick = undefined;
    if (wasOpen) {
      if (options.focusable === true && returnFocus instanceof HTMLElement) returnFocus.focus();
      returnFocus = null;
      options.onClose?.();
    }
  }

  function handleKey(event: KeyboardEvent): boolean {
    if (element.hidden || event.isComposing || event.keyCode === 229) return false;
    switch (event.key) {
      case "ArrowDown":
        move(active + 1);
        break;
      case "ArrowUp":
        move(active - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(items.length - 1);
        break;
      case "Enter":
      case "Tab":
        if (items.length === 0) {
          close();
          return false;
        }
        choose(active);
        break;
      case "Escape":
        close();
        break;
      default:
        return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  if (options.focusable === true) {
    element.addEventListener("keydown", (event) => void handleKey(event));
    element.addEventListener("focusout", (event) => {
      if (!element.contains(event.relatedTarget as Node | null)) {
        // A click on a row was taken with mousedown prevented: focus is still here.
        returnFocus = null;
        close();
      }
    });
  }

  return {
    element,
    open(next, onPick) {
      items = next;
      pick = onPick;
      const current = items.findIndex((item) => item.current === true);
      active = current === -1 ? 0 : current;
      returnFocus = document.activeElement;
      element.hidden = false;
      paint();
      if (options.focusable === true) element.focus();
    },
    setItems(next) {
      items = next;
      active = Math.min(active, Math.max(0, items.length - 1));
      paint();
    },
    close,
    isOpen: () => !element.hidden,
    handleKey,
    activeId: () => (element.hidden || items.length === 0 ? undefined : `${uid}-${active}`),
  };
}
