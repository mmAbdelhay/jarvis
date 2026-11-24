// The terminal drawer: for a menu only the terminal can answer, the pane's own
// live xterm is shown as the lower part of the question card. It is not moved
// in the DOM and its pty is not resized (terminal-pane.ts does not refit while
// the chat shows): the stylesheet lays the same element over the card's slot,
// anchored to its bottom rows, and this file only tells it where the slot is.
// Keys typed there go to the agent, Escape included; nothing is ever typed
// for the user.

/** How often an open drawer looks at where the agent's screen ends. */
const FOLLOW_MS = 250;

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

/** What the pane's terminal shows: its row count and the row to keep in view. */
export type LiveScreen = { rows: number; anchor: number };

export function createDrawer(
  host: HTMLElement,
  source: { screen?: () => LiveScreen | undefined } = {},
): Drawer {
  let slot: HTMLElement | undefined;
  let observer: ResizeObserver | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
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
    // The window onto the terminal: the last row with content (or the cursor's)
    // at the slot's bottom; content shorter than the slot stays at the top.
    let shift = 0;
    const screen = source.screen?.();
    const painted = terminal.querySelector(".xterm-screen")?.getBoundingClientRect().height ?? 0;
    if (screen !== undefined && screen.rows > 0 && painted > 0) {
      const needed = ((screen.anchor + 1) * painted) / screen.rows;
      if (needed > at.height) shift = at.height - needed;
    }
    terminal.style.setProperty("--drawer-shift", `${Math.round(shift)}px`);
  }

  function close(): void {
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
    observer?.disconnect();
    observer = undefined;
    slot = undefined;
    delete host.dataset["drawer"];
    const terminal = live();
    for (const name of ["--drawer-x", "--drawer-y", "--drawer-w", "--drawer-h", "--drawer-shift"]) {
      terminal?.style.removeProperty(name);
    }
  }

  return {
    open(next) {
      if (live() === null) return false;
      slot = next;
      host.dataset["drawer"] = "on";
      place();
      // The agent's screen moves as it draws: follow it while the drawer is open.
      if (poll === undefined && source.screen !== undefined) poll = setInterval(place, FOLLOW_MS);
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
