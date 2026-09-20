// Task 4 (spec "workspace"): the one door a remote api:send/api:save call
// passes through before anything else happens to it.
//
// api:send used to be desktop-only (remote-policy.ts's own comment named
// why: a phone-supplied script running in the main process via node:vm, an
// arbitrary local file read through a multipart body, and an interactive
// OAuth2 tab the phone could pop on the laptop). This file is what makes
// flipping that policy safe: `prepareRemoteApiRequest` rebuilds `request`
// field by field from a fixed whitelist — never spreads the phone's object,
// never mutates it — and returns a brand new object that carries none of
// `script`, `tests`, a nested hook/event block, an oauth2 auth mode, or a
// multipart file value that is not one of this device's own staged upload
// ids. Anything this function does not explicitly copy below is dropped
// simply by never being written to the result; a future hook field added
// under a name this function has not been taught about is removed the same
// way, not because someone remembered to add it to a blocklist.
//
// ipc.ts's createApiHandlers calls this before writing history or handing
// the request to the runner (dispatch.ts's api:send/api:save are the only
// callers, and only for an authenticated remote Origin), so main.ts's
// sendApiRequest — the desktop execution closure that can run a script and
// open an OAuth2 tab — only ever sees the object this function built for a
// remote call, never the phone's own.
import { isFileId } from "@jarvis/wire";
import type { GitViewResult } from "./ipc.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "./messages.js";

/** Identifies the paired device a remote api:send/api:save call came from.
 *  dispatch.ts builds this from the authenticated Origin — never from
 *  anything in the call's own arguments — and passes it only for a remote
 *  origin; a desktop call never carries one. */
export type RemoteApiContext = { deviceId: string };

/** Behaviour rule 3 / Interfaces: `min(configuredTimeoutMs, 30_000)`, with a
 *  positive floor so a project configured with a zero/negative "no
 *  timeout" setting cannot hand a remote call an unbounded one. */
export const REMOTE_TIMEOUT_CAP_MS = 30_000;

/** Every control character a Bruno `.bru` file has no way to escape once it
 *  lands in one of the short scalars the serializer writes raw rather than
 *  through a quoting helper (see the fields this guards below) — U+0000
 *  through U+001F, and U+007F. `\r`/`\n` are the ones that actually let a
 *  crafted value close the enclosing block and open a new one (a
 *  `script:pre-request { ... }` block, most dangerously), but every other
 *  control character is refused the same way rather than trusted to be
 *  harmless. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: this pattern exists to find control characters — the exact ones a Bruno raw scalar sink cannot escape.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** @usebruno/lang's raw-string delimiter (`jsonToBru.js`'s own
 *  `getValueString`): a scalar whose value equals or contains three
 *  consecutive single quotes is written as `'''${value}'''` instead of a
 *  quoted, escaped one — a value that itself carries `'''` closes that
 *  block early and lets whatever follows it in the same field become raw
 *  `.bru` syntax of its own choosing, the identical class of break-out the
 *  control-character sinks above exist to close off. M12 Task 7 (controller
 *  ruling 6): this refusal is not remote-only — `'''` in a name reaches the
 *  exact same `meta.name` sink through a *desktop*-origin
 *  api:createRequest/renameRequest call too (ipc.ts's guardedWrite calls
 *  this same function for both origins), so widening isCleanScalar itself,
 *  rather than adding a second, remote-only check, closes it for both. */
const RAW_STRING_DELIMITER = "'''";

/** True only for a string the Bruno serializer can write into one of its
 *  raw (never quoted, never escaped) scalar slots without letting it break
 *  out of the block it belongs in. Exported so ipc.ts's guardedWrite can
 *  apply the identical rule to a request's `name` before it ever reaches
 *  createRequest/renameRequest, which write it into exactly the same
 *  `meta.name` sink (ruling 2026-09-19b) — for a desktop-origin call as
 *  much as a remote one (M12 Task 7, controller ruling 6). */
export function isCleanScalar(value: string): boolean {
  return !CONTROL_CHARACTER.test(value) && !value.includes(RAW_STRING_DELIMITER);
}

