// Issues a Bruno request and reports what came back.
//
// This runs in the main process, and that is the whole point: a request
// leaves here as an ordinary Node fetch, not from a browser origin, so CORS
// — the reason a hosted API client cannot call a project's endpoints, and
// the reason Postman is a native app — never enters into it.
//
// fetch and the clock are injected so every behaviour below is testable
// without a network or a real elapsed millisecond.

import type { CookieJar } from "./cookies.js";

export type ApiResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  timeMs: number;
  bytes: number;
  /** Variables left as literals because nothing resolved them. */
  unresolved: string[];
};

export type ApiFailure = {
  failed: true;
  detail: string;
  timeMs: number;
  /** Task 4 fix round (Important 3, review): lets a caller branch on *why*
   *  a request failed without matching this file's own English `detail`
   *  text, which is presentation, not a contract, and changes freely.
   *  Present only for the failure categories a caller needs to tell apart
   *  from one another — a remote call's own localized response-too-large/
   *  headers-too-large text, a multipart upload that could not be resolved
   *  or was over its cap, and (M12 Task 12 minor) a request that never got
   *  a response within `NetworkOptions.timeoutMs` — the phone can say
   *  "timed out" instead of showing a raw abort message. Every other
   *  failure (a bad URL, a transport error) leaves this undefined, same as
   *  before this field existed. */
  kind?: "responseTooLarge" | "responseHeadersTooLarge" | "multipartUpload" | "timeout";
};

export type SendDeps = {
  fetch: typeof fetch;
  now: () => number;
  /** The project's cookie jar, when it has one. An API you log into with one
   *  request and call with the next needs it; without one the second request
   *  is anonymous. */
  jar?: CookieJar;
  /** Reads a file a multipart body refers to. Injected so the runner stays
   *  testable without a filesystem. Desktop-only path semantics — a remote
   *  call (Task 4) never supplies this, so a multipart file value that is
   *  still a bare string by the time it reaches buildBody can never read
   *  anything through it there either way. */
  readFile?: (path: string) => Promise<Uint8Array>;
  /** Resolves a request-relative file path against its collection. Same
   *  desktop-only note as readFile. */
  resolvePath?: (path: string) => string;
  /** Resolves one of this device's own staged upload ids (Task 4,
   *  file-upload.ts) to its bytes — bound by the caller to the
   *  authenticated device id, never to anything a request argument names,
   *  so this can never read another device's staged file. A multipart file
   *  value that names an id this returns `undefined` for (unknown,
   *  expired, another device's, or this dependency simply not supplied)
   *  fails the whole send — see buildBody — rather than silently sending a
   *  part short a file. */
  resolveUpload?: (
    id: string,
  ) => Promise<{ bytes: Uint8Array; name: string; contentType: string } | undefined>;
  /** Per-request network options: a proxy to go through, whether to insist
   *  on a valid certificate, how long to wait. */
  dispatcherFor?: (options: NetworkOptions) => unknown;
  /** The FormData and File classes belonging to the same implementation as
   *  `fetch`. A multipart body built from a *different* realm's FormData is
   *  not recognised as one and is stringified instead — the request then goes
   *  out as text/plain and the server sees no fields at all. */
  multipart?: { FormData: typeof FormData; File: typeof File };
  /** A token already obtained for an oauth2 request. */
  token?: {
    accessToken: string;
    placement: "header" | "url";
    headerPrefix: string;
    queryKey: string;
  };
};

/** What the Settings tab controls, and what a collection can carry. */
export type NetworkOptions = {
  proxyUrl?: string;
  /** false is a deliberate choice for a development server with a
   *  self-signed certificate; it is never the default. */
  verifyCertificate: boolean;
  timeoutMs: number;
  /** Bounds how many bytes of the final response body are read from the
   *  stream before the read is aborted and the send reported failed (Task
   *  4) — remote calls only; a desktop caller leaves this unset and reads
   *  the whole body exactly as before. */
  maxResponseBytes?: number;
  /** Bounds the serialized size of the final response's own headers,
   *  checked before the body is read at all — remote calls only, same note
   *  as maxResponseBytes. */
  maxResponseHeaderBytes?: number;
};

