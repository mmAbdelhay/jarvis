import { interpolate, withScheme } from "./http-runner.js";

// "Copy as cURL" — and as fetch or Python: the request as code someone else
// can run.
//
// Variables are resolved before the code is produced. A curl line with
// {{base}} still in it is not a command, it is a note — and the point of
// copying one is to hand it to a colleague, a bug report or a shell.
//
// Every language is emitted from one resolved request (resolveRequest), so
// what counts as a header, where an API key goes and how a body is sent
// are decided once; the emitters only spell it.

type Pair = { name?: string; value?: string; enabled?: boolean; type?: string };

type MultipartField = {
  name?: string;
  // Minor (review): a remote call's own multipart file value (Task 4) is
  // never a path — it is one of this device's own staged upload-id
  // references — so a file field's value can be either shape, same as
  // http-runner.ts's own MultipartField.
  value?: string | (string | { uploadId: string })[];
  enabled?: boolean;
  type?: string;
};

export type SnippetLanguage = "curl" | "fetch" | "python";

/** A request with every variable resolved and every option decided. */
export type ResolvedRequest = {
  method: string;
  url: string;
  headers: [string, string][];
  basic?: { username: string; password: string };
  body?:
    | { kind: "raw"; text: string }
    | { kind: "form"; fields: [string, string][] }
    | {
        kind: "multipart";
        fields: { name: string; value: string; file: boolean }[];
      };
};

/** Marks a multipart file a remote device uploaded: there is no local path
 *  for the copied code to read, so it names the fact rather than failing
 *  later against a file that was never on this machine. */
const UPLOADED = "<uploaded>";

export function resolveRequest(
  request: Record<string, unknown>,
  variables: Record<string, string> = {},
): ResolvedRequest {
  const resolve = (text: string): string => interpolate(text, variables).text;
  const http = (request["http"] ?? {}) as {
    method?: string;
    url?: string;
    body?: string;
    auth?: string;
  };
  const method = (http.method ?? "get").toUpperCase();

  let url = withScheme(resolve(http.url ?? "").trim());
  const query = ((request["params"] as Pair[] | undefined) ?? [])
    .filter(
      (param) =>
        param.enabled !== false &&
        (param.type ?? "query") === "query" &&
        (param.name ?? "").trim() !== "",
    )
    .map(
      (param) =>
        `${encodeURIComponent(resolve(param.name ?? ""))}=${encodeURIComponent(resolve(param.value ?? ""))}`,
    );
  if (query.length > 0) url += `${url.includes("?") ? "&" : "?"}${query.join("&")}`;

  const headers: [string, string][] = [];
  for (const header of (request["headers"] as Pair[] | undefined) ?? []) {
    if (header.enabled === false || (header.name ?? "").trim() === "") continue;
    headers.push([resolve(header.name ?? ""), resolve(header.value ?? "")]);
  }

  const resolved: ResolvedRequest = { method, url, headers };
  const auth = (request["auth"] ?? {}) as Record<string, Record<string, string>>;
  if (http.auth === "bearer" && auth["bearer"]?.["token"] !== undefined) {
    headers.push(["Authorization", `Bearer ${resolve(auth["bearer"]["token"])}`]);
  }
  if (http.auth === "basic") {
    const basic = auth["basic"] ?? {};
    resolved.basic = {
      username: resolve(basic["username"] ?? ""),
      password: resolve(basic["password"] ?? ""),
    };
  }
  if (http.auth === "apikey") {
    const apikey = auth["apikey"] ?? {};
    const key = resolve(apikey["key"] ?? "");
    if (key !== "") {
      const value = resolve(apikey["value"] ?? "");
      if (apikey["placement"] === "queryparams" || apikey["placement"] === "query") {
        resolved.url += `${resolved.url.includes("?") ? "&" : "?"}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      } else {
        headers.push([key, value]);
      }
    }
  }

  const bodies = (request["body"] ?? {}) as Record<string, unknown>;
  const mode = http.body ?? "none";
  if (mode === "json" || mode === "text" || mode === "xml") {
    resolved.body = { kind: "raw", text: resolve(String(bodies[mode] ?? "")) };
  } else if (mode === "graphql") {
    const graphql = (bodies["graphql"] ?? {}) as { query?: string; variables?: string };
    const raw = resolve(graphql.variables ?? "").trim();
    let graphqlVariables: unknown;
    if (raw !== "") {
      try {
        graphqlVariables = JSON.parse(raw);
      } catch {
        graphqlVariables = raw;
      }
    }
    resolved.body = {
      kind: "raw",
      text: JSON.stringify({
        query: resolve(graphql.query ?? ""),
        ...(graphqlVariables === undefined ? {} : { variables: graphqlVariables }),
      }),
    };
  } else if (mode === "formUrlEncoded") {
    const fields: [string, string][] = [];
    for (const field of (bodies["formUrlEncoded"] as Pair[] | undefined) ?? []) {
      if (field.enabled === false || field.name === undefined) continue;
      fields.push([resolve(field.name), resolve(field.value ?? "")]);
    }
    resolved.body = { kind: "form", fields };
  } else if (mode === "multipartForm") {
    const fields: { name: string; value: string; file: boolean }[] = [];
    for (const field of (bodies["multipartForm"] as MultipartField[] | undefined) ?? []) {
      if (field.enabled === false || field.name === undefined) continue;
      const name = resolve(field.name);
      if (field.type === "file") {
        for (const path of Array.isArray(field.value) ? field.value : []) {
          fields.push({
            name,
            value: typeof path === "string" ? resolve(path) : UPLOADED,
            file: true,
          });
        }
        continue;
      }
      fields.push({
        name,
        value: resolve(typeof field.value === "string" ? field.value : ""),
        file: false,
      });
    }
    resolved.body = { kind: "multipart", fields };
  }
  return resolved;
}

/** Single-quotes for a POSIX shell, the only quoting that needs no escape
 *  table: everything inside is literal except the quote itself. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function emitCurl(request: ResolvedRequest): string {
  const parts: string[] = ["curl"];
  if (request.method !== "GET") parts.push("-X", request.method);
  parts.push(quote(request.url));
  for (const [name, value] of request.headers) parts.push("-H", quote(`${name}: ${value}`));
  if (request.basic !== undefined) {
    parts.push("-u", quote(`${request.basic.username}:${request.basic.password}`));
  }
  const body = request.body;
  if (body?.kind === "raw") parts.push("--data-raw", quote(body.text));
  if (body?.kind === "form") {
    for (const [name, value] of body.fields)
      parts.push("--data-urlencode", quote(`${name}=${value}`));
  }
  if (body?.kind === "multipart") {
    // curl's own @-syntax for a file, so the command uploads the same file
    // this request would.
    for (const field of body.fields) {
      const value = field.file
        ? field.value === UPLOADED
          ? "@file(<uploaded>)"
          : `@${field.value}`
        : field.value;
      parts.push("-F", quote(`${field.name}=${value}`));
    }
  }
  return parts.join(" ");
}

/** A JavaScript/Python string literal: JSON's own escaping is valid in both. */
const literal = (value: string): string => JSON.stringify(value);

function basicHeader(basic: { username: string; password: string }): [string, string] {
  return [
    "Authorization",
    `Basic ${Buffer.from(`${basic.username}:${basic.password}`).toString("base64")}`,
  ];
}

function emitFetch(request: ResolvedRequest): string {
  const headers = [...request.headers];
  if (request.basic !== undefined) headers.push(basicHeader(request.basic));
  const lines: string[] = [];
  const body = request.body;
  if (body?.kind === "form") {
    lines.push("const body = new URLSearchParams();");
    for (const [name, value] of body.fields)
      lines.push(`body.append(${literal(name)}, ${literal(value)});`);
  }
  if (body?.kind === "multipart") {
    lines.push("const body = new FormData();");
    for (const field of body.fields) {
      lines.push(
        field.file
          ? `body.append(${literal(field.name)}, await fileFrom(${literal(field.value)})); // a file to upload`
          : `body.append(${literal(field.name)}, ${literal(field.value)});`,
      );
    }
  }
  const options: string[] = [`  method: ${literal(request.method)},`];
  if (headers.length > 0) {
    options.push("  headers: {");
    for (const [name, value] of headers) options.push(`    ${literal(name)}: ${literal(value)},`);
    options.push("  },");
  }
  if (body?.kind === "raw") options.push(`  body: ${literal(body.text)},`);
  if (body?.kind === "form" || body?.kind === "multipart") options.push("  body,");
  lines.push(`const response = await fetch(${literal(request.url)}, {`, ...options, "});");
  lines.push("console.log(response.status, await response.text());");
  return lines.join("\n");
}

