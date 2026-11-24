// The chat's listboxes: the `/` and `@` suggestions, and the mode and model
// pickers. A listbox is a role=listbox with role=option rows; arrows move,
// Enter or Tab picks, Escape closes. Keys typed while an IME is composing are
// never taken. A suggestion list keeps the focus in the textarea (the owner
// forwards its keys to handleKey); a picker takes the focus itself.
import { fileIcon } from "../file-icons.js";
import { el } from "./dom.js";

export type MenuItem = {
  id: string;
  label: string;
  note?: string;
  /** The current choice (selected on open). */
  current?: boolean;
  /** Label in the code font (commands, file names). */
  mono?: boolean;
  /** A file name to draw the theme's icon of before the label. */
  icon?: string;
  /** The folder that holds it, for the names the theme keys by path. */
  iconParent?: string;
  /** Quiet argument hint after the label. */
  hint?: string;
  /** Full text of a shortened note, for the hover title. */
  title?: string;
  /** Small tag at the end of the row (where a command comes from). */
  tag?: string;
  /** Heading shown above the first row of each group. */
  group?: string;
  /** Indexes of the label's letters to mark (the matched ones). */
  marks?: readonly number[];
};

export type Menu = {
  element: HTMLElement;
  /** Shows the items; `pick` runs with the chosen one and the menu closes. */
  open(items: readonly MenuItem[], pick: (item: MenuItem) => void): void;
  /** Replaces the items of an open menu (a filter changed); `reset` goes back to the first row. */
  setItems(items: readonly MenuItem[], reset?: boolean): void;
  /** True once the keys moved the choice (the pointer does not count). */
  moved(): boolean;
  close(): void;
  isOpen(): boolean;
  /** For an owner that keeps the focus: true when the key was the menu's. */
  handleKey(event: KeyboardEvent): boolean;
  /** What an open menu with no rows says (a list that came back empty). */
  setEmpty(text: string | undefined): void;
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
  let emptyText = options.empty;
  let items: readonly MenuItem[] = [];
  let active = 0;
  let pick: ((item: MenuItem) => void) | undefined;
  let returnFocus: Element | null = null;
  let touched = false;
  let pointer: { x: number; y: number } | undefined;

  function labelNode(item: MenuItem): HTMLElement {
    const label = el("span", item.mono === true ? "ac-menu__label ac-mono" : "ac-menu__label");
    label.dir = "auto";
    const marked = new Set(item.marks ?? []);
    if (marked.size === 0) {
      label.textContent = item.label;
      return label;
    }
    let run = "";
    let inMark = false;
    const flush = (): void => {
      if (run === "") return;
      label.append(inMark ? el("mark", "ac-menu__mark", run) : document.createTextNode(run));
      run = "";
    };
    [...item.label].forEach((letter, index) => {
      const is = marked.has(index);
      if (is !== inMark) {
        flush();
        inMark = is;
      }
      run += letter;
    });
    flush();
    return label;
  }

  function paint(): void {
    element.replaceChildren();
    element.classList.toggle("ac-menu--long", items.length > 200);
    if (items.length === 0 && emptyText !== undefined) {
      element.append(el("div", "ac-menu__empty", emptyText));
    }
    let group: string | undefined;
    items.forEach((item, index) => {
      if (item.group !== undefined && item.group !== group) {
        group = item.group;
        const heading = el("div", "ac-menu__group", item.group);
        heading.setAttribute("role", "presentation");
        element.append(heading);
      }
      const row = el("div", "ac-menu__row");
      row.id = `${uid}-${index}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === active));
      row.dataset["active"] = String(index === active);
      if (item.icon !== undefined) {
        row.append(
          fileIcon(item.icon, item.iconParent === undefined ? {} : { parent: item.iconParent }),
        );
      }
      row.append(labelNode(item));
      if (item.hint !== undefined && item.hint !== "") {
        const hint = el("span", "ac-menu__hint", item.hint);
        hint.dir = "auto";
        row.append(hint);
      }
      if (item.note !== undefined && item.note !== "") {
        // Left-aligned, in the space after the name; it takes the room the
        // spacer would, so the tag still ends the row.
        const note = el("span", "ac-menu__note", item.note);
        note.title = item.title ?? item.note;
        row.append(note);
      } else row.append(el("span", "ac-spacer"));
      if (item.tag !== undefined && item.tag !== "") {
        row.append(el("span", "ac-menu__source", item.tag));
      }
      row.addEventListener("mousedown", (event) => event.preventDefault());
      row.addEventListener("mousemove", (event) => {
        // A wheel scroll under a still pointer fires mousemove too: only a
        // pointer that actually moved changes the choice.
        const moved =
          pointer === undefined || pointer.x !== event.clientX || pointer.y !== event.clientY;
        pointer = { x: event.clientX, y: event.clientY };
        if (moved && active !== index) move(index);
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
    touched = false;
    pointer = undefined;
    if (wasOpen) {
      if (options.focusable === true && returnFocus instanceof HTMLElement) returnFocus.focus();
      returnFocus = null;
      options.onClose?.();
    }
  }

  /** Rows that fit the list now (8 where nothing is measured). */
  function pageSize(): number {
    const row = element.querySelector<HTMLElement>(".ac-menu__row");
    const height = row?.offsetHeight ?? 0;
    return height > 0 && element.clientHeight > 0
      ? Math.max(1, Math.floor(element.clientHeight / height) - 1)
      : 8;
  }

  function handleKey(event: KeyboardEvent): boolean {
    if (element.hidden || event.isComposing || event.keyCode === 229) return false;
    switch (event.key) {
      case "ArrowDown":
        touched = true;
        move(active + 1);
        break;
      case "ArrowUp":
        touched = true;
        move(active - 1);
        break;
      case "PageDown":
        touched = true;
        move(Math.min(items.length - 1, active + pageSize()));
        break;
      case "PageUp":
        touched = true;
        move(Math.max(0, active - pageSize()));
        break;
      case "Home":
        touched = true;
        move(0);
        break;
      case "End":
        touched = true;
        move(items.length - 1);
        break;
      case "Enter":
      case "Tab":
        // An empty list takes the key too: a typed "@REA" is not sent by the
        // Enter that meant to pick from it.
        if (items.length === 0) close();
        else choose(active);
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
    setItems(next, reset = false) {
      items = next;
      if (reset) {
        active = 0;
        touched = false;
      }
      active = Math.min(active, Math.max(0, items.length - 1));
      paint();
    },
    moved: () => touched,
    close,
    isOpen: () => !element.hidden,
    setEmpty(text) {
      emptyText = text;
    },
    handleKey,
    activeId: () => (element.hidden || items.length === 0 ? undefined : `${uid}-${active}`),
  };
}