/** Distinguishes a multipart body that failed to build — a missing or
 *  unresolvable upload id, or too many files/bytes — from any other throw
 *  inside buildBody, so sendRequest can turn only this one into an
 *  ApiFailure rather than letting every unexpected error do the same. */
class MultipartUploadError extends Error {}

/** Task 4's own copies of remote-api.ts's MAX_REMOTE_MULTIPART_FILES/BYTES
 *  — platform cannot import a desktop module, so the aggregate bound
 *  buildBody enforces against the *real* resolved bytes (as opposed to
 *  remote-api.ts's own count/shape-only pre-check) is this file's own
 *  constant. Keep the two numbers in sync by hand if either changes. */
const MAX_UPLOAD_REF_FILES = 16;
const MAX_UPLOAD_REF_BYTES = 26_214_400;

/** Reads a Response's body up to `maxBytes`, aborting the read (and the
 *  underlying stream) the moment more has arrived — never buffering an
 *  oversized body just to discard it afterward. Falls back to a plain
 *  `.text()` read, checked after the fact, only for a Response whose body
 *  is not a stream at all (not a shape real fetch ever returns, but cheap
 *  to guard against a lightweight test double doing something unusual). */
async function readBoundedText(response: Response, maxBytes: number): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") > maxBytes ? undefined : text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/** name + value + ": " + "\r\n", the same rough accounting a real HTTP
 *  header line costs on the wire — good enough for a cap meant to bound
 *  memory, not to reproduce RFC 7230 to the byte. */
function headerByteLength(headers: Headers): number {
  let total = 0;
  for (const [name, value] of headers.entries()) {
    total += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 4;
  }
  return total;
}

type Pair = { name?: string; value?: string; enabled?: boolean };

const VARIABLE = /\{\{\s*([^}\s]+)\s*\}\}/g;

/** Enough hops for a real login dance, few enough that a redirect loop stops
 *  rather than running until the timeout. */
const MAX_REDIRECTS = 10;

/** Anything that looks like a host, so a URL typed without a scheme can be
 *  given one rather than refused. */
const HOSTLIKE = /^[\w.-]+(:\d+)?(\/|$|\?)/;
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$|\?)/;

/**
 * Supplies a missing scheme. The Workspace's address bar already accepts
 * `github.com`, and an API URL should not be the one place that refuses it.
 * Loopback gets http, because a development server rarely has a certificate.
 */
