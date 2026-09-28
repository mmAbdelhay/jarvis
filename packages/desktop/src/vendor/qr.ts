// A small, dependency-free QR Code encoder: byte mode only, versions 1
// through 20 at error correction level M, falling back to level L when a
// text is too long for 20-M (the smallest that fits is chosen
// automatically). Vendored rather than pulled in as a dependency
// (M4 ruling 34 / M6 ruling 3): the renderer has no bundler, and
// packages/desktop/renderer/vendor/ already hosts xterm's own prebuilt
// bundle under the same convention.
//
// Implements ISO/IEC 18004: Reed-Solomon error correction over GF(256),
// the standard function patterns (finder, separator, timing, alignment,
// dark module), format information (a BCH(15,5) code) and, for versions
// 7 and up, version information (a BCH(18,6) code), then picks whichever of
// the eight mask patterns scores lowest under the standard's four
// penalty rules.
//
// This file is excluded from biome (the vendor carve-out, like
// renderer/vendor) but is part of the main tsconfig project and must
// type-check. It lives under src/ so both the renderer (through
// renderer/vendor/qr.ts, which adds the canvas drawing) and the jarvisd CLI
// (daemon/cli/qr-blocks.ts, terminal half-blocks) share one encoder; the
// main project's rootDir is src/, so it cannot reach into renderer/.

export interface QrCode {
  size: number;
  modules: boolean[][];
  /** The error-correction level used: M, or L past version 20-M. */
  level: QrErrorLevel;
}

// --- capacity tables, index = version-1 ------------------------------------

/** The highest version this encoder builds. A 20-M code holds 666 bytes,
 *  far past any pairing link; 20-L holds 858. */
const MAX_VERSION = 20;

export type QrErrorLevel = "L" | "M";

/** Error-correction codewords per block, per version, 1..20 (ISO/IEC 18004
 *  Table 9). */
const ECC_PER_BLOCK: Readonly<Record<QrErrorLevel, readonly number[]>> = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26],
};
/** Number of error-correction blocks, per version, 1..20 (Table 9). */
const NUM_BLOCKS: Readonly<Record<QrErrorLevel, readonly number[]>> = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16],
};

/** Modules left for data and error correction once every function pattern
 *  is drawn (finders, timing, alignment, format and version information). */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignCount = Math.floor(version / 7) + 2;
    result -= (25 * alignCount - 10) * alignCount - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Total codewords (data + error correction). The rest of the raw modules
 *  (0 or 7 bits, or 3/4 for the larger versions) are remainder bits,
 *  placed as zeros and never decoded. */
function totalCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8);
}

function remainderBits(version: number): number {
  return rawDataModules(version) % 8;
}

/** Alignment pattern centre coordinates (ISO/IEC 18004 Annex E): none for
 *  version 1, otherwise 6 plus evenly spaced positions ending 7 in from the
 *  far edge. */
function alignmentCoords(version: number): readonly number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = 17 + 4 * version;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const coords = [6];
  for (let position = size - 7; coords.length < count; position -= step) {
    coords.splice(1, 0, position);
  }
  return coords;
}

const MODE_BYTE = 0b0100;
/** ISO/IEC 18004 Table 25 error-correction-level indicator: L=01 M=00 Q=11 H=10. */
const EC_LEVEL_BITS: Readonly<Record<QrErrorLevel, number>> = { L: 0b01, M: 0b00 };

function dataCodewordCount(version: number, level: QrErrorLevel): number {
  return totalCodewords(version) - ECC_PER_BLOCK[level][version - 1]! * NUM_BLOCKS[level][version - 1]!;
}

function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function fitsIn(byteLength: number, version: number, level: QrErrorLevel): boolean {
  const headerBits = 4 + charCountBits(version);
  const capacityBits = dataCodewordCount(version, level) * 8;
  return byteLength <= Math.floor((capacityBits - headerBits) / 8);
}

/** The smallest version that holds the text at level M; past version 20-M,
 *  the smallest at level L (less error correction beats no code at all). */
function chooseVersion(byteLength: number): { version: number; level: QrErrorLevel } {
  for (const level of ["M", "L"] as const) {
    for (let version = 1; version <= MAX_VERSION; version += 1) {
      if (fitsIn(byteLength, version, level)) return { version, level };
    }
  }
  throw new Error(`text too long for a version 1-${MAX_VERSION} QR code (${byteLength} bytes)`);
}

