// Minimal PNG reader/writer and the screenshot mask oracle for the computer-use
// GUI tests (v1.1 design §2 criterion 6; contracts §1 `capture`: "only allowed
// windows visible; everything else filled black"). Node built-ins only: it runs
// on the ISO's bundled Node in the KVM test.
import { crc32, deflateSync, inflateSync } from "node:zlib";

export const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }; // grey, RGB, grey+alpha, RGBA

export function readPngInfo(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  if (buffer.toString("latin1", 12, 16) !== "IHDR")
    throw new Error("not a PNG: IHDR is not the first chunk");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    interlace: buffer[28],
  };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buffer) {
  const info = readPngInfo(buffer);
  const channels = CHANNELS[info.colorType];
  if (info.bitDepth !== 8 || channels === undefined || info.interlace !== 0) {
    throw new Error(
      `unsupported PNG: depth ${info.bitDepth}, colour type ${info.colorType}, interlace ${info.interlace}`,
    );
  }
  const idat = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    if (offset + 12 + length > buffer.length) throw new Error(`truncated PNG chunk ${type}`);
    if (type === "IDAT") idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = info;
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("PNG pixel data is short");
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[row + i - channels] : 0;
      const b = y > 0 ? pixels[row - stride + i] : 0;
      const c = i >= channels && y > 0 ? pixels[row - stride + i - channels] : 0;
      const value = raw[line + i];
      let out;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + a;
          break;
        case 2:
          out = value + b;
          break;
        case 3:
          out = value + ((a + b) >> 1);
          break;
        case 4:
          out = value + paeth(a, b, c);
          break;
        default:
          throw new Error(`bad PNG filter ${filter} on row ${y}`);
      }
      pixels[row + i] = out & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

export function rgbAt(image, x, y) {
  const o = (y * image.width + x) * image.channels;
  const p = image.pixels;
  return image.channels >= 3 ? [p[o], p[o + 1], p[o + 2]] : [p[o], p[o], p[o]];
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** RGB PNG, filter 0 on every row. `color(x, y)` returns [r, g, b]. */
export function encodePng(width, height, color) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = color(x, y);
      const o = y * stride + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function rectOf(w) {
  const r = {
    x: Math.round(Number(w?.x)),
    y: Math.round(Number(w?.y)),
    w: Math.round(Number(w?.w)),
    h: Math.round(Number(w?.h)),
  };
  return Object.values(r).every(Number.isFinite) ? r : { x: 0, y: 0, w: 0, h: 0 };
}

const within = (x, y, r, pad) =>
  x >= r.x - pad && x < r.x + r.w + pad && y >= r.y - pad && y < r.y + r.h + pad;

/** Only allowed windows may be visible: every pixel farther than `tolerance`
 *  from all allowed rectangles must be exactly black. `foreignPixels` counts
 *  the checked pixels that lie on a non-allowed window, so a test can prove a
 *  foreign window was actually in view. */
/**
 * Contracts section 4 ruling U-1: `windows` reports the one allowed window as
 * 0,0,capW,capH, so with the real jarvis-cu every pixel is "allowed" and the
 * mask below is vacuous (it can never see a leak). Callers must therefore say
 * what they are checking:
 *  - `expectAllBlack: true` ignores the allowed rectangles: the whole frame must
 *    be black (use it when a foreign window is raised or focused, or the allowed
 *    window is not fullscreen and focused).
 *  - `fullFrameChecked: true` acknowledges that the allowed rectangle covers the
 *    frame and that the caller verifies the content another way (for example
 *    against the known GIMP fixture); otherwise a frame-covering allowed
 *    rectangle is reported as a problem and `vacuous` is true.
 */
export function checkMask(
  image,
  windows,
  { tolerance = 2, maxEdge = 1280, expectAllBlack = false, fullFrameChecked = false } = {},
) {
  const problems = [];
  if (Math.max(image.width, image.height) > maxEdge) {
    problems.push(
      `capture is ${image.width}x${image.height}; the longest edge must be at most ${maxEdge}`,
    );
  }
  const list = Array.isArray(windows) ? windows : [];
  const allowed = list.filter((w) => w?.allowed === true).map(rectOf);
  const foreign = list.filter((w) => w?.allowed !== true).map(rectOf);
  if (allowed.length === 0) problems.push("the capture's window list has no allowed window");
  const vacuous =
    !expectAllBlack &&
    allowed.some(
      (r) =>
        r.x - tolerance <= 0 &&
        r.y - tolerance <= 0 &&
        r.x + r.w + tolerance >= image.width &&
        r.y + r.h + tolerance >= image.height,
    );
  if (vacuous && !fullFrameChecked) {
    problems.push(
      "the allowed window covers the whole frame, so the mask cannot detect a leak; pass expectAllBlack, or fullFrameChecked after comparing the content to the fixture",
    );
  }
  let leaked = 0;
  let foreignPixels = 0;
  let first = null;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (!expectAllBlack && allowed.some((r) => within(x, y, r, tolerance))) continue;
      if (foreign.some((r) => within(x, y, r, 0))) foreignPixels += 1;
      const [r, g, b] = rgbAt(image, x, y);
      if (r !== 0 || g !== 0 || b !== 0) {
        leaked += 1;
        if (first === null) first = { x, y, rgb: [r, g, b] };
      }
    }
  }
  if (first !== null) {
    problems.push(
      `${leaked} pixels outside the allowed windows are not black (first at ${first.x},${first.y} = ${first.rgb.join(",")})`,
    );
  }
  return {
    ok: problems.length === 0,
    problems,
    leakedPixels: leaked,
    foreignPixels,
    vacuous,
    width: image.width,
    height: image.height,
  };
}

/** A point inside a non-allowed window and away from every allowed one: the
 *  target of a click that jarvis-cu must refuse with `outside`. */
export function foreignPoint(windows, { tolerance = 2, step = 8 } = {}) {
  const list = Array.isArray(windows) ? windows : [];
  const allowed = list.filter((w) => w?.allowed === true).map(rectOf);
  for (const r of list.filter((w) => w?.allowed !== true).map(rectOf)) {
    for (let y = r.y + Math.floor(step / 2); y < r.y + r.h; y += step) {
      for (let x = r.x + Math.floor(step / 2); x < r.x + r.w; x += step) {
        if (!allowed.some((a) => within(x, y, a, tolerance))) return { x, y };
      }
    }
  }
  return null;
}
