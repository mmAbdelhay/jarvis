// Issues a Bruno request and reports what came back.
//
// This runs in the main process, and that is the whole point: a request
// leaves here as an ordinary Node fetch, not from a browser origin, so CORS
// — the reason a hosted API client cannot call a project's endpoints, and
// the reason Postman is a native app — never enters into it.
//
// fetch and the clock are injected so every behaviour below is testable
// without a network or a real elapsed millisecond.

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

export type SendDeps = { fetch: typeof fetch; now: () => number };

type Pair = { name?: string; value?: string; enabled?: boolean };

const VARIABLE = /\{\{\s*([^}\s]+)\s*\}\}/g;

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

  applyAuth(request, http.auth, headers, resolve);
  const body = buildBody(request, http.body, headers, resolve);

  try {
    const response = await deps.fetch(url.toString(), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
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
  }
}

function buildBody(
  request: Record<string, unknown>,
  mode: string | undefined,
  headers: Record<string, string>,
  resolve: (text: string) => string,
): string | undefined {
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
  // Anything else (multipart, file, graphql) is out of scope for now and is
  // sent as nothing rather than as a guess.
  return undefined;
}
