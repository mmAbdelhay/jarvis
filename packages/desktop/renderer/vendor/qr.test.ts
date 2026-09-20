import { describe, expect, it } from "vitest";
import { encodeQr, qrToCanvas, type QrCode } from "./qr.js";
import { PAIRING_LINK_V10_FIXTURE, SHORT_V1_FIXTURE, type QrFixture } from "./qr.fixtures.js";

// This file intentionally re-derives the ISO/IEC 18004 BCH formulas and
// cell positions independently of qr.ts (rather than importing its
// internals or copying its layout helpers), so a bug in either the
// placement code or the bit-computation code shows up as a mismatch here
// — see "the drawn format-info bits read back..." and the fixture-matrix
// tests below. Fix round 1 (task-8-findings-r1.md, Important #2): the
// previous version of `formatBitPosition` here copied the encoder's own
// (then-transposed) row/col convention instead of the standard's, so it
// could not have caught Important #1 (format info and the dark module
// drawn transposed) — this file's coordinates are now written straight
// from ISO/IEC 18004 §7.9 figure 25, and the two fixture matrices below
// come from an independent encoder (ZXing-C++, via the `zxing-wasm`
// package already present transitively in node_modules — not imported
// here or added as a project dependency, per rulings.md; see
// qr.fixtures.ts's own header for how they were generated).

/** BCH(15,5): 5 data bits (2-bit EC level, 0 for level M, + 3-bit mask)
 *  plus 10 error-correction bits, generator 0x537, XORed with the fixed
 *  mask 0x5412 (ISO/IEC 18004 Annex C). */
