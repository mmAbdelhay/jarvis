// The file upload channel's own shapes (M9 Task 3, spec "workspace"): the
// meta a phone attaches to its `blob` header for `remote:uploadFile`, and
// the result the laptop answers with once the file has been staged in its
// private per-device directory. Same discipline as voice.ts throughout this
// package: pure (no node:*, no other workspace package — no-node-imports.
// test.ts), and every parser rebuilds its return value field by field from a
// validated `unknown`, never spreading the input — an extra key on the wire
// is dropped rather than carried through, and a malformed field anywhere
// answers `undefined` for the whole value rather than a partial result.
//
// A filename is metadata only: the store (packages/desktop/src/file-
// upload.ts) never lets it — or any other phone-supplied string — become
// part of a filesystem path; every file is keyed by a random FILE_ID_PATTERN
// id instead. The character bans below (NUL, CR/LF, slash, backslash,
// `.`/`..`) are still enforced here, defensively, so a name that looks like
// a path or could smuggle a control character into a rendered list is
// refused outright rather than silently sanitised somewhere downstream.

export const FILE_UPLOAD_CHANNEL = "remote:uploadFile";

export const MAX_FILE_BYTES = 26_214_400;
export const FILE_TTL_MS = 3_600_000;
export const MAX_DEVICE_UPLOAD_BYTES = 104_857_600;
export const MAX_DEVICE_UPLOAD_FILES = 16;
export const MAX_JSON_UPLOAD_BYTES = 524_288;
export const FILE_UPLOAD_SWEEP_INTERVAL_MS = 60_000;
export const FILE_ID_PATTERN = /^[0-9a-f]{32}$/;

const MAX_FILE_NAME_CHARS = 255;
const MAX_CONTENT_TYPE_CHARS = 127;
// CR, LF, forward slash and backslash. A NUL byte is checked separately,
// below (hasNulByte) — a literal NUL inside a regex character class is
// itself flagged as an unusual control character.
const FORBIDDEN_NAME_CHARS = /[\r\n/\\]/;

function hasNulByte(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 0) return true;
  }
  return false;
}

export type FileUploadMeta = { name: string; contentType: string };

export type UploadedFile = {
  fileId: string;
  name: string;
  contentType: string;
  bytes: number;
  expiresAt: number;
};

function isAsciiContentType(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_CONTENT_TYPE_CHARS) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

function isFileName(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_FILE_NAME_CHARS) {
    return false;
  }
  if (FORBIDDEN_NAME_CHARS.test(value) || hasNulByte(value)) return false;
  if (value === "." || value === "..") return false;
  return true;
}

/** The `blob` header's `a[0]` for `remote:uploadFile`, validated before a
 *  single byte of the upload is ever kept. */
export function parseFileUploadMeta(value: unknown): FileUploadMeta | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;

  const name = raw["name"];
  if (!isFileName(name)) return undefined;

  const contentType = raw["contentType"];
  if (!isAsciiContentType(contentType)) return undefined;

  return { name, contentType };
}

/** The opaque id a `put` answers with, and the only thing a later
 *  `remote:readJsonUpload` call may name a file by — never a path. */
export function isFileId(value: unknown): value is string {
  return typeof value === "string" && FILE_ID_PATTERN.test(value);
}

/** `remote:uploadFile`'s response, as the phone decodes it off the wire. */
export function parseUploadedFile(value: unknown): UploadedFile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;

  const fileId = raw["fileId"];
  if (!isFileId(fileId)) return undefined;

  const name = raw["name"];
  if (!isFileName(name)) return undefined;

  const contentType = raw["contentType"];
  if (!isAsciiContentType(contentType)) return undefined;

  const bytes = raw["bytes"];
  if (
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > MAX_FILE_BYTES
  ) {
    return undefined;
  }

  const expiresAt = raw["expiresAt"];
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    return undefined;
  }

  return { fileId, name, contentType, bytes, expiresAt };
}
