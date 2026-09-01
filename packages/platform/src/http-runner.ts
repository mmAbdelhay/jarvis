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

export type ApiFailure = { failed: true; detail: string; timeMs: number };

export type SendDeps = {
  fetch: typeof fetch;
  now: () => number;
  /** The project's cookie jar, when it has one. An API you log into with one
   *  request and call with the next needs it; without one the second request
   *  is anonymous. */
  jar?: CookieJar;
  /** Reads a file a multipart body refers to. Injected so the runner stays
   *  testable without a filesystem. */
  readFile?: (path: string) => Promise<Uint8Array>;
  /** Resolves a request-relative file path against its collection. */
  resolvePath?: (path: string) => string;
  /** Per-request network options: a proxy to go through, whether to insist
   *  on a valid certificate, how long to wait. */
  dispatcherFor?: (options: NetworkOptions) => unknown;
  /** The FormData and File classes belonging to the same implementation as
   *  `fetch`. A multipart body built from a *different* realm's FormData is
   *  not recognised as one and is stringified instead — the request then goes
   *  out as text/plain and the server sees no fields at all. */
  multipart?: { FormData: typeof FormData; File: typeof File };
  /** A token already obtained for an oauth2 request. */
  token?: { accessToken: string; placement: "header" | "url"; headerPrefix: string; queryKey: string };
};

/** What the Settings tab controls, and what a collection can carry. */
export type NetworkOptions = {
  proxyUrl?: string;
  /** false is a deliberate choice for a development server with a
   *  self-signed certificate; it is never the default. */
  verifyCertificate: boolean;
  timeoutMs: number;
};

type Pair = { name?: string; value?: string; enabled?: boolean };

const VARIABLE = /\{\{\s*([^}\s]+)\s*\}\}/g;

/** Enough hops for a real login dance, few enough that a redirect loop stops
 *  rather than running until the timeout. */
const MAX_REDIRECTS = 10;

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

  const http = (request["http"] ?? {}) as { method?: string; url?: string; body?: string; auth?: string };
  const method = (http.method ?? "get").toUpperCase();

  let url: URL;
  const resolvedUrl = resolve(http.url ?? "");
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
    if (param.name === undefined) continue;
    url.searchParams.append(resolve(param.name), resolve(param.value ?? ""));
  }

  const headers: Record<string, string> = {};
  for (const header of (request["headers"] as Pair[] | undefined) ?? []) {
    if (header.enabled === false || header.name === undefined) continue;
    headers[resolve(header.name)] = resolve(header.value ?? "");
  }

  applyAuth(request, http.auth, headers, resolve, url);

  // An OAuth2 token is fetched by the caller (it needs a browser for one of
  // the grants) and handed in already resolved, so this only has to place it.
  if (deps.token !== undefined) {
    if (deps.token.placement === "url") url.searchParams.set(deps.token.queryKey, deps.token.accessToken);
    else headers["Authorization"] = `${deps.token.headerPrefix} ${deps.token.accessToken}`.trim();
  }

  // The jar is consulted after the request's own headers, and never
  // overrides one the request set by hand: an explicit Cookie header is the
  // author saying what they want sent.
  const jarHeader = deps.jar?.headerFor(url.toString()) ?? "";
  const hasOwnCookie = Object.keys(headers).some((name) => name.toLowerCase() === "cookie");
  if (jarHeader !== "" && !hasOwnCookie) headers["Cookie"] = jarHeader;

  const body = await buildBody(request, http.body, headers, resolve, deps);

  const settings = (request["settings"] ?? {}) as { timeout?: number };
  const network: NetworkOptions = {
    verifyCertificate: options?.verifyCertificate ?? true,
    timeoutMs: typeof settings.timeout === "number" && settings.timeout > 0 ? settings.timeout : (options?.timeoutMs ?? 0),
    ...(options?.proxyUrl === undefined ? {} : { proxyUrl: options.proxyUrl }),
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
      const setCookies = typeof from.headers.getSetCookie === "function" ? from.headers.getSetCookie() : [];
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
    const text = await response.text();
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
      detail: error instanceof Error ? error.message : String(error),
      timeMs: deps.now() - started,
    };
  }
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
      if (field.enabled === false || field.name === undefined) continue;
      form.append(resolve(field.name), resolve(field.value ?? ""));
    }
    return form.toString();
  }
  if (mode === "graphql") {
    defaultContentType("application/json");
    const graphql = (body["graphql"] ?? {}) as { query?: string; variables?: string };
    const query = resolve(graphql.query ?? "");
    const raw = resolve(graphql.variables ?? "").trim();
    let parsed: unknown = undefined;
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
    for (const field of ((body["multipartForm"] as MultipartField[] | undefined) ?? [])) {
      if (field.enabled === false || field.name === undefined) continue;
      const name = resolve(field.name);

      if (field.type === "file") {
        const paths = Array.isArray(field.value) ? field.value : [];
        for (const path of paths) {
          const full = deps.resolvePath?.(resolve(path)) ?? resolve(path);
          const bytes = await deps.readFile?.(full);
          if (bytes === undefined) continue;
          const fileName = full.slice(full.lastIndexOf("/") + 1);
          const FileClass = deps.multipart?.File ?? File;
          form.append(
            name,
            new FileClass([bytes as BlobPart], fileName, {
              ...(field.contentType === undefined || field.contentType === ""
                ? {}
                : { type: field.contentType }),
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
  /** A text field carries a string; a file field carries a list of paths. */
  value?: string | string[];
  enabled?: boolean;
  type?: string;
  contentType?: string;
};