function referenceFormatBits(mask: number): number {
  const data = mask; // EC level M's indicator bits are 00
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** BCH(18,6): the 6-bit version number plus 12 error-correction bits,
 *  generator 0x1f25 (ISO/IEC 18004 Annex D). */
function referenceVersionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

/** The 15 format-info cell positions of the *second* copy, `(row, col)`,
 *  straight from ISO/IEC 18004 §7.9 figure 25 — NOT derived from qr.ts,
 *  and deliberately the copy near the top-right/bottom-left finders
 *  rather than the one qr.ts's own `drawFormatBits` happens to write
 *  first, so this test cannot pass merely by agreeing with whichever
 *  half of the encoder's own code it was written next to. Bits 0-7 run
 *  along row 8, columns `size-1` down to `size-8`, beside the top-right
 *  finder; bits 8-14 run down column 8, rows `size-7` to `size-1`,
 *  beside the bottom-left finder. */
function formatBitPosition(size: number, i: number): [row: number, col: number] {
  if (i <= 7) return [8, size - 1 - i];
  return [size - 15 + i, 8];
}

function readFormatBits(qr: QrCode): number {
  let value = 0;
  for (let i = 0; i < 15; i += 1) {
    const [row, col] = formatBitPosition(qr.size, i);
    if (qr.modules[row]![col]) value |= 1 << i;
  }
  return value;
}

function readVersionBits(qr: QrCode): number {
  let value = 0;
  for (let i = 0; i < 18; i += 1) {
    const row = qr.size - 11 + (i % 3);
    const col = Math.floor(i / 3);
    if (qr.modules[row]![col]) value |= 1 << i;
  }
  return value;
}

function expectFinderAt(qr: QrCode, topRow: number, topCol: number): void {
  for (let dr = 0; dr < 7; dr += 1) {
    for (let dc = 0; dc < 7; dc += 1) {
      const border = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      expect(qr.modules[topRow + dr]![topCol + dc]).toBe(border || core);
    }
  }
}

function rowsOf(qr: QrCode): string[] {
  return qr.modules.map((row) => row.map((m) => (m ? "#" : ".")).join(""));
}

describe("encodeQr — version selection by capacity (level M)", () => {
  it.each([
    [1, 1],
    [14, 1],
    [15, 2],
    [100, 6],
    [213, 10],
  ])("a %i-byte link selects version %i", (byteLength, expectedVersion) => {
    const qr = encodeQr("A".repeat(byteLength));
    expect(qr.size).toBe(17 + 4 * expectedVersion);
  });

  it("throws for 214 bytes — one past version 10-M's capacity", () => {
    expect(() => encodeQr("A".repeat(214))).toThrow();
  });
});

describe("encodeQr — matrix shape", () => {
  it.each([
    [1, 10],
    [5, 70],
    [10, 200],
  ])("version %i is a 17+4·version square (%i-byte input)", (version, byteLength) => {
    const qr = encodeQr("A".repeat(byteLength));
    expect(qr.size).toBe(17 + 4 * version);
    expect(qr.modules.length).toBe(qr.size);
    for (const row of qr.modules) expect(row.length).toBe(qr.size);
  });
});

describe("encodeQr — finder patterns", () => {
  it("places the three finder patterns at the corners for version 1 (size 21)", () => {
    const qr = encodeQr("A".repeat(10));
    expect(qr.size).toBe(21);
    expectFinderAt(qr, 0, 0);
    expectFinderAt(qr, 0, 14);
    expectFinderAt(qr, 14, 0);
  });

  it("places the three finder patterns at the corners for version 5 (size 37)", () => {
    const qr = encodeQr("A".repeat(70));
    expect(qr.size).toBe(37);
    expectFinderAt(qr, 0, 0);
    expectFinderAt(qr, 0, 30);
    expectFinderAt(qr, 30, 0);
  });

  it("places the three finder patterns at the corners for version 10 (size 57)", () => {
    const qr = encodeQr("A".repeat(200));
    expect(qr.size).toBe(57);
    expectFinderAt(qr, 0, 0);
    expectFinderAt(qr, 0, 50);
    expectFinderAt(qr, 50, 0);
  });
});

describe("encodeQr — timing patterns", () => {
  it.each([
    [1, 10],
    [5, 70],
    [10, 200],
  ])("version %i's row-6/column-6 timing patterns alternate starting dark", (_version, byteLength) => {
    const qr = encodeQr("A".repeat(byteLength));
    for (let i = 8; i < qr.size - 8; i += 1) {
      expect(qr.modules[6]![i]).toBe(i % 2 === 0);
      expect(qr.modules[i]![6]).toBe(i % 2 === 0);
    }
  });
});

describe("encodeQr — format and version information", () => {
  it("computes the ISO worked example's level-M mask-0 format bits (101010000010010)", () => {
    // ISO/IEC 18004's own "HELLO WORLD" 1-M worked example settles on mask
    // 0; this is that example's format-info value, independent of mode.
    expect(referenceFormatBits(0)).toBe(0b101010000010010);
  });

  it("the drawn format-info bits read back equal the chosen mask's standard BCH sequence", () => {
    const qr = encodeQr("jarvis://192.168.1.5:7717/pair#s=abcdef0123456789");
    const bits = readFormatBits(qr);
    // No channel noise: the format code is systematic, so the top 5 bits of
    // (bits XOR the fixed mask) are exactly the data bits (2-bit EC level +
    // 3-bit mask) that were encoded.
    const data5 = (bits ^ 0x5412) >>> 10;
    expect(data5 >>> 3).toBe(0); // EC level M
    const mask = data5 & 0b111;
    expect(bits).toBe(referenceFormatBits(mask));
  });

  it("the always-dark module (row size-8, col 8) is dark", () => {
    for (const byteLength of [10, 70, 200]) {
      const qr = encodeQr("A".repeat(byteLength));
      expect(qr.modules[qr.size - 8]![8]).toBe(true);
    }
  });

  it("draws version information for version 10 matching the standard BCH(18,6) code", () => {
    const qr = encodeQr("A".repeat(200));
    expect(qr.size).toBe(57);
    expect(readVersionBits(qr)).toBe(referenceVersionBits(10));
  });
});

// Fixture matrices from an independent encoder (see qr.fixtures.ts) —
// these are the tests fix round 1's Important #2 asked for: a bit-exact
// comparison that does not share any layout code with qr.ts, so a
// transposed-format-info bug (Important #1) or any other structural
// mistake fails here even if every other test in this file happens not
// to notice.
describe("encodeQr — matches an independent encoder bit-for-bit", () => {
  it.each<[string, QrFixture]>([
    ["a 10-byte input at version 1", SHORT_V1_FIXTURE],
    ["a 208-byte pairing-link-shaped input at version 10", PAIRING_LINK_V10_FIXTURE],
  ])("%s", (_label, fixture) => {
    const qr = encodeQr(fixture.text);
    expect(qr.size).toBe(17 + 4 * fixture.version);
    expect(rowsOf(qr)).toEqual([...fixture.rows]);
  });
});

describe("qrToCanvas", () => {
  function fakeCanvas(): { canvas: HTMLCanvasElement; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const ctx = {
      fillStyle: "",
      fillRect: (...args: unknown[]) => {
        calls.push(args);
      },
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;
    return { canvas, calls };
  }

  it("sizes the canvas to (size + 2*quietZone) * modulePx and draws at least one module", () => {
    const qr = encodeQr("A".repeat(10));
    const { canvas, calls } = fakeCanvas();
    qrToCanvas(canvas, qr, 3, 4);
    const totalModules = qr.size + 4 * 2;
    expect(canvas.width).toBe(totalModules * 3);
    expect(canvas.height).toBe(totalModules * 3);
    // A quiet-zone background fill plus at least one dark-module fill (the
    // finder patterns guarantee dark modules exist).
    expect(calls.length).toBeGreaterThan(1);
  });
});
