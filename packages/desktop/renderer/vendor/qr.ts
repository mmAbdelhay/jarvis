// The canvas half of the QR encoder: encodeQr itself lives in
// src/vendor/qr.ts, shared with the jarvisd CLI's terminal rendering
// (src/daemon/cli/qr-blocks.ts). At runtime this module is
// dist/renderer/vendor/qr.js and the encoder dist/src/vendor/qr.js, the same
// relative hop every renderer import of ../src takes.
//
// This file is excluded from biome (renderer/tsconfig's vendor carve-out)
// but is still part of the renderer's tsconfig project and must type-check.
import type { QrCode } from "../../src/vendor/qr.js";

export { encodeQr, type QrCode } from "../../src/vendor/qr.js";

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
