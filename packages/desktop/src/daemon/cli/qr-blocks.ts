// A QR code drawn in a terminal: two module rows per text row, using the
// upper/lower half-block characters. The colours are set explicitly (black
// on bright white) rather than left to the terminal's theme, so the code
// reads the same on a dark background as on a light one — a QR scanner
// needs dark modules on a light field, never the inverse.
//
// The matrix comes from the shared encoder (src/vendor/qr.ts, encodeQr),
// the same one Settings draws on a canvas.
//
// No electron here (core/no-electron.test.ts).

export type QrMatrix = { size: number; modules: readonly (readonly boolean[])[] };

/** Light modules around the code. The standard asks for 4; 2 keeps a
 *  version-10 code at 61 columns and still scans, since the colours around
 *  it are forced light too. */
export const TERMINAL_QR_QUIET_ZONE = 2;

const START = "\u001b[30;107m";
const RESET = "\u001b[0m";

/** The lines to print, top to bottom, each one ANSI-coloured and reset. */
export function qrToBlocks(qr: QrMatrix, quietZone: number = TERMINAL_QR_QUIET_ZONE): string[] {
  const dark = (row: number, col: number): boolean => qr.modules[row]?.[col] === true;
  const lines: string[] = [];
  for (let top = -quietZone; top < qr.size + quietZone; top += 2) {
    let line = "";
    for (let col = -quietZone; col < qr.size + quietZone; col += 1) {
      const upper = dark(top, col);
      const lower = dark(top + 1, col);
      line += upper ? (lower ? "█" : "▀") : lower ? "▄" : " ";
    }
    lines.push(`${START}${line}${RESET}`);
  }
  return lines;
}
