// The terminal screen's "Fit" toggle. A pane the desktop has sized renders
// on the phone at the desktop's cols x rows (bug 8), which a wide desktop
// window makes too small to read. Fit hands the one shared pty the phone's
// own size for as long as it is on, and gives the desktop its size back
// the moment it goes off — the desktop's own view is narrow meanwhile,
// which the screen says.
//
// No timers and no I/O: `send` is the screen's explicit resize call, and
// every decision about when to call it is here. It never sends anything in
// answer to a reported pty size, so a size report can never start a loop.

export type TerminalSize = { cols: number; rows: number };

export type TerminalFit = {
  isOn(): boolean;
  /** Turns Fit on, remembering `ptySize` as the desktop's size to restore.
   *  False (and still off) when the pty's size is not known yet. */
  enable(ptySize: TerminalSize | undefined): boolean;
  /** The page fitted itself to this size: sent while on, once per change. */
  pageSize(size: TerminalSize): void;
  /** Turns Fit off and sends the desktop's size back. Returns that size
   *  (the pty's size from now on), or undefined when it was not on. */
  disable(): TerminalSize | undefined;
  /** The host reported the pty's size (an attach snapshot). A size that is
   *  neither the phone's last one nor the desktop's means the desktop
   *  resized the pane meanwhile: Fit goes off without restoring anything,
   *  and this returns true. */
  ptyReported(size: TerminalSize | undefined): boolean;
};

function same(a: TerminalSize | undefined, b: TerminalSize | undefined): boolean {
  return a !== undefined && b !== undefined && a.cols === b.cols && a.rows === b.rows;
}

export function createTerminalFit(deps: { send(size: TerminalSize): void }): TerminalFit {
  let desktop: TerminalSize | undefined;
  let lastSent: TerminalSize | undefined;

  function enable(ptySize: TerminalSize | undefined): boolean {
    if (ptySize === undefined) return false;
    if (desktop === undefined) desktop = ptySize;
    return true;
  }

  function pageSize(size: TerminalSize): void {
    if (desktop === undefined || same(size, lastSent)) return;
    lastSent = size;
    deps.send(size);
  }

  function disable(): TerminalSize | undefined {
    const restore = desktop;
    desktop = undefined;
    lastSent = undefined;
    if (restore !== undefined) deps.send(restore);
    return restore;
  }

  function ptyReported(size: TerminalSize | undefined): boolean {
    if (desktop === undefined || size === undefined) return false;
    if (same(size, desktop) || same(size, lastSent)) return false;
    desktop = undefined;
    lastSent = undefined;
    return true;
  }

  return { isOn: () => desktop !== undefined, enable, pageSize, disable, ptyReported };
}