/** The rule for a pair *value* or a variable: the serializer wraps a
 *  multiline value in its own `'''` block and re-indents every line, so a
 *  newline, carriage return or tab cannot escape the block — only the
 *  delimiter itself and the other control characters can (final-review
 *  residual R2: a desktop-authored PEM or JSON value must stay sendable
 *  and saveable from the phone). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: same purpose as CONTROL_CHARACTER above, minus the three a multiline value block legitimately carries.
const VALUE_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export function isCleanValue(value: string): boolean {
  return !VALUE_CONTROL_CHARACTER.test(value) && !value.includes(RAW_STRING_DELIMITER);
}

/** The exact method set @usebruno/lang's jsonToBruV2 treats as "standard"
 *  (v2/src/jsonToBru.js) — and so serializes as `get { ... }` rather than
 *  the alternate `http {\n  method: ${method}` form, which interpolates
 *  `method` completely raw with no quoting at all. Restricting a remote
 *  request's method to this set (ruling 2026-09-19b) means the vulnerable
 *  branch is never reached by anything a remote call can write, regardless
 *  of what characters the value contains. */
const STANDARD_HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
  "connect",
]);

/** UTF-8 bytes of the decoded request+variables `prepareRemoteApiRequest`
 *  will accept, checked against the caller's own input before any field is
 *  rebuilt — a cheap bound on how much work a hostile payload can demand. */
export const MAX_REMOTE_REQUEST_BYTES = 524_288;

/** Rows per header/query/variable/form collection (Interfaces). */
export const MAX_REMOTE_COLLECTION_PAIRS = 256;

/** Multipart files in one remote request (Interfaces). */
export const MAX_REMOTE_MULTIPART_FILES = 16;

/** Aggregate multipart file bytes in one remote request (Interfaces). This
 *  is only the shape/count bound this file can check before any upload id
 *  is resolved; http-runner.ts's buildBody re-checks the real resolved
 *  bytes against its own copy of the same number while streaming files
 *  into the multipart body, since platform cannot import this desktop
 *  module. */
export const MAX_REMOTE_MULTIPART_BYTES = 26_214_400;

/** Response bytes read from the stream before http-runner.ts aborts the
 *  read (Interfaces). */
export const MAX_REMOTE_RESPONSE_BYTES = 1_048_576;

/** Serialized response header bytes http-runner.ts will accept
 *  (Interfaces). */
export const MAX_REMOTE_RESPONSE_HEADER_BYTES = 65_536;

/** Remote execution never inherits an unlimited or malformed project
 *  timeout. Ruling 2026-09-19a: a configured value that is `<= 0` (the
 *  settings tab's own "no timeout" spelling — see http-runner.ts, where
 *  `timeoutMs > 0` is the same test) or not finite gets the cap itself,
 *  never a 1&nbsp;ms floor that would fail an otherwise-ordinary project on
 *  every remote send; any other configured value is capped, never
 *  widened. */
export function clampRemoteTimeout(configuredTimeoutMs: number): number {
  if (!Number.isFinite(configuredTimeoutMs) || configuredTimeoutMs <= 0) {
    return REMOTE_TIMEOUT_CAP_MS;
  }
  return Math.min(configuredTimeoutMs, REMOTE_TIMEOUT_CAP_MS);
}

type UploadResolver = {
  resolve(
    deviceId: string,
    uploadId: string,
  ): Promise<{ bytes: Uint8Array; name: string; contentType: string } | undefined>;
};

/** Builds the only upload resolver remote execution receives. The device id
 * comes from authenticated dispatch context, never from the request object. */
export function bindRemoteUploadResolver(
  uploads: UploadResolver,
  context: RemoteApiContext,
): (
  uploadId: string,
) => Promise<{ bytes: Uint8Array; name: string; contentType: string } | undefined> {
  return (uploadId) => uploads.resolve(context.deviceId, uploadId);
}

