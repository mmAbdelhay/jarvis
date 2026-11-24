// The terminal drawer: for a menu only the terminal can answer, the pane's own
// live xterm is shown as the lower part of the question card. It is not moved
// in the DOM and its pty is not resized (terminal-pane.ts does not refit while
// the chat shows): the stylesheet lays the same element over the card's slot,
// anchored to its bottom rows, and this file only tells it where the slot is.
// Keys typed there go to the agent, Escape included; nothing is ever typed
// for the user.

export type Drawer = {
  /** Shows the terminal over `slot`; false when this pane has no live terminal. */
  open(slot: HTMLElement): boolean;
  /** Follows the slot after the layout changed. */
  place(): void;
  close(): void;
  isOpen(): boolean;
  /** Gives the keys to the terminal. */
  focusTerm(): void;
  /** Whether the keys are in the terminal now. */
  hasFocus(): boolean;
  /** Whether this pane has a live terminal to show. */
  available(): boolean;
};

export function createDrawer(host: HTMLElement): Drawer {
  let slot: HTMLElement | undefined;
  let observer: ResizeObserver | undefined;
  const live = (): HTMLElement | null => host.querySelector<HTMLElement>(":scope > .terminal-live");

  function place(): void {
    const terminal = live();
    if (terminal === null || slot === undefined) return;
    const box = host.getBoundingClientRect();
    const at = slot.getBoundingClientRect();
    terminal.style.setProperty("--drawer-x", `${at.left - box.left}px`);
    terminal.style.setProperty("--drawer-y", `${at.top - box.top}px`);
    terminal.style.setProperty("--drawer-w", `${at.width}px`);
    terminal.style.setProperty("--drawer-h", `${at.height}px`);
  }

  function close(): void {
    observer?.disconnect();
    observer = undefined;
    slot = undefined;
    delete host.dataset["drawer"];
    const terminal = live();
    for (const name of ["--drawer-x", "--drawer-y", "--drawer-w", "--drawer-h"]) {
      terminal?.style.removeProperty(name);
    }
  }

  return {
    open(next) {
      if (live() === null) return false;
      slot = next;
      host.dataset["drawer"] = "on";
      place();
      if (typeof ResizeObserver !== "undefined" && observer === undefined) {
        observer = new ResizeObserver(() => place());
        observer.observe(host);
        observer.observe(next);
      }
      return true;
    },
    place,
    close,
    isOpen: () => host.dataset["drawer"] === "on",
    available: () => live() !== null,
    focusTerm() {
      host.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus();
    },
    hasFocus() {
      const active = document.activeElement;
      return active instanceof HTMLElement && live()?.contains(active) === true;
    },
  };
}
