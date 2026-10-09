import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import {
  SIGNATURE,
  checkMask,
  decodePng,
  encodePng,
  foreignPoint,
  readPngInfo,
  rgbAt,
} from "./png.mjs";

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** A PNG whose rows use the given filter types, so unfiltering is exercised. */
function pngWithFilters(width, rows, filters, { colorType = 2, bitDepth = 8, interlace = 0 } = {}) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const stride = width * channels;
  const lines = [];
  let prev = Buffer.alloc(stride);
  rows.forEach((values, y) => {
    const row = Buffer.from(values);
    const f = filters[y];
    const line = Buffer.alloc(stride + 1);
    line[0] = f;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      line[i + 1] = (row[i] - predictor) & 0xff;
    }
    lines.push(line);
    prev = row;
  });
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(rows.length, 4);
  header[8] = bitDepth;
  header[9] = colorType;
  header[12] = interlace;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(lines))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const ALLOWED = {
  windowId: "g",
  appId: "org.gimp.GIMP",
  title: "GIMP",
  x: 40,
  y: 0,
  w: 60,
  h: 60,
  allowed: true,
};
const TERMINAL = {
  windowId: "t",
  appId: "foot",
  title: "cu-secret-terminal",
  x: 0,
  y: 0,
  w: 30,
  h: 30,
  allowed: false,
};
const inAllowed = (x, y) => x >= 40 && x < 100 && y < 60;
const clean = () =>
  decodePng(encodePng(100, 60, (x, y) => (inAllowed(x, y) ? [180, 180, 180] : [0, 0, 0])));
function withPixel(x0, y0, rgb) {
  return decodePng(
    encodePng(100, 60, (x, y) =>
      x === x0 && y === y0 ? rgb : inAllowed(x, y) ? [180, 180, 180] : [0, 0, 0],
    ),
  );
}

test("encode and decode round-trip RGB", () => {
  const png = encodePng(4, 3, (x, y) => [x * 10, y * 20, 7]);
  assert.deepEqual(readPngInfo(png), {
    width: 4,
    height: 3,
    bitDepth: 8,
    colorType: 2,
    interlace: 0,
  });
  const image = decodePng(png);
  assert.deepEqual(rgbAt(image, 3, 2), [30, 40, 7]);
});

test("decodes all five filter types", () => {
  const rows = [0, 1, 2, 3, 4].map((y) =>
    Array.from({ length: 9 }, (_, i) => (y * 37 + i * 29) % 256),
  );
  const image = decodePng(pngWithFilters(3, rows, [0, 1, 2, 3, 4]));
  assert.deepEqual([...image.pixels], rows.flat());
});

test("decodes RGBA and grey", () => {
  const rgba = decodePng(pngWithFilters(1, [[1, 2, 3, 255]], [0], { colorType: 6 }));
  assert.deepEqual(rgbAt(rgba, 0, 0), [1, 2, 3]);
  const grey = decodePng(pngWithFilters(2, [[9, 4]], [1], { colorType: 0 }));
  assert.deepEqual(rgbAt(grey, 1, 0), [4, 4, 4]);
});

test("rejects what it cannot read instead of guessing", () => {
  assert.throws(
    () => decodePng(Buffer.from("not a png at all, no signature here.....")),
    /not a PNG/,
  );
  assert.throws(
    () => decodePng(pngWithFilters(1, [[0, 0, 0, 0, 0, 0]], [0], { bitDepth: 16 })),
    /unsupported PNG/,
  );
  assert.throws(
    () => decodePng(pngWithFilters(1, [[0, 0, 0]], [0], { interlace: 1 })),
    /unsupported PNG/,
  );
  assert.throws(
    () => decodePng(pngWithFilters(1, [[0]], [0], { colorType: 3 })),
    /unsupported PNG/,
  );
});

test("a capture that shows only the allowed window passes, and the terminal was in view", () => {
  const r = checkMask(clean(), [ALLOWED, TERMINAL]);
  assert.equal(r.ok, true, r.problems.join("; "));
  assert.equal(r.leakedPixels, 0);
  assert.equal(r.foreignPixels, 900);
});

test("one visible pixel of the terminal is a leak", () => {
  const r = checkMask(withPixel(5, 5, [1, 0, 0]), [ALLOWED, TERMINAL]);
  assert.equal(r.ok, false);
  assert.equal(r.leakedPixels, 1);
  assert.match(r.problems.join(), /first at 5,5/);
});

test("the desktop outside every window must be black too", () => {
  assert.equal(checkMask(withPixel(35, 50, [0, 0, 9]), [ALLOWED, TERMINAL]).ok, false);
});

test("a 2-pixel band around allowed windows absorbs scaling blur, no more", () => {
  assert.equal(checkMask(withPixel(38, 10, [90, 90, 90]), [ALLOWED, TERMINAL]).ok, true);
  assert.equal(checkMask(withPixel(37, 10, [90, 90, 90]), [ALLOWED, TERMINAL]).ok, false);
});

test("an over-large capture and a list without allowed windows are problems", () => {
  const big = decodePng(encodePng(1300, 2, () => [0, 0, 0]));
  assert.match(checkMask(big, [{ ...ALLOWED, w: 1300, h: 2 }]).problems.join(), /at most 1280/);
  assert.match(checkMask(clean(), [TERMINAL]).problems.join(), /no allowed window/);
});

test("U-1: an allowed window covering the frame makes the mask vacuous, and says so", () => {
  const full = { ...ALLOWED, x: 0, y: 0, w: 100, h: 60 };
  const img = withPixel(5, 5, [200, 0, 0]);
  const r = checkMask(img, [full]);
  assert.equal(r.vacuous, true);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /cannot detect a leak/);
  assert.equal(checkMask(img, [full], { fullFrameChecked: true }).ok, true);
});

test("expectAllBlack ignores allowed rectangles: any visible pixel is a leak", () => {
  const full = { ...ALLOWED, x: 0, y: 0, w: 100, h: 60 };
  assert.equal(
    checkMask(decodePng(encodePng(100, 60, () => [0, 0, 0])), [full], { expectAllBlack: true }).ok,
    true,
  );
  assert.equal(checkMask(clean(), [full], { expectAllBlack: true }).ok, false);
  const r = checkMask(withPixel(5, 5, [200, 0, 0]), [full], { expectAllBlack: true });
  assert.equal(r.ok, false);
  assert.equal(r.leakedPixels, 1 + 60 * 60);
});

test("foreignPoint finds a spot on the terminal away from GIMP, or nothing", () => {
  const p = foreignPoint([ALLOWED, TERMINAL]);
  assert.ok(p !== null && p.x < 30 && p.y < 30, JSON.stringify(p));
  assert.equal(foreignPoint([ALLOWED, { ...TERMINAL, x: 50, y: 10, w: 10, h: 10 }]), null);
});