export function withScheme(url: string): string {
  // `localhost:8000` is a host and a port, not a scheme — the two are
  // indistinguishable by shape alone, so a colon followed by digits settles
  // it before the scheme test gets a chance to be wrong.
  const isHostPort = /^[a-zA-Z][a-zA-Z0-9+.-]*:\d/.test(url);
  if (!isHostPort && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return url;
  if (LOOPBACK.test(url)) return `http://${url}`;
  if (HOSTLIKE.test(url)) return `https://${url}`;
  return url;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Substitutes `{{name}}` from `variables`.
 *
 * An unknown variable is left exactly as written rather than blanked. A
 * request to `https:///api` is a confusing failure; a request to
 * `{{base}}/api` says precisely what is missing, and the caller reports the
 * names alongside the response.
 */
export function interpolate(
  text: string,
  variables: Record<string, string>,
): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const replaced = text.replace(VARIABLE, (match, name: string) => {
    const value = variables[name];
    if (value !== undefined) return value;
    if (!unresolved.includes(name)) unresolved.push(name);
    return match;
  });
  return { text: replaced, unresolved };
}

/** Sends one parsed .bru request. Scripts and assertions on the request are
 *  deliberately not run — see the spec: executing them is a sandboxing
 *  decision of its own, and silently ignoring them is why the response pane
 *  says so when a request carries one. */
export async function sendRequest(
  request: Record<string, unknown>,
  variables: Record<string, string>,
  deps: SendDeps,
  options?: NetworkOptions,
): Promise<ApiResponse | ApiFailure> {
  const started = deps.now();
  const unresolved: string[] = [];

  const resolve = (text: string): string => {
    const result = interpolate(text, variables);
    for (const name of result.unresolved) if (!unresolved.includes(name)) unresolved.push(name);
    return result.text;
  };

  const http = (request["http"] ?? {}) as {
    method?: string;
    url?: string;
    body?: string;
    auth?: string;
  };
  const method = (http.method ?? "get").toUpperCase();

  let url: URL;
  const resolvedUrl = withScheme(resolve(http.url ?? "").trim());
  try {
    url = new URL(resolvedUrl);
  } catch {
    // Never reached fetch, so there is no elapsed request to time — but the
    // caller still wants a number rather than a special case.
    //
    // An unresolved variable is by far the likeliest reason a URL will not
    // parse, and "not a valid URL" would send the reader looking at the URL
    // rather than at the environment they forgot to select. Name it.
    const detail =
      unresolved.length > 0
        ? `No value for ${unresolved.map((name) => `{{${name}}}`).join(", ")} in the URL`
        : `Not a valid URL: ${resolvedUrl}`;
    return { failed: true, detail, timeMs: 0 };
  }

  for (const param of (request["params"] as Pair[] | undefined) ?? []) {
    const type = (param as { type?: string }).type;
    if (param.enabled === false || (type !== undefined && type !== "query")) continue;
    // A row with no name is half-typed, not a parameter. Sending it makes
    // fetch reject the whole request for a reason that has nothing to do
    // with what the user was doing.
    if (param.name === undefined || param.name.trim() === "") continue;
    url.searchParams.append(resolve(param.name), resolve(param.value ?? ""));
  }

  const headers: Record<string, string> = {};
  for (const header of (request["headers"] as Pair[] | undefined) ?? []) {
    if (header.enabled === false || header.name === undefined || header.name.trim() === "")
      continue;
    headers[resolve(header.name)] = resolve(header.value ?? "");
  }

  applyAuth(request, http.auth, headers, resolve, url);

  // An OAuth2 token is fetched by the caller (it needs a browser for one of
  // the grants) and handed in already resolved, so this only has to place it.
  if (deps.token !== undefined) {
    if (deps.token.placement === "url")
      url.searchParams.set(deps.token.queryKey, deps.token.accessToken);
    else headers["Authorization"] = `${deps.token.headerPrefix} ${deps.token.accessToken}`.trim();
  }

  // The jar is consulted after the request's own headers, and never
  // overrides one the request set by hand: an explicit Cookie header is the
  // author saying what they want sent.
  const jarHeader = deps.jar?.headerFor(url.toString()) ?? "";
  const hasOwnCookie = Object.keys(headers).some((name) => name.toLowerCase() === "cookie");
  if (jarHeader !== "" && !hasOwnCookie) headers["Cookie"] = jarHeader;

  // fetch refuses a body on GET or HEAD outright, so a request whose method
  // was changed from POST — leaving the body mode behind — would fail for a
  // reason that has nothing to do with what the user changed.
  const carriesBody = method !== "GET" && method !== "HEAD";
  let body: string | FormData | undefined;
  try {
    body = carriesBody ? await buildBody(request, http.body, headers, resolve, deps) : undefined;
  } catch (error) {
    // A missing/unresolvable upload id, or too many files/bytes — buildBody
    // is the only thing that throws this, and only for that reason; any
    // other throw is a bug and propagates as it always did.
    if (error instanceof MultipartUploadError) {
      return {
        failed: true,
        detail: error.message,
        timeMs: deps.now() - started,
        kind: "multipartUpload",
      };
    }
    throw error;
  }

  const settings = (request["settings"] ?? {}) as { timeout?: number };
  const network: NetworkOptions = {
    verifyCertificate: options?.verifyCertificate ?? true,
    timeoutMs:
      typeof settings.timeout === "number" && settings.timeout > 0
        ? settings.timeout
        : (options?.timeoutMs ?? 0),
    ...(options?.proxyUrl === undefined ? {} : { proxyUrl: options.proxyUrl }),
    ...(options?.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
    ...(options?.maxResponseHeaderBytes === undefined
      ? {}
      : { maxResponseHeaderBytes: options.maxResponseHeaderBytes }),
  };
  const dispatcher = deps.dispatcherFor?.(network);
  // A request with no timeout can hang forever, and a UI waiting on it looks
  // broken rather than busy.
  const signal = network.timeoutMs > 0 ? AbortSignal.timeout(network.timeoutMs) : undefined;

  try {
    let response = await deps.fetch(url.toString(), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(dispatcher === undefined ? {} : { dispatcher }),
      ...(signal === undefined ? {} : { signal }),
      // With a jar, redirects are followed by hand. A login endpoint that
      // answers 302 with Set-Cookie is the ordinary case, and letting fetch
      // follow it silently means the cookie is set on a response nobody ever
      // sees — the jar stays empty and the next request is anonymous.
      ...(deps.jar === undefined ? {} : { redirect: "manual" as const }),
    } as RequestInit);

    // getSetCookie is the only way to see several Set-Cookie headers; reading
    // the header directly joins them into one unparseable string.
    const collect = (from: Response, at: string): void => {
      const setCookies =
        typeof from.headers.getSetCookie === "function" ? from.headers.getSetCookie() : [];
      if (setCookies.length > 0) deps.jar?.store(at, setCookies);
    };

    let current = url.toString();
    collect(response, current);

    if (deps.jar !== undefined) {
      for (let hop = 0; hop < MAX_REDIRECTS && isRedirect(response.status); hop += 1) {
        const location = response.headers.get("location");
        if (location === null) break;
        const next = new URL(location, current).toString();

        // 303, and 301/302 on anything other than GET/HEAD, become a GET
        // without a body — what every browser does, and what an API that
        // redirects after a POST expects.
        const asGet = response.status === 303 || (method !== "GET" && method !== "HEAD");
        const hopHeaders: Record<string, string> = { ...headers };
        delete hopHeaders["Cookie"];
        const jarHeader = deps.jar.headerFor(next);
        if (jarHeader !== "") hopHeaders["Cookie"] = jarHeader;
        if (asGet) delete hopHeaders["Content-Type"];

        response = await deps.fetch(next, {
          method: asGet ? "GET" : method,
          headers: hopHeaders,
          ...(asGet || body === undefined ? {} : { body }),
          ...(dispatcher === undefined ? {} : { dispatcher }),
          ...(signal === undefined ? {} : { signal }),
          redirect: "manual" as const,
        } as RequestInit);

        current = next;
        collect(response, current);
      }
    }
    // Task 4: checked before a single body byte is read — a response
    // carrying more header data than a remote call is allowed to receive is
    // refused the same way an oversized body is, never truncated or passed
    // through partially.
    if (
      network.maxResponseHeaderBytes !== undefined &&
      headerByteLength(response.headers) > network.maxResponseHeaderBytes
    ) {
      return {
        failed: true,
        detail: "Response headers too large.",
        timeMs: deps.now() - started,
        kind: "responseHeadersTooLarge",
      };
    }

    const text =
      network.maxResponseBytes === undefined
        ? await response.text()
        : await readBoundedText(response, network.maxResponseBytes);
    if (text === undefined) {
      return {
        failed: true,
        detail: "Response too large.",
        timeMs: deps.now() - started,
        kind: "responseTooLarge",
      };
    }
    return {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: text,
      // Bytes as sent on the wire, not characters: a multi-byte response is
      // bigger than its length suggests.
      bytes: Buffer.byteLength(text, "utf8"),
      timeMs: deps.now() - started,
      unresolved,
    };
  } catch (error) {
    return {
      failed: true,
      detail: failureDetail(error),
      timeMs: deps.now() - started,
      ...(isTimeoutError(error) ? { kind: "timeout" as const } : {}),
    };
  }
}

/** True for the abort `AbortSignal.timeout()` raises once `network.timeoutMs`
 *  elapses — checked by name rather than `instanceof DOMException` (or
 *  `.name === "AbortError"`, a plain caller-triggered abort's own name,
 *  which this deliberately does not match: nothing here ever calls
 *  `.abort()` itself) so a fetch implementation that wraps or subclasses
 *  the reason is still recognised. */
function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "TimeoutError"
  );
}