// Fix round 1b (ruling checklist, "body mode strings"): `http.body` and
// `http.auth` are both raw-written sinks too (same shape as meta.name), but
// membership in one of these two fixed sets — checked with `.has()`, an
// exact match, never a prefix or pattern — is what a request's mode/auth
// value must already pass to reach the result at all, so neither can ever
// carry a control character through to that sink regardless of this file's
// own scalar guards elsewhere.
const KNOWN_BODY_MODES = new Set([
  "none",
  "json",
  "text",
  "xml",
  "formUrlEncoded",
  "graphql",
  "multipartForm",
]);

// "oauth2" is deliberately absent — Behaviour rule 1: rejected before any
// fetch, by never being a mode this function will carry through.
const KNOWN_AUTH_MODES = new Set(["none", "inherit", "bearer", "basic", "apikey"]);

function rejected(): GitViewResult<never> {
  return {
    ok: false,
    text: MESSAGES.remoteApiRejected(PRIMARY_LANGUAGE),
    language: PRIMARY_LANGUAGE,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

type SanitizedPair = { name: string; value: string; enabled?: boolean; type?: string };

/** Rebuilds one params/headers/formUrlEncoded/assertions row from exactly
 *  its own checked fields, or undefined if the row is not shaped like a row
 *  at all (no string name). `type` is kept only for params, which is the
 *  one collection the runner reads it from (a `type !== "query"` row is a
 *  path/route parameter it skips). */
function sanitizePair(value: unknown, keepType: boolean): SanitizedPair | undefined {
  if (!isPlainObject(value)) return undefined;
  const name = value["name"];
  if (!isString(name)) return undefined;
  // Fix round 1b (ruling): this row's own `name` is exactly the kind of
  // scalar jsonToBru.js writes via getKeyString for headers/query params/
  // formUrlEncoded/disabled assertions (quoted only if it contains
  // `:`/`"`/`{`/`}`/space — a bare control character sails through
  // unquoted) — and completely raw, no quoting at all, for a `path`-typed
  // param and an *enabled* assertion. Refusing one here closes every one of
  // those sinks the same way, without needing to know which block a given
  // row will end up written into.
  if (!isCleanScalar(name)) return undefined;
  const rawValue = value["value"];
  const enabled = value["enabled"];
  const type = value["type"];
  // Critical 1 (ruling 2026-09-19b): `type` is the one field of a params
  // row the serializer's path/query branch picks the raw, unescaped `name`
  // sink over the quoted one for (jsonToBru.js's `params:path` block writes
  // `item.name` directly, never through getKeyString) — refusing a control
  // character here is the cheapest place to close that off.
  if (keepType && isString(type) && !isCleanScalar(type)) return undefined;
  if (isString(rawValue) && !isCleanValue(rawValue)) return undefined;
  return {
    name,
    value: isString(rawValue) ? rawValue : "",
    ...(isBoolean(enabled) ? { enabled } : {}),
    ...(keepType && isString(type) ? { type } : {}),
  };
}

/** undefined means "over the row cap or not an array at all" — the caller
 *  turns that into a rejection; a missing collection is simply empty. */
function sanitizeCollection(value: unknown, keepType: boolean): SanitizedPair[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REMOTE_COLLECTION_PAIRS) return undefined;
  const rows: SanitizedPair[] = [];
  for (const item of value) {
    const row = sanitizePair(item, keepType);
    if (row === undefined) return undefined;
    rows.push(row);
  }
  return rows;
}

type SanitizedUploadRef = { uploadId: string };
type SanitizedMultipartField = {
  name: string;
  enabled?: boolean;
  type?: string;
  contentType?: string;
  value: string | SanitizedUploadRef[];
};

/** A multipart file field's value may contain only valid upload-id objects
 *  — Behaviour rule 2: never a string (a filesystem path, or a
 *  variable-interpolation pattern that could resolve into one at send
 *  time), never a value mixing the two, never an object missing or
 *  malforming its id. Anything else refuses the whole field. */
function sanitizeMultipartField(value: unknown): SanitizedMultipartField | undefined {
  if (!isPlainObject(value)) return undefined;
  const name = value["name"];
  if (!isString(name)) return undefined;
  // Fix round 1b: same rule as sanitizePair's `name` — jsonToBru.js writes
  // a multipart field's name via getKeyString too.
  if (!isCleanScalar(name)) return undefined;
  const enabled = value["enabled"];
  const contentType = value["contentType"];
  // Critical 1 (ruling 2026-09-19b): jsonToBru.js writes a multipart
  // field's contentType straight into `@contentType(${contentType})` with
  // no quoting at all — the same raw-scalar shape as meta.name.
  if (isString(contentType) && !isCleanScalar(contentType)) return undefined;
  const type = value["type"];
  const base = {
    name,
    ...(isBoolean(enabled) ? { enabled } : {}),
    ...(isString(type) ? { type } : {}),
    ...(isString(contentType) ? { contentType } : {}),
  };

  if (type === "file") {
    const raw = value["value"];
    if (!Array.isArray(raw)) return undefined;
    const refs: SanitizedUploadRef[] = [];
    for (const item of raw) {
      if (!isPlainObject(item)) return undefined;
      const uploadId = item["uploadId"];
      if (!isString(uploadId) || !isFileId(uploadId)) return undefined;
      // No other key: an upload-id reference is exactly {uploadId}, never
      // that plus a path/name a caller hoped would be read instead.
      if (Object.keys(item).length !== 1) return undefined;
      refs.push({ uploadId });
    }
    return { ...base, value: refs };
  }

  const rawValue = value["value"];
  return { ...base, value: isString(rawValue) ? rawValue : "" };
}

/** undefined means "reject the whole request" — over the field cap, over
 *  the file-count cap, or a field that failed its own shape check. */
function sanitizeMultipart(value: unknown): { fields: SanitizedMultipartField[] } | undefined {
  if (value === undefined) return { fields: [] };
  if (!Array.isArray(value) || value.length > MAX_REMOTE_COLLECTION_PAIRS) return undefined;
  const fields: SanitizedMultipartField[] = [];
  let fileCount = 0;
  for (const item of value) {
    const field = sanitizeMultipartField(item);
    if (field === undefined) return undefined;
    if (Array.isArray(field.value)) fileCount += field.value.length;
    if (fileCount > MAX_REMOTE_MULTIPART_FILES) return undefined;
    fields.push(field);
  }
  return { fields };
}

/** Minor (review): a variables object is turned into a plain `Record`
 *  by assigning each key with `result[key] = ...` — ordinary `[[Set]]`
 *  semantics, not `Object.defineProperty`. `__proto__` on a `{}` target
 *  only accepts an object/null value and silently no-ops for a string one,
 *  and `constructor`/`prototype` just shadow an own property — neither
 *  actually pollutes anything here — but the variable the caller thought
 *  they set would vanish without a trace instead. Refusing the whole
 *  request for one of these keys, the same as any other malformed
 *  variables object, beats losing a variable silently. */
const UNSAFE_VARIABLE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function sanitizeVariables(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length > MAX_REMOTE_COLLECTION_PAIRS) return undefined;
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (UNSAFE_VARIABLE_KEYS.has(key)) return undefined;
    const entry = value[key];
    if (!isString(entry)) return undefined;
    if (!isCleanValue(entry)) return undefined;
    result[key] = entry;
  }
  return result;
}