// --- a plain bit buffer, MSB-first -----------------------------------------

class BitBuffer {
  private readonly bits: number[] = [];

  get length(): number {
    return this.bits.length;
  }

  appendBits(value: number, bitCount: number): void {
    for (let i = bitCount - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }

  toBytes(): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      bytes.push(byte);
    }
    return bytes;
  }

  toBitArray(): readonly number[] {
    return this.bits;
  }
}

// --- Reed-Solomon over GF(256), primitive polynomial x^8+x^4+x^3+x^2+1 ----

function gfMultiply(a: number, b: number): number {
  let product = 0;
  let x = a;
  let y = b;
  for (let i = 0; i < 8; i += 1) {
    product ^= (y & 1) !== 0 ? x : 0;
    const carry = (x & 0x80) !== 0;
    x = (x << 1) & 0xff;
    if (carry) x ^= 0x1d;
    y >>>= 1;
  }
  return product;
}

/** The generator polynomial for `degree` error-correction codewords,
 *  coefficients highest-degree first, as the product (x-r^0)(x-r^1)...(x-r^{d-1})
 *  over GF(256) with generator element r = 0x02, leading term dropped
 *  (it is always 1·x^degree). */
function reedSolomonDivisor(degree: number): number[] {
  const result: number[] = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = new Array(divisor.length).fill(0);
  for (const dataByte of data) {
    const factor = dataByte ^ result[0]!;
    result.shift();
    result.push(0);
    for (let i = 0; i < result.length; i += 1) result[i] = result[i]! ^ gfMultiply(divisor[i]!, factor);
  }
  return result;
}

// --- module-grid construction -----------------------------------------------

const MASK_FUNCTIONS: ReadonlyArray<(row: number, col: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r, _c) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

class QrBuilder {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly isFunction: boolean[][];

