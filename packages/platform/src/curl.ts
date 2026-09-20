import { interpolate, withScheme } from "./http-runner.js";

// "Copy as cURL": the request as a command someone else can run.
//
// Variables are resolved before the command is produced. A curl line with
// {{base}} still in it is not a command, it is a note — and the point of
// copying one is to hand it to a colleague, a bug report or a shell.

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

/** Single-quotes for a POSIX shell, the only quoting that needs no escape
 *  table: everything inside is literal except the quote itself. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function toCurl(
  request: Record<string, unknown>,
  variables: Record<string, string> = {},
): string {
  const resolve = (text: string): string => interpolate(text, variables).text;
  const http = (request["http"] ?? {}) as {
    method?: string;
    url?: string;
    body?: string;
    auth?: string;
  };
  const method = (http.method ?? "get").toUpperCase();

  const parts: string[] = ["curl"];
  if (method !== "GET") parts.push("-X", method);

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
  parts.push(quote(url));

  for (const header of (request["headers"] as Pair[] | undefined) ?? []) {
    if (header.enabled === false || (header.name ?? "").trim() === "") continue;
    parts.push("-H", quote(`${resolve(header.name ?? "")}: ${resolve(header.value ?? "")}`));
  }

  const auth = (request["auth"] ?? {}) as Record<string, Record<string, string>>;
  if (http.auth === "bearer" && auth["bearer"]?.["token"] !== undefined) {
    parts.push("-H", quote(`Authorization: Bearer ${resolve(auth["bearer"]["token"])}`));
  }
  if (http.auth === "basic") {
    const basic = auth["basic"] ?? {};
    parts.push(
      "-u",
      quote(`${resolve(basic["username"] ?? "")}:${resolve(basic["password"] ?? "")}`),
    );
  }

  if (http.auth === "apikey") {
    const apikey = auth["apikey"] ?? {};
    const key = resolve(apikey["key"] ?? "");
    if (key !== "") {
      const value = resolve(apikey["value"] ?? "");
      // The query placement is already on the URL above only if it was a
      // param; an apikey in the query has to be added here.
      if (apikey["placement"] === "queryparams" || apikey["placement"] === "query") {
        const at = parts.lastIndexOf(quote(url));
        url += `${url.includes("?") ? "&" : "?"}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
        if (at !== -1) parts[at] = quote(url);
      } else {
        parts.push("-H", quote(`${key}: ${value}`));
      }
    }
  }

  const bodies = (request["body"] ?? {}) as Record<string, unknown>;
  const mode = http.body ?? "none";
  if (mode === "json" || mode === "text" || mode === "xml") {
    parts.push("--data-raw", quote(resolve(String(bodies[mode] ?? ""))));
  } else if (mode === "graphql") {
    const graphql = (bodies["graphql"] ?? {}) as { query?: string; variables?: string };
    const raw = resolve(graphql.variables ?? "").trim();
    let variables: unknown;
    if (raw !== "") {
      try {
        variables = JSON.parse(raw);
      } catch {
        variables = raw;
      }
    }
    const payload = {
      query: resolve(graphql.query ?? ""),
      ...(variables === undefined ? {} : { variables }),
    };
    parts.push("--data-raw", quote(JSON.stringify(payload)));
  } else if (mode === "formUrlEncoded") {
    for (const field of (bodies["formUrlEncoded"] as Pair[] | undefined) ?? []) {
      if (field.enabled === false || field.name === undefined) continue;
      parts.push("--data-urlencode", quote(`${resolve(field.name)}=${resolve(field.value ?? "")}`));
    }
  } else if (mode === "multipartForm") {
    // curl's own @-syntax for a file, so the command uploads the same file
    // this request would.
    for (const field of (bodies["multipartForm"] as MultipartField[] | undefined) ?? []) {
      if (field.enabled === false || field.name === undefined) continue;
      const name = resolve(field.name);
      if (field.type === "file") {
        for (const path of Array.isArray(field.value) ? field.value : []) {
          // A remote call's own upload-id reference: there is no local path
          // this command could read (that is the whole point — see Task
          // 4's remote-api.ts), so the copied command names the fact
          // plainly rather than producing a curl line that fails against a
          // file that was never on this machine.
          const part = typeof path === "string" ? `@${resolve(path)}` : "@file(<uploaded>)";
          parts.push("-F", quote(`${name}=${part}`));
        }
        continue;
      }
      parts.push(
        "-F",
        quote(`${name}=${resolve(typeof field.value === "string" ? field.value : "")}`),
      );
    }
  }

  return parts.join(" ");
}