/**
 * What actually went wrong.
 *
 * Node's fetch reports every transport failure as the word "fetch failed" and
 * hides the reason — ECONNREFUSED, ENOTFOUND, a TLS error — on the error's
 * `cause`. On screen that reads as a bug in the app rather than as a server
 * that is not running.
 */
function failureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause === undefined || cause === null) return message;

  const record = typeof cause === "object" ? (cause as Record<string, unknown>) : {};
  // undici wraps a connection failure in an AggregateError whose own message
  // is empty and whose reason is in `errors[0]` — without unwrapping it, the
  // detail is a bare code and a dangling colon.
  const nested = Array.isArray(record["errors"]) ? (record["errors"] as unknown[])[0] : undefined;
  const messageOf = (value: unknown): string =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { message?: unknown }).message === "string"
      ? (value as { message: string }).message
      : "";

  const causeMessage =
    messageOf(cause) || messageOf(nested) || (typeof cause === "string" ? cause : "");
  const code = typeof record["code"] === "string" ? record["code"] : undefined;

  const detail =
    causeMessage === ""
      ? (code ?? "")
      : code !== undefined && !causeMessage.includes(code)
        ? `${code}: ${causeMessage}`
        : causeMessage;
  return detail === "" || detail === message ? message : `${message} — ${detail}`;
}