  constructor(
    private readonly version: number,
    private readonly level: QrErrorLevel,
  ) {
    this.size = 17 + 4 * version;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private setFunction(row: number, col: number, dark: boolean): void {
    this.modules[row]![col] = dark;
    this.isFunction[row]![col] = true;
  }

  drawFunctionPatterns(): void {
    this.drawFinder(0, 0);
    this.drawFinder(0, this.size - 7);
    this.drawFinder(this.size - 7, 0);
    for (let i = 8; i < this.size - 8; i += 1) {
      const dark = i % 2 === 0;
      this.setFunction(6, i, dark);
      this.setFunction(i, 6, dark);
    }
    this.drawAlignmentPatterns();
    this.reserveFormatArea();
    this.setFunction(this.size - 8, 8, true); // the always-dark module
    this.drawVersionInfo();
  }

  private drawFinder(topRow: number, topCol: number): void {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = topRow + dr;
        const c = topCol + dc;
        if (r < 0 || r >= this.size || c < 0 || c >= this.size) continue;
        const inCore = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const border = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        this.setFunction(r, c, inCore && (border || core));
      }
    }
  }

  private drawAlignmentPatterns(): void {
    const coords = alignmentCoords(this.version);
    if (coords.length === 0) return;
    const first = coords[0]!;
    const last = coords[coords.length - 1]!;
    for (const r of coords) {
      for (const c of coords) {
        const overlapsFinder =
          (r === first && c === first) || (r === first && c === last) || (r === last && c === first);
        if (overlapsFinder) continue;
        for (let dr = -2; dr <= 2; dr += 1) {
          for (let dc = -2; dc <= 2; dc += 1) {
            const dist = Math.max(Math.abs(dr), Math.abs(dc));
            this.setFunction(r + dr, c + dc, dist !== 1);
          }
        }
      }
    }
  }

  private reserveFormatArea(): void {
    for (let i = 0; i <= 8; i += 1) {
      if (i !== 6) this.setFunction(8, i, false);
      if (i !== 6) this.setFunction(i, 8, false);
    }
    for (let i = 0; i < 8; i += 1) {
      this.setFunction(8, this.size - 1 - i, false);
    }
    for (let i = 8; i < 15; i += 1) {
      this.setFunction(this.size - 15 + i, 8, false);
    }
  }

  private drawVersionInfo(): void {
    if (this.version < 7) return;
    const bits = computeVersionBits(this.version);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, bit);
      this.setFunction(b, a, bit);
    }
  }

  placeData(bits: readonly number[]): void {
    let bitIndex = 0;
    let upward = true;
    for (let col = this.size - 1; col >= 1; col -= 2) {
      if (col === 6) col -= 1;
      for (let vert = 0; vert < this.size; vert += 1) {
        const row = upward ? this.size - 1 - vert : vert;
        for (const c of [col, col - 1]) {
          if (this.isFunction[row]![c]) continue;
          this.modules[row]![c] = bitIndex < bits.length && bits[bitIndex] === 1;
          bitIndex += 1;
        }
      }
      upward = !upward;
    }
  }

  applyMask(maskIndex: number): void {
    const fn = MASK_FUNCTIONS[maskIndex]!;
    for (let row = 0; row < this.size; row += 1) {
      for (let col = 0; col < this.size; col += 1) {
        if (this.isFunction[row]![col]) continue;
        if (fn(row, col)) this.modules[row]![col] = !this.modules[row]![col];
      }
    }
  }

  drawFormatBits(mask: number): void {
    const bits = computeFormatBits(this.level, mask);
    const getBit = (i: number): boolean => ((bits >>> i) & 1) === 1;
    // ISO/IEC 18004 §7.9 / figure 25: the first copy runs down column 8
    // beside the top-left finder (bits 0-5 at rows 0-5), then around the
    // corner along row 8; the second copy runs along row 8 near the
    // top-right finder (bits 0-7) and down column 8 near the bottom-left
    // finder (bits 8-14). Cell coordinates below are (row, col).
    for (let i = 0; i <= 5; i += 1) this.setFunction(i, 8, getBit(i));
    this.setFunction(7, 8, getBit(6));
    this.setFunction(8, 8, getBit(7));
    this.setFunction(8, 7, getBit(8));
    for (let i = 9; i < 15; i += 1) this.setFunction(8, 14 - i, getBit(i));
    for (let i = 0; i < 8; i += 1) this.setFunction(8, this.size - 1 - i, getBit(i));
    for (let i = 8; i < 15; i += 1) this.setFunction(this.size - 15 + i, 8, getBit(i));
    this.setFunction(this.size - 8, 8, true); // the always-dark module, redrawn
  }

  penalty(): number {
    let total = 0;
    for (let row = 0; row < this.size; row += 1) {
      const line: boolean[] = [];
      for (let col = 0; col < this.size; col += 1) line.push(this.modules[row]![col]!);
      total += runPenalty(line) + finderPenalty(line);
    }
    for (let col = 0; col < this.size; col += 1) {
      const line: boolean[] = [];
      for (let row = 0; row < this.size; row += 1) line.push(this.modules[row]![col]!);
      total += runPenalty(line) + finderPenalty(line);
    }
    for (let row = 0; row < this.size - 1; row += 1) {
      for (let col = 0; col < this.size - 1; col += 1) {
        const v = this.modules[row]![col];
        if (
          v === this.modules[row]![col + 1] &&
          v === this.modules[row + 1]![col] &&
          v === this.modules[row + 1]![col + 1]
        ) {
          total += 3;
        }
      }
    }
    let dark = 0;
    for (const row of this.modules) for (const m of row) if (m) dark += 1;
    // ISO/IEC 18004 §7.8.3.1 rule 4: the penalty is 10 times the smaller of
    // the two distances (in units of 5 percentage points) from the actual
    // dark-module percentage to the two nearest multiples of five — not a
    // single floor(|pct-50|/5), which wrongly scores the 45-55% band's own
    // edges (e.g. exactly 45.0%) as non-zero.
    const percent = (dark * 100) / (this.size * this.size);
    const prevMultipleOf5 = Math.floor(percent / 5) * 5;
    const nextMultipleOf5 = prevMultipleOf5 + 5;
    const a = Math.abs(prevMultipleOf5 - 50) / 5;
    const b = Math.abs(nextMultipleOf5 - 50) / 5;
    total += Math.min(a, b) * 10;
    return total;
  }
}

