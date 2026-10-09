// Pure helpers for the local vision-model probe (v1.1 contracts §3): a
// synthetic 1280x800 "screenshot" with one red button, and the grader for the
// model's click. No network; vision-probe.test.ts makes the Ollama calls.
import { crc32, deflateSync } from "node:zlib";

export type Target = { x: number; y: number; w: number; h: number };
export type Click = { x: number; y: number };

export const PROBE_WIDTH = 1280;
export const PROBE_HEIGHT = 800;
/** Three positions, none at the centre, so a model that always answers the
 *  middle of the screen (or 500,500 on a 0-1000 grid) cannot pass. */
export const PROBE_TARGETS: readonly Target[] = [
  { x: 140, y: 120, w: 160, h: 60 },
  { x: 940, y: 600, w: 160, h: 60 },
  { x: 980, y: 140, w: 160, h: 60 },
];
/** Pixels of slack around the button: a usable click lands on it. */
export const TOLERANCE = 16;

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

function inside(x: number, y: number, t: Target): boolean {
  return x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h;
}

/** RGB PNG: light window background, a dark title bar, the red button. */
export function targetPng(target: Target, width = PROBE_WIDTH, height = PROBE_HEIGHT): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = inside(x, y, target) ? [220, 30, 30] : y < 40 ? [50, 50, 56] : [236, 236, 236];
      const o = y * stride + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type RGB
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function numeric(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

export function readClick(input: unknown): Click | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const x = numeric(record["x"]);
  const y = numeric(record["y"]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export function hits(click: Click | null, t: Target, tol = TOLERANCE): boolean {
  return (
    click !== null &&
    click.x >= t.x - tol &&
    click.x <= t.x + t.w + tol &&
    click.y >= t.y - tol &&
    click.y <= t.y + t.h + tol
  );
}

export function verdict(results: readonly boolean[]): "passed" | "failed" {
  return results.filter(Boolean).length >= 2 ? "passed" : "failed";
}