function applyAuth(
  request: Record<string, unknown>,
  mode: string | undefined,
  headers: Record<string, string>,
  resolve: (text: string) => string,
  url: URL,
): void {
  if (mode === undefined || mode === "none" || mode === "inherit") return;
  const auth = (request["auth"] ?? {}) as Record<string, Record<string, string>>;

  if (mode === "bearer") {
    const token = auth["bearer"]?.["token"];
    if (token !== undefined) headers["Authorization"] = `Bearer ${resolve(token)}`;
    return;
  }

  if (mode === "basic") {
    const basic = auth["basic"] ?? {};
    const credential = `${resolve(basic["username"] ?? "")}:${resolve(basic["password"] ?? "")}`;
    headers["Authorization"] = `Basic ${Buffer.from(credential).toString("base64")}`;
    return;
  }

  if (mode === "apikey") {
    const apikey = auth["apikey"] ?? {};
    const key = resolve(apikey["key"] ?? "");
    if (key === "") return;
    const value = resolve(apikey["value"] ?? "");
    // Bruno writes the query placement as "queryparams"; anything else means
    // a header, which is where an API key usually goes.
    if (apikey["placement"] === "queryparams" || apikey["placement"] === "query") {
      url.searchParams.set(key, value);
    } else {
      headers[key] = value;
    }
  }
}