function runPenalty(line: readonly boolean[]): number {
  let penalty = 0;
  let runColor = line[0]!;
  let runLen = 1;
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === runColor) {
      runLen += 1;
      continue;
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
    runColor = line[i]!;
    runLen = 1;
  }
  if (runLen >= 5) penalty += 3 + (runLen - 5);
  return penalty;
}

const FINDER_CORE = [true, false, true, true, true, false, true];

function finderPenalty(line: readonly boolean[]): number {
  const isLightAt = (idx: number): boolean => idx < 0 || idx >= line.length || line[idx] === false;
  let penalty = 0;
  for (let i = 0; i + 6 < line.length; i += 1) {
    let matches = true;
    for (let k = 0; k < 7; k += 1) {
      if (line[i + k] !== FINDER_CORE[k]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    let leftLight = true;
    for (let k = 1; k <= 4; k += 1) {
      if (!isLightAt(i - k)) {
        leftLight = false;
        break;
      }
    }
    let rightLight = true;
    for (let k = 0; k < 4; k += 1) {
      if (!isLightAt(i + 7 + k)) {
        rightLight = false;
        break;
      }
    }
    if (leftLight || rightLight) penalty += 40;
  }
  return penalty;
}

/** BCH(15,5): 5 data bits (2-bit EC level + 3-bit mask) plus 10 error
 *  correction bits, generator 0x537, XORed with the fixed mask 0x5412
 *  (ISO/IEC 18004 Annex C). */
function computeFormatBits(level: QrErrorLevel, mask: number): number {
  const data = (EC_LEVEL_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** BCH(18,6): the 6-bit version number plus 12 error correction bits,
 *  generator 0x1f25 (ISO/IEC 18004 Annex D). Only used for versions 7 and up. */
function computeVersionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

export function encodeQr(text: string): QrCode {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0xff) {
      throw new Error(`qr byte mode requires ISO-8859-1 text (got U+${code.toString(16)})`);
    }
    bytes.push(code);
  }

  const { version, level } = chooseVersion(bytes.length);

  const buffer = new BitBuffer();
  buffer.appendBits(MODE_BYTE, 4);
  buffer.appendBits(bytes.length, charCountBits(version));
  for (const byte of bytes) buffer.appendBits(byte, 8);

  const capacityBits = dataCodewordCount(version, level) * 8;
  buffer.appendBits(0, Math.min(4, capacityBits - buffer.length));
  while (buffer.length % 8 !== 0) buffer.appendBits(0, 1);
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (buffer.length < capacityBits) {
    buffer.appendBits(padBytes[padIndex % 2]!, 8);
    padIndex += 1;
  }

  const allDataCodewords = buffer.toBytes();

  const numBlocks = NUM_BLOCKS[level][version - 1]!;
  const eccLen = ECC_PER_BLOCK[level][version - 1]!;
  const shortLen = Math.floor(allDataCodewords.length / numBlocks);
  const numLongBlocks = allDataCodewords.length % numBlocks;

  const dataBlocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i += 1) {
    const len = shortLen + (i >= numBlocks - numLongBlocks ? 1 : 0);
    dataBlocks.push(allDataCodewords.slice(offset, offset + len));
    offset += len;
  }

  const divisor = reedSolomonDivisor(eccLen);
  const eccBlocks = dataBlocks.map((block) => reedSolomonRemainder(block, divisor));

  const interleavedData: number[] = [];
  const maxDataLen = shortLen + (numLongBlocks > 0 ? 1 : 0);
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const block of dataBlocks) if (i < block.length) interleavedData.push(block[i]!);
  }
  const interleavedEcc: number[] = [];
  for (let i = 0; i < eccLen; i += 1) {
    for (const block of eccBlocks) interleavedEcc.push(block[i]!);
  }

  const finalBits = new BitBuffer();
  for (const byte of [...interleavedData, ...interleavedEcc]) finalBits.appendBits(byte, 8);
  finalBits.appendBits(0, remainderBits(version));

  const builder = new QrBuilder(version, level);
  builder.drawFunctionPatterns();
  builder.placeData(finalBits.toBitArray());

  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    builder.applyMask(mask);
    builder.drawFormatBits(mask);
    const penalty = builder.penalty();
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    builder.applyMask(mask); // undo — XOR is its own inverse
  }
  builder.applyMask(bestMask);
  builder.drawFormatBits(bestMask);

  return { size: builder.size, modules: builder.modules, level };
}
