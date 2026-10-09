// Rafiq v1.1 contracts §1, jarvisd's side: what jarvis-cu is asked and what
// its answers may contain. The socket client (desktop cu-client.ts) speaks
// NDJSON; these parsers check every field it hands over. Pure.
import { CU_PAUSE_REASONS, type CuPauseReason } from "./contract.js";
import type { CuButton } from "./screen-tools.js";
import { isRecord } from "./types.js";

export type CuWindow = {
  windowId: string;
  appId: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  focused: boolean;
  allowed: boolean;
};
export type CuCapture = {
  pngBase64: string;
  width: number;
  height: number;
  scale: number;
  windows: CuWindow[];
};

export const CU_ERROR_CODES = [
  "outside",
  "excluded",
  "paused",
  "no-session",
  "unsupported",
  "failed",
] as const;
export type CuErrorCode = (typeof CU_ERROR_CODES)[number];

export class CuClientError extends Error {
  constructor(
    readonly code: CuErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CuClientError";
  }
}

export type CuApp = { appId: string; name: string };
export type CuDescription = { role: string; name?: string };

export interface CuClient {
  apps(): Promise<CuApp[]>;
  describeAt(x: number, y: number): Promise<CuDescription>;
  begin(sessionId: string, appIds: readonly string[]): Promise<void>;
  windows(): Promise<CuWindow[]>;
  capture(maxEdge: number): Promise<CuCapture>;
  click(x: number, y: number, button: CuButton, double: boolean): Promise<void>;
  type(text: string): Promise<void>;
  key(combo: string): Promise<void>;
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>;
  drag(x1: number, y1: number, x2: number, y2: number): Promise<void>;
  end(): Promise<void>;
  onPaused(listener: (reason: CuPauseReason) => void): () => void;
  /** The helper went away (socket closed). */
  onGone(listener: () => void): () => void;
}

/** A 1280-px PNG is a few MB; anything near this is not a screenshot. */
export const CU_MAX_PNG_BASE64_CHARS = 16 * 1024 * 1024;
/** base64 of the PNG signature 89 50 4E 47 0D 0A 1A 0A. */
export const PNG_BASE64_PREFIX = "iVBORw0KGgo";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_WINDOWS = 64;
const MAX_EDGE = 4_096;

export function parseCuErrorCode(value: unknown): CuErrorCode {
  return typeof value === "string" && (CU_ERROR_CODES as readonly string[]).includes(value)
    ? (value as CuErrorCode)
    : "failed";
}

export function isCuPauseReason(value: unknown): value is CuPauseReason {
  return typeof value === "string" && (CU_PAUSE_REASONS as readonly string[]).includes(value);
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function parseWindow(raw: unknown): CuWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const { windowId, appId, title, x, y, w, h, focused, allowed } = raw;
  if (!(typeof windowId === "string" && windowId.length > 0) && !finite(windowId)) return undefined;
  if (typeof appId !== "string" || appId.length > 256 || typeof title !== "string")
    return undefined;
  if (!finite(x) || !finite(y) || !finite(w) || !finite(h) || w < 0 || h < 0) return undefined;
  if (typeof focused !== "boolean" || typeof allowed !== "boolean") return undefined;
  return {
    windowId: String(windowId),
    appId,
    title: title.slice(0, 512),
    x,
    y,
    w,
    h,
    focused,
    allowed,
  };
}

export function parseCuWindows(data: unknown): CuWindow[] {
  if (!Array.isArray(data))
    throw new CuClientError("failed", "jarvis-cu sent a window list jarvisd cannot read");
  return data.slice(0, MAX_WINDOWS).flatMap((raw) => {
    const window = parseWindow(raw);
    return window === undefined ? [] : [window];
  });
}

const edge = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_EDGE;

export function parseCuCapture(data: unknown): CuCapture {
  const bad = (what: string) =>
    new CuClientError("failed", `jarvis-cu sent a capture with ${what}`);
  if (!isRecord(data)) throw bad("no fields");
  const { pngBase64, width, height, scale, windows } = data;
  if (
    typeof pngBase64 !== "string" ||
    pngBase64.length > CU_MAX_PNG_BASE64_CHARS ||
    !pngBase64.startsWith(PNG_BASE64_PREFIX) ||
    !BASE64.test(pngBase64)
  ) {
    throw bad("an image that is not a PNG");
  }
  if (!edge(width) || !edge(height)) throw bad("a size out of range");
  if (!finite(scale) || scale <= 0) throw bad("a bad scale");
  return { pngBase64, width, height, scale, windows: parseCuWindows(windows ?? []) };
}

/** Discovery is available before begin and contains no window titles. */
export function parseCuAppList(data: unknown): CuApp[] {
  if (!Array.isArray(data))
    throw new CuClientError("failed", "jarvis-cu sent an unreadable app list");
  return data.slice(0, MAX_WINDOWS).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const { appId, name } = raw;
    if (typeof appId !== "string" || appId.length > 256 || typeof name !== "string") return [];
    return [{ appId, name: name.slice(0, 512) }];
  });
}

export function parseCuDescription(data: unknown): CuDescription {
  const bad = () =>
    new CuClientError("failed", "jarvis-cu sent an unreadable accessibility description");
  if (!isRecord(data)) throw bad();
  const { role, name } = data;
  if (typeof role !== "string" || role.length > 256) throw bad();
  if (name !== undefined && typeof name !== "string") throw bad();
  return name === undefined ? { role } : { role, name: name.slice(0, 512) };
}