async function buildBody(
  request: Record<string, unknown>,
  mode: string | undefined,
  headers: Record<string, string>,
  resolve: (text: string) => string,
  deps: SendDeps,
): Promise<string | FormData | undefined> {
  if (mode === undefined || mode === "none") return undefined;
  const body = (request["body"] ?? {}) as Record<string, unknown>;

  /** Only when the request did not set one itself: an explicit
   *  Content-Type on the request is a deliberate choice (a vendor JSON type,
   *  say) and must win over the default for its body kind. */
  const defaultContentType = (value: string): void => {
    const already = Object.keys(headers).some((name) => name.toLowerCase() === "content-type");
    if (!already) headers["Content-Type"] = value;
  };

  if (mode === "json") {
    defaultContentType("application/json");
    return resolve(String(body["json"] ?? ""));
  }
  if (mode === "text") {
    defaultContentType("text/plain");
    return resolve(String(body["text"] ?? ""));
  }
  if (mode === "xml") {
    defaultContentType("application/xml");
    return resolve(String(body["xml"] ?? ""));
  }
  if (mode === "formUrlEncoded") {
    defaultContentType("application/x-www-form-urlencoded");
    const form = new URLSearchParams();
    for (const field of (body["formUrlEncoded"] as Pair[] | undefined) ?? []) {
      if (field.enabled === false || field.name === undefined || field.name.trim() === "") continue;
      form.append(resolve(field.name), resolve(field.value ?? ""));
    }
    return form.toString();
  }
  if (mode === "graphql") {
    defaultContentType("application/json");
    const graphql = (body["graphql"] ?? {}) as { query?: string; variables?: string };
    const query = resolve(graphql.query ?? "");
    const raw = resolve(graphql.variables ?? "").trim();
    let parsed: unknown;
    if (raw !== "") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Variables that are not JSON are sent as the string they are; the
        // server's error about them is more useful than one invented here.
        parsed = raw;
      }
    }
    return JSON.stringify(parsed === undefined ? { query } : { query, variables: parsed });
  }

  if (mode === "multipartForm") {
    // The boundary is FormData's to choose, so any Content-Type set here
    // would be wrong — deleted rather than left to break the request.
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "content-type") delete headers[name];
    }
    const form = new (deps.multipart?.FormData ?? FormData)();
    // Task 4: aggregate across every file field in this one multipart body
    // — the cap is on the whole request, not per field.
    let uploadRefFiles = 0;
    let uploadRefBytes = 0;
    for (const field of (body["multipartForm"] as MultipartField[] | undefined) ?? []) {
      if (field.enabled === false || field.name === undefined || field.name.trim() === "") continue;
      const name = resolve(field.name);

      if (field.type === "file") {
        const paths = Array.isArray(field.value) ? field.value : [];
        const FileClass = deps.multipart?.File ?? File;
        for (const path of paths) {
          // Desktop-only path semantics, unchanged: a plain string is a
          // request-relative path, read straight off disk.
          if (typeof path === "string") {
            const full = deps.resolvePath?.(resolve(path)) ?? resolve(path);
            const bytes = await deps.readFile?.(full);
            if (bytes === undefined) continue;
            const fileName = full.slice(full.lastIndexOf("/") + 1);
            form.append(
              name,
              new FileClass([bytes as BlobPart], fileName, {
                ...(field.contentType === undefined || field.contentType === ""
                  ? {}
                  : { type: field.contentType }),
              }),
            );
            continue;
          }

          // Otherwise the only other shape remote-api.ts's
          // prepareRemoteApiRequest ever produces: {uploadId}. Resolved
          // through a closure the caller bound to the authenticated device
          // id (SendDeps.resolveUpload) — an id that cannot be resolved
          // fails the whole send rather than silently sending a part short
          // a file (Task 4 Behaviour rule 2).
          const uploadId = path.uploadId;
          const resolved = await deps.resolveUpload?.(uploadId);
          if (resolved === undefined) {
            throw new MultipartUploadError("Uploaded file not found, or it expired.");
          }
          uploadRefFiles += 1;
          uploadRefBytes += resolved.bytes.length;
          if (uploadRefFiles > MAX_UPLOAD_REF_FILES || uploadRefBytes > MAX_UPLOAD_REF_BYTES) {
            throw new MultipartUploadError(
              "Too many files, or too much file data, in this request.",
            );
          }
          form.append(
            name,
            new FileClass([resolved.bytes as BlobPart], resolved.name, {
              ...(resolved.contentType === "" ? {} : { type: resolved.contentType }),
            }),
          );
        }
        continue;
      }

      form.append(name, resolve(typeof field.value === "string" ? field.value : ""));
    }
    return form;
  }

  return undefined;
}

type MultipartField = {
  name?: string;
  /** A text field carries a string; a file field carries a list of paths —
   *  desktop-only path semantics, unchanged — or, from a remote call
   *  (Task 4), a list of this device's own staged upload-id references.
   *  Never both in the same list: remote-api.ts's prepareRemoteApiRequest
   *  refuses a mixed array before it ever reaches here. */
  value?: string | (string | { uploadId: string })[];
  enabled?: boolean;
  type?: string;
  contentType?: string;
};
