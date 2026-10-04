// The terminal screen's "Fit" toggle. A pane the desktop has sized renders
// on the phone at the desktop's cols x rows (bug 8), which a wide desktop
// window makes too small to read. Fit hands the one shared pty the phone's
// own size for as long as it is on, and gives the desktop its size back
// the moment it goes off — the desktop's own view is narrow meanwhile,
// which the screen says. The host keeps its own record too (it gives the
// size back if this phone drops off, and drops a stale restore if the
// desktop resized the pane meanwhile — terminal-fit-overrides.ts).
//
// No timers: `send` is the explicit resize call and answers whether it
// landed; a send that did not is sent again on the connection's next
// `open`. The desktop's size is kept until a restore has landed, so going
// offline never loses it. Nothing is ever sent in answer to a reported pty
// size except the phone's own fit again, so a report cannot start a loop.

export type TerminalSize = { cols: number; rows: number };

/** A resize's outcome. `size` is the host's answer to a restore: the
 *  size the pty has from the desktop's side. */
export type FitSendResult = { ok: boolean; size?: TerminalSize };

export type TerminalFit = {
  isOn(): boolean;
  /** Turns Fit on, remembering `ptySize` as the desktop's size to restore.
   *  False (and still off) when the pty's size is not known yet. */
  enable(ptySize: TerminalSize | undefined): boolean;
  /** The page fitted itself to this size: sent while on, once per change. */
  pageSize(size: TerminalSize): void;
  /** Turns Fit off and sends the desktop's size back. Returns that size
   *  (to render at meanwhile), or undefined when it was not on. */
  disable(): TerminalSize | undefined;
  /** The host reported the pty's size (an attach snapshot). The desktop's
   *  own size means the fit never held (or the host gave it back when
   *  this phone dropped off): it is sent again. Any size but the phone's
   *  means the desktop resized the pane: Fit goes off, restoring nothing,
   *  and this returns true. */
  ptyReported(size: TerminalSize | undefined): boolean;
};

function same(a: TerminalSize | undefined, b: TerminalSize | undefined): boolean {
  return a !== undefined && b !== undefined && a.cols === b.cols && a.rows === b.rows;
}

export function createTerminalFit(deps: {
  send(size: TerminalSize, mode: "fit" | "restore"): Promise<FitSendResult>;
  /** Calls `listener` on the connection's next `open`; returns its unsubscribe. */
  watchOpen(listener: () => void): () => void;
  /** A restore landed: the pty's size now. */
  restored(size: TerminalSize): void;
}): TerminalFit {
  let on = false;
  // The desktop's size: set while on, and kept after until a restore lands.
  let desktop: TerminalSize | undefined;
  let restorePending = false;
  let wanted: TerminalSize | undefined;
  let lastSent: TerminalSize | undefined;
  let fitInFlight = false;
  let restoreInFlight = false;
  let unwatch: (() => void) | undefined;

  function retryOnOpen(): void {
    if (unwatch !== undefined) return;
    unwatch = deps.watchOpen(() => {
      unwatch?.();
      unwatch = undefined;
      if (restorePending) sendRestore();
      else pushFit();
    });
  }

  function pushFit(): void {
    if (!on || fitInFlight || restoreInFlight || wanted === undefined) return;
    if (same(wanted, lastSent)) return;
    const size = wanted;
    fitInFlight = true;
    void deps.send(size, "fit").then((result) => {
      fitInFlight = false;
      if (!result.ok) {
        retryOnOpen();
        return;
      }
      if (on) lastSent = size;
      pushFit();
    });
  }

  function sendRestore(): void {
    if (restoreInFlight || desktop === undefined) return;
    const size = desktop;
    restoreInFlight = true;
    void deps.send(size, "restore").then((result) => {
      restoreInFlight = false;
      if (!result.ok) {
        if (restorePending) retryOnOpen();
        return;
      }
      if (restorePending) {
        restorePending = false;
        desktop = undefined;
        deps.restored(result.size ?? size);
        return;
      }
      // Turned back on while the restore was in flight: fit again.
      lastSent = undefined;
      pushFit();
    });
  }

  function enable(ptySize: TerminalSize | undefined): boolean {
    if (on) return true;
    if (restorePending) {
      restorePending = false;
    } else {
      if (ptySize === undefined) return false;
      desktop = ptySize;
    }
    on = true;
    lastSent = undefined;
    pushFit();
    return true;
  }

  function pageSize(size: TerminalSize): void {
    wanted = size;
    pushFit();
  }

  function disable(): TerminalSize | undefined {
    if (!on) return undefined;
    on = false;
    lastSent = undefined;
    restorePending = true;
    sendRestore();
    return desktop;
  }

  function ptyReported(size: TerminalSize | undefined): boolean {
    if (!on || size === undefined) return false;
    if (same(size, lastSent) || same(size, wanted)) return false;
    if (same(size, desktop)) {
      lastSent = undefined;
      pushFit();
      return false;
    }
    on = false;
    desktop = undefined;
    lastSent = undefined;
    return true;
  }

  return { isOn: () => on, enable, pageSize, disable, ptyReported };
}