function emitPython(request: ResolvedRequest): string {
  const lines = ["import requests", ""];
  const args = [`    ${literal(request.method)},`, `    ${literal(request.url)},`];
  if (request.headers.length > 0) {
    args.push("    headers={");
    for (const [name, value] of request.headers)
      args.push(`        ${literal(name)}: ${literal(value)},`);
    args.push("    },");
  }
  if (request.basic !== undefined) {
    args.push(`    auth=(${literal(request.basic.username)}, ${literal(request.basic.password)}),`);
  }
  const body = request.body;
  if (body?.kind === "raw") args.push(`    data=${literal(body.text)}.encode("utf-8"),`);
  if (body?.kind === "form") {
    args.push("    data={");
    for (const [name, value] of body.fields)
      args.push(`        ${literal(name)}: ${literal(value)},`);
    args.push("    },");
  }
  if (body?.kind === "multipart") {
    const plain = body.fields.filter((field) => !field.file);
    const files = body.fields.filter((field) => field.file);
    if (plain.length > 0) {
      args.push("    data={");
      for (const field of plain)
        args.push(`        ${literal(field.name)}: ${literal(field.value)},`);
      args.push("    },");
    }
    if (files.length > 0) {
      args.push("    files=[");
      for (const field of files) {
        args.push(`        (${literal(field.name)}, open(${literal(field.value)}, "rb")),`);
      }
      args.push("    ],");
    }
  }
  lines.push(
    "response = requests.request(",
    ...args,
    ")",
    "print(response.status_code, response.text)",
  );
  return lines.join("\n");
}

export function toCurl(
  request: Record<string, unknown>,
  variables: Record<string, string> = {},
): string {
  return emitCurl(resolveRequest(request, variables));
}

/** The request as code in `language` — cURL, JavaScript fetch, or Python
 *  requests — built from the same resolved request. */
export function toSnippet(
  request: Record<string, unknown>,
  variables: Record<string, string> = {},
  language: SnippetLanguage = "curl",
): string {
  const resolved = resolveRequest(request, variables);
  if (language === "fetch") return emitFetch(resolved);
  if (language === "python") return emitPython(resolved);
  return emitCurl(resolved);
}
