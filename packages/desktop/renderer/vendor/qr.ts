// A small, dependency-free QR Code encoder: byte mode only, error
// correction level M, versions 1 through 10 (the smallest that fits is
// chosen automatically). Vendored rather than pulled in as a dependency
// (M4 ruling 34 / M6 ruling 3): the renderer has no bundler, and
// packages/desktop/renderer/vendor/ already hosts xterm's own prebuilt
// bundle under the same convention.
//
// Implements ISO/IEC 18004: Reed-Solomon error correction over GF(256),
// the standard function patterns (finder, separator, timing, alignment,
// dark module), format information (a BCH(15,5) code) and, for versions
// 7-10, version information (a BCH(18,6) code), then picks whichever of
// the eight mask patterns scores lowest under the standard's four
// penalty rules.
//
// This file is excluded from biome (renderer/tsconfig's vendor carve-out)
// but is still part of the renderer's tsconfig project and must type-check.

export interface QrCode {
  size: number;
  modules: boolean[][];
}

// --- capacity tables (error correction level M only), index = version-1 --

/** Total codewords (data + error correction), per version, 1..10. */
const TOTAL_CODEWORDS: readonly number[] = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
/** Error-correction codewords per block, level M, per version, 1..10. */
const ECC_PER_BLOCK: readonly number[] = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
/** Number of error-correction blocks, level M, per version, 1..10. */
const NUM_BLOCKS: readonly number[] = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** Bits left over after the last codeword once the grid is filled
 *  zig-zag, per version, 1..10 — placed as zero bits, never decoded. */
const REMAINDER_BITS: readonly number[] = [0, 7, 7, 7, 7, 7, 0, 0, 0, 0];
/** Alignment pattern centre coordinates, per version, 2..10 (version 1 has
 *  none). ISO/IEC 18004 Annex E. */
const ALIGNMENT_COORDS: Readonly<Record<number, readonly number[]>> = {
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const MODE_BYTE = 0b0100;
/** ISO/IEC 18004 Table 25 error-correction-level indicator: L=01 M=00 Q=11 H=10. */
const EC_LEVEL_M_BITS = 0b00;

function dataCodewordCount(version: number): number {
  return TOTAL_CODEWORDS[version - 1]! - ECC_PER_BLOCK[version - 1]! * NUM_BLOCKS[version - 1]!;
}

function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= 10; version += 1) {
    const headerBits = 4 + charCountBits(version);
    const capacityBits = dataCodewordCount(version) * 8;
    const maxBytes = Math.floor((capacityBits - headerBits) / 8);
    if (byteLength <= maxBytes) return version;
  }
  throw new Error(`text too long for a version 1-10 QR code at level M (${byteLength} bytes)`);
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

  constructor(private readonly version: number) {
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
    const coords = ALIGNMENT_COORDS[this.version];
    if (coords === undefined) return;
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
    const bits = computeFormatBits(mask);
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
function computeFormatBits(mask: number): number {
  const data = (EC_LEVEL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** BCH(18,6): the 6-bit version number plus 12 error correction bits,
 *  generator 0x1f25 (ISO/IEC 18004 Annex D). Only used for versions 7-10. */
function computeVersionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

export function encodeQr(text: string, level: "M" = "M"): QrCode {
  void level; // the only level this encoder implements; kept for interface parity

  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0xff) {
      throw new Error(`qr byte mode requires ISO-8859-1 text (got U+${code.toString(16)})`);
    }
    bytes.push(code);
  }

  const version = chooseVersion(bytes.length);

  const buffer = new BitBuffer();
  buffer.appendBits(MODE_BYTE, 4);
  buffer.appendBits(bytes.length, charCountBits(version));
  for (const byte of bytes) buffer.appendBits(byte, 8);

  const capacityBits = dataCodewordCount(version) * 8;
  buffer.appendBits(0, Math.min(4, capacityBits - buffer.length));
  while (buffer.length % 8 !== 0) buffer.appendBits(0, 1);
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (buffer.length < capacityBits) {
    buffer.appendBits(padBytes[padIndex % 2]!, 8);
    padIndex += 1;
  }

  const allDataCodewords = buffer.toBytes();

  const numBlocks = NUM_BLOCKS[version - 1]!;
  const eccLen = ECC_PER_BLOCK[version - 1]!;
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
  finalBits.appendBits(0, REMAINDER_BITS[version - 1]!);

  const builder = new QrBuilder(version);
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

  return { size: builder.size, modules: builder.modules };
}

export function qrToCanvas(
  canvas: HTMLCanvasElement,
  qr: QrCode,
  modulePx: number,
  quietZone: number,
): void {
  const totalModules = qr.size + quietZone * 2;
  const pixels = totalModules * modulePx;
  canvas.width = pixels;
  canvas.height = pixels;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, pixels, pixels);
  ctx.fillStyle = "#000000";
  for (let row = 0; row < qr.size; row += 1) {
    for (let col = 0; col < qr.size; col += 1) {
      if (!qr.modules[row]![col]) continue;
      ctx.fillRect((col + quietZone) * modulePx, (row + quietZone) * modulePx, modulePx, modulePx);
    }
  }
}