/** A cheap, early bound on the decoded payload's own size — before any
 *  field is rebuilt, so a hostile caller cannot buy expensive work by
 *  handing this function an enormous object graph. A value that cannot be
 *  serialized at all (a cycle) is treated as over the limit. */
function decodedByteLength(request: unknown, variables: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify({ request, variables }) ?? "null", "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The one door a remote api:send/api:save call passes through before
 * anything else happens to it. Rebuilds `request` and `variables` field by
 * field from a fixed whitelist and refuses outright — the same generic,
 * detail-free rejection for every reason — a payload that is too large, an
 * oauth2 auth mode, a collection over its row cap, or a multipart file
 * value that is not a clean upload-id reference.
 *
 * `script`, `tests`, and any nested hook/event block never appear in the
 * result: this function only ever writes a field it explicitly names below,
 * so a key it was never taught about is dropped along with them, not let
 * through because nobody remembered to blocklist it by name.
 */
export function prepareRemoteApiRequest(
  request: unknown,
  variables: unknown,
): GitViewResult<{ request: Record<string, unknown>; variables: Record<string, string> }> {
  const size = decodedByteLength(request, variables);
  if (size === undefined || size > MAX_REMOTE_REQUEST_BYTES) return rejected();
  if (!isPlainObject(request)) return rejected();

  const sanitizedVariables = sanitizeVariables(variables);
  if (sanitizedVariables === undefined) return rejected();

  const meta = isPlainObject(request["meta"]) ? request["meta"] : {};
  const metaName = meta["name"];
  // Critical 1: jsonToBru.js writes every meta key raw — `${key}: ${value}\n`
  // — with no quoting at all, so a name carrying `\n}\n\nscript:pre-request {`
  // can close the meta block and open a script one of its own. Refusing a
  // control character here is what keeps that sink out of remote reach.
  if (isString(metaName) && !isCleanScalar(metaName)) return rejected();
  // Fix round 1b (ruling checklist, "meta.type"): `meta.type` is never read
  // from `request` at all below — the `meta` object this function builds
  // only ever gets a `name` key — so there is no path from a phone's
  // submitted object to that raw sink to close; prepareRemoteApiSave's own
  // `meta.type` comes only from the file already on disk (see its own
  // comment), never from here.

  const http = isPlainObject(request["http"]) ? request["http"] : {};
  const rawMethod = http["method"];
  const url = http["url"];
  const auth = http["auth"];
  const bodyMode = http["body"];
  if (rawMethod !== undefined && !isString(rawMethod)) return rejected();
  // Critical 1: jsonToBru.js only takes the safe `get { ... }` form for a
  // method in its own standard set; anything else falls to
  // `http {\n  method: ${method}`, which interpolates `method` completely
  // raw. Normalizing case and restricting to that exact set means a remote
  // request can never land on the vulnerable branch, independent of the
  // control-character check every other scalar here gets.
  const method =
    rawMethod === undefined
      ? undefined
      : STANDARD_HTTP_METHODS.has(rawMethod.toLowerCase())
        ? rawMethod.toLowerCase()
        : undefined;
  if (rawMethod !== undefined && method === undefined) return rejected();
  if (url !== undefined && !isString(url)) return rejected();
  if (isString(url) && !isCleanScalar(url)) return rejected();
  // Behaviour rule 1: an oauth2 request is refused here, before this
  // function has returned anything a fetch could ever be issued from.
  if (auth === "oauth2") return rejected();
  if (auth !== undefined && (!isString(auth) || !KNOWN_AUTH_MODES.has(auth))) return rejected();
  if (bodyMode !== undefined && (!isString(bodyMode) || !KNOWN_BODY_MODES.has(bodyMode))) {
    return rejected();
  }

  const params = sanitizeCollection(request["params"], true);
  const headers = sanitizeCollection(request["headers"], false);
  const assertions = sanitizeCollection(request["assertions"], false);
  if (params === undefined || headers === undefined || assertions === undefined) return rejected();

  // Fix round 1b (ruling, "auth field names"): jsonToBru.js writes every
  // one of auth:bearer/basic/apikey's own fields the same raw way as
  // meta.name — `indentString(\`token: ${token}\`)` and its siblings, no
  // quoting or escaping at all — so each gets the identical control-
  // character rejection meta.name and apikey.placement already had.
  const authBlock = isPlainObject(request["auth"]) ? request["auth"] : {};
  const sanitizedAuth: Record<string, unknown> = {};
  if (auth === "bearer") {
    const bearer = isPlainObject(authBlock["bearer"]) ? authBlock["bearer"] : {};
    const token = bearer["token"];
    if (isString(token) && !isCleanScalar(token)) return rejected();
    sanitizedAuth["bearer"] = { token: isString(token) ? token : "" };
  } else if (auth === "basic") {
    const basic = isPlainObject(authBlock["basic"]) ? authBlock["basic"] : {};
    const username = basic["username"];
    const password = basic["password"];
    if (isString(username) && !isCleanScalar(username)) return rejected();
    if (isString(password) && !isCleanScalar(password)) return rejected();
    sanitizedAuth["basic"] = {
      username: isString(username) ? username : "",
      password: isString(password) ? password : "",
    };
  } else if (auth === "apikey") {
    const apikey = isPlainObject(authBlock["apikey"]) ? authBlock["apikey"] : {};
    const key = apikey["key"];
    const apikeyValue = apikey["value"];
    const placement = apikey["placement"];
    if (isString(key) && !isCleanScalar(key)) return rejected();
    if (isString(apikeyValue) && !isCleanScalar(apikeyValue)) return rejected();
    // Critical 1: jsonToBru.js writes `auth:apikey`'s placement raw —
    // `placement: ${placement}` — same sink shape as meta.name.
    if (isString(placement) && !isCleanScalar(placement)) return rejected();
    sanitizedAuth["apikey"] = {
      key: isString(key) ? key : "",
      value: isString(apikeyValue) ? apikeyValue : "",
      ...(isString(placement) ? { placement } : {}),
    };
  }

  const bodyContainer = isPlainObject(request["body"]) ? request["body"] : {};
  let sanitizedBody: Record<string, unknown> = {};
  if (bodyMode === "json") {
    const json = bodyContainer["json"];
    sanitizedBody = { json: isString(json) ? json : "" };
  } else if (bodyMode === "text") {
    const text = bodyContainer["text"];
    sanitizedBody = { text: isString(text) ? text : "" };
  } else if (bodyMode === "xml") {
    const xml = bodyContainer["xml"];
    sanitizedBody = { xml: isString(xml) ? xml : "" };
  } else if (bodyMode === "formUrlEncoded") {
    const form = sanitizeCollection(bodyContainer["formUrlEncoded"], false);
    if (form === undefined) return rejected();
    sanitizedBody = { formUrlEncoded: form };
  } else if (bodyMode === "graphql") {
    const graphql = isPlainObject(bodyContainer["graphql"]) ? bodyContainer["graphql"] : {};
    sanitizedBody = {
      graphql: {
        query: isString(graphql["query"]) ? graphql["query"] : "",
        variables: isString(graphql["variables"]) ? graphql["variables"] : "",
      },
    };
  } else if (bodyMode === "multipartForm") {
    const multipart = sanitizeMultipart(bodyContainer["multipartForm"]);
    if (multipart === undefined) return rejected();
    sanitizedBody = { multipartForm: multipart.fields };
  }

  const sanitizedRequest: Record<string, unknown> = {
    meta: { ...(isString(metaName) ? { name: metaName } : {}) },
    http: {
      ...(method === undefined ? {} : { method }),
      ...(url === undefined ? {} : { url }),
      ...(auth === undefined ? {} : { auth }),
      ...(bodyMode === undefined ? {} : { body: bodyMode }),
    },
    params,
    headers,
    auth: sanitizedAuth,
    body: sanitizedBody,
    assertions,
    // `script`, `tests`, and every other field the phone's object may have
    // carried are absent: this object literal is the whole result, and
    // nothing above ever copies them in.
  };

  return { ok: true, value: { request: sanitizedRequest, variables: sanitizedVariables } };
}

/** Behaviour rule 4: a remote-saved request can never retain a multipart
 *  file's upload-id reference — the id is ephemeral (file-upload.ts's own
 *  TTL) and a durable reference to it would be misleading the moment it
 *  expires. Applied only after `prepareRemoteApiRequest` has already
 *  stripped everything else; every multipart file field's value becomes an
 *  empty array rather than the field itself being dropped, so a save still
 *  round-trips the field's name/contentType for the next edit. */
export function stripEphemeralUploadRefs(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const body = isPlainObject(request["body"]) ? request["body"] : undefined;
  const multipartForm = body?.["multipartForm"];
  if (!Array.isArray(multipartForm)) return request;
  const stripped = multipartForm.map((field) =>
    isPlainObject(field) && field["type"] === "file" ? { ...field, value: [] } : field,
  );
  return { ...request, body: { ...body, multipartForm: stripped } };
}

/** The on-disk body-mode blocks worth carrying forward across a remote
 *  save that @usebruno/lang's jsonToBruV2 writes as a plain string
 *  (`body:json`/`body:text`/`body:xml`/`body:sparql`). `graphql`,
 *  `formUrlEncoded`, `multipartForm`, and `file` are folded separately
 *  below — they are not plain strings, so each gets its own shape check —
 *  but by the identical rule: only when `prepared` did not already set that
 *  key (the phone's own edit of its active mode always wins), and only
 *  ever from `onDisk`. */
const STRING_BODY_MODES = ["json", "text", "xml", "sparql"] as const;

/**
 * Critical 2 (review): a remote `api:save` must not clobber the parts of a
 * request the phone's own edit view never carries — Bruno's `meta.seq`
 * (display order), `meta.type`, `meta.tags`, `docs`, `vars.req`/`vars.res`,
 * `settings`, every body-mode block other than the one being saved
 * (`json`/`text`/`xml`/`sparql`/`graphql`/`formUrlEncoded`/`multipartForm`/
 * `file`), and every `auth.*` sub-block other than the one the submitted
 * mode populated (fix round 2: switching auth modes back and forth on the
 * phone must not silently erase a project's stored oauth2/awsv4/digest/
 * ntlm/oauth1/wsse/akamai-edgegrid config, none of which the phone's own
 * whitelist can even edit). Rebuilds the same executable-safe whitelist
 * `prepareRemoteApiRequest` already does from `submitted` (so `script`,
 * `tests`, hooks, an oauth2 auth mode, and every other guard above still
 * applies identically to a save), then folds those durable fields back on
 * top — but only ever from `onDisk`, the file this application already
 * wrote, never from `submitted`. A field a phone-supplied object carries is
 * never read here by any name this function was not already taught for the
 * executable whitelist; there is no path from `submitted` to `result` for
 * any of the fields this function folds in at all.
 *
 * Trust model (fix round 1b, ruling): none of the fields folded in below
 * get their own `isCleanScalar` check, unlike every field this file rebuilds
 * from `submitted`. That is deliberate, not an oversight — `onDisk` is
 * always this function's own prior write (or a file `readRequest` parsed
 * off disk, which only this application's own writers ever produce), never
 * anything a phone's own call supplied this round. If `prepareRemoteApiSave`
 * is ever changed to accept a second source of trust for these fields —
 * importing from another collection, say, or restoring a backup a phone
 * uploaded — that source would need the identical scalar guard before
 * landing here, the same way `submitted` already gets one.
 */
export function prepareRemoteApiSave(
  onDisk: unknown,
  submitted: unknown,
): GitViewResult<Record<string, unknown>> {
  const prepared = prepareRemoteApiRequest(submitted, {});
  if (!prepared.ok) return prepared;
  if (!isPlainObject(onDisk)) return { ok: true, value: prepared.value.request };

  const result: Record<string, unknown> = { ...prepared.value.request };

  const onDiskMeta = isPlainObject(onDisk["meta"]) ? onDisk["meta"] : {};
  const preparedMeta = isPlainObject(result["meta"])
    ? (result["meta"] as Record<string, unknown>)
    : {};
  // Fix wave 2 (meta.name fold, previously lost): a submitted request that
  // carries no usable name — missing, not a string, empty, or (M12 Task 12
  // minor) whitespace-only — folds the on-disk name forward instead of
  // losing it on save. A submitted clean name with real content always
  // wins over whatever is on disk. `preparedMeta["name"]` already passed
  // prepareRemoteApiRequest's own isCleanScalar/''' checks (or is absent),
  // so no scalar guard is needed here beyond the usual onDisk-is-trusted
  // discipline this function already applies to seq/type/tags below.
  const submittedName = preparedMeta["name"];
  const onDiskName = onDiskMeta["name"];
  const name =
    isString(submittedName) && submittedName.trim() !== ""
      ? submittedName
      : isString(onDiskName)
        ? onDiskName
        : undefined;
  const seq = onDiskMeta["seq"];
  const type = onDiskMeta["type"];
  const tags = onDiskMeta["tags"];
  result["meta"] = {
    ...(name !== undefined ? { name } : {}),
    ...(isString(seq) ? { seq } : {}),
    ...(isString(type) ? { type } : {}),
    // fix round 2: meta.tags is its own array Bruno's editor manages
    // separately from name/seq/type; the phone's whitelist never carries
    // it, so it only ever comes from onDisk, same discipline as vars/
    // settings below.
    ...(Array.isArray(tags) ? { tags } : {}),
  };

  if (isString(onDisk["docs"])) result["docs"] = onDisk["docs"];

  const onDiskVars = isPlainObject(onDisk["vars"]) ? onDisk["vars"] : undefined;
  if (onDiskVars !== undefined) {
    const vars: Record<string, unknown> = {};
    if (Array.isArray(onDiskVars["req"])) vars["req"] = onDiskVars["req"];
    if (Array.isArray(onDiskVars["res"])) vars["res"] = onDiskVars["res"];
    if (Object.keys(vars).length > 0) result["vars"] = vars;
  }

  if (isPlainObject(onDisk["settings"])) result["settings"] = onDisk["settings"];

  // fix round 2: every on-disk auth.* sub-block other than the one
  // `prepared` already populated for the submitted mode — an oauth2/
  // awsv4/digest/ntlm/oauth1/wsse/akamai-edgegrid config the phone's own
  // whitelist cannot edit (or even the *other* one of bearer/basic/apikey
  // it is not currently using) must not vanish just because the phone
  // saved while a different mode was selected.
  const onDiskAuth = isPlainObject(onDisk["auth"]) ? onDisk["auth"] : undefined;
  if (onDiskAuth !== undefined) {
    const auth: Record<string, unknown> = isPlainObject(result["auth"])
      ? { ...(result["auth"] as Record<string, unknown>) }
      : {};
    for (const key of Object.keys(onDiskAuth)) {
      if (auth[key] === undefined) auth[key] = onDiskAuth[key];
    }
    result["auth"] = auth;
  }

  const onDiskBody = isPlainObject(onDisk["body"]) ? onDisk["body"] : undefined;
  if (onDiskBody !== undefined) {
    const body: Record<string, unknown> = isPlainObject(result["body"])
      ? { ...(result["body"] as Record<string, unknown>) }
      : {};
    for (const key of STRING_BODY_MODES) {
      // Never overwrites a key `prepared` already set: that one is the
      // phone's own edit of its active mode, and must win.
      if (body[key] === undefined && isString(onDiskBody[key])) body[key] = onDiskBody[key];
    }
    // fix round 2: graphql/formUrlEncoded/multipartForm/file are not plain
    // strings, so each gets its own shape check, but the same "only if
    // `prepared` did not already set this key, only ever from onDisk" rule.
    if (body["graphql"] === undefined && isPlainObject(onDiskBody["graphql"])) {
      body["graphql"] = onDiskBody["graphql"];
    }
    if (body["formUrlEncoded"] === undefined && Array.isArray(onDiskBody["formUrlEncoded"])) {
      body["formUrlEncoded"] = onDiskBody["formUrlEncoded"];
    }
    if (body["multipartForm"] === undefined && Array.isArray(onDiskBody["multipartForm"])) {
      // Still subject to stripEphemeralUploadRefs, applied by ipc.ts's
      // save handler to whatever `body.multipartForm` this function
      // returns — active or, as here, folded in from onDisk — so an old
      // upload-id reference in an inactive multipart block cannot outlive
      // this save either.
      body["multipartForm"] = onDiskBody["multipartForm"];
    }
    if (body["file"] === undefined && Array.isArray(onDiskBody["file"])) {
      body["file"] = onDiskBody["file"];
    }
    result["body"] = body;
  }

  return { ok: true, value: result };
}

// M12 Task 7 follow-up (controller ruling): the atomic-write primitive
// (temp file in the same directory + rename, temp file removed on any
// failure) now lives in platform/bruno.ts, next to the actual `.bru`/
// environment writers it protects (`writeRequest`/`writeEnvironment`,
// which `createRequest`/`renameRequest`/`writeImported` all route through)
// — platform cannot depend on this desktop package, so the primitive
// cannot live here and be imported there. Re-exported so the existing
// `import { writeAtomically } from "./remote-api.js"` call sites (and
// remote-api.test.ts's own coverage of it) keep working unchanged.
export { writeAtomically } from "@jarvis/platform";
