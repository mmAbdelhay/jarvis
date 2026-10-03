// Bug 8 + the phone's Fit toggle. The desktop owns a pane's terminal size
// once it has set one — a phone's plain resize is ignored for it. Fit is
// the one exception: the phone's user asked for the phone's size outright.
// This remembers which panes the desktop sized (and to what), which of
// those a phone has fitted, and gives the desktop its size back when that
// phone restores it, drops off, or the desktop resizes the pane itself.
//
// No I/O but `resize`, which is the pty's own resize.

export type PtySize = { cols: number; rows: number };

export type TerminalFitOverrides = {
  /** The desktop sized this pane: it owns the size again (any Fit ends). */
  desktopResized(paneKey: string, size: PtySize): void;
  isDesktopSized(paneKey: string): boolean;
  /** A phone's Fit resize. False when the desktop never sized the pane
   *  (then it is an ordinary remote resize, and not an override). */
  fit(paneKey: string, deviceId: string, size: PtySize): boolean;
  /** Fit went off: the desktop's size back, if a Fit still holds the pane.
   *  Returns the size the pty has from the desktop's side (undefined for a
   *  pane the desktop never sized) — after a desktop resize during Fit
   *  that is the newer size, and nothing is resized. */
  restore(paneKey: string): PtySize | undefined;
  /** The device's last connection closed: every pane it fitted goes back. */
  deviceDisconnected(deviceId: string): void;
  /** The pane closed. */
  forget(paneKey: string): void;
};

export function createTerminalFitOverrides(deps: {
  resize(paneKey: string, cols: number, rows: number): void;
}): TerminalFitOverrides {
  const desktopSizes = new Map<string, PtySize>();
  // paneKey -> the device whose Fit holds it.
  const fitted = new Map<string, string>();

  function giveBack(paneKey: string): void {
    const size = desktopSizes.get(paneKey);
    fitted.delete(paneKey);
    if (size !== undefined) deps.resize(paneKey, size.cols, size.rows);
  }

  return {
    desktopResized(paneKey, size) {
      desktopSizes.set(paneKey, size);
      fitted.delete(paneKey);
    },
    isDesktopSized: (paneKey) => desktopSizes.has(paneKey),
    fit(paneKey, deviceId, size) {
      if (!desktopSizes.has(paneKey)) return false;
      fitted.set(paneKey, deviceId);
      deps.resize(paneKey, size.cols, size.rows);
      return true;
    },
    restore(paneKey) {
      if (fitted.has(paneKey)) giveBack(paneKey);
      return desktopSizes.get(paneKey);
    },
    deviceDisconnected(deviceId) {
      for (const [paneKey, owner] of [...fitted]) {
        if (owner === deviceId) giveBack(paneKey);
      }
    },
    forget(paneKey) {
      desktopSizes.delete(paneKey);
      fitted.delete(paneKey);
    },
  };
}
