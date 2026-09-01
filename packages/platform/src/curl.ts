import { interpolate } from "./http-runner.js";

// "Copy as cURL": the request as a command someone else can run.
//
// Variables are resolved before the command is produced. A curl line with
// {{base}} still in it is not a command, it is a note — and the point of
// copying one is to hand it to a colleague, a bug report or a shell.

type Pair = { name?: string; value?: string; enabled?: boolean; type?: string };

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
  const http = (request["http"] ?? {}) as { method?: string; url?: string; body?: string; auth?: string };
  const method = (http.method ?? "get").toUpperCase();

  const parts: string[] = ["curl"];
  if (method !== "GET") parts.push("-X", method);

  let url = resolve(http.url ?? "");
  const query = ((request["params"] as Pair[] | undefined) ?? [])
    .filter((param) => param.enabled !== false && (param.type ?? "query") === "query" && param.name)
    .map((param) => `${encodeURIComponent(resolve(param.name ?? ""))}=${encodeURIComponent(resolve(param.value ?? ""))}`);
  if (query.length > 0) url += `${url.includes("?") ? "&" : "?"}${query.join("&")}`;
  parts.push(quote(url));

  for (const header of ((request["headers"] as Pair[] | undefined) ?? [])) {
    if (header.enabled === false || header.name === undefined) continue;
    parts.push("-H", quote(`${resolve(header.name)}: ${resolve(header.value ?? "")}`));
  }

  const auth = (request["auth"] ?? {}) as Record<string, Record<string, string>>;
  if (http.auth === "bearer" && auth["bearer"]?.["token"] !== undefined) {
    parts.push("-H", quote(`Authorization: Bearer ${resolve(auth["bearer"]["token"])}`));
  }
  if (http.auth === "basic") {
    const basic = auth["basic"] ?? {};
    parts.push("-u", quote(`${resolve(basic["username"] ?? "")}:${resolve(basic["password"] ?? "")}`));
  }

  const bodies = (request["body"] ?? {}) as Record<string, unknown>;
  const mode = http.body ?? "none";
  if (mode === "json" || mode === "text" || mode === "xml") {
    parts.push("--data-raw", quote(resolve(String(bodies[mode] ?? ""))));
  } else if (mode === "formUrlEncoded") {
    for (const field of ((bodies["formUrlEncoded"] as Pair[] | undefined) ?? [])) {
      if (field.enabled === false || field.name === undefined) continue;
      parts.push("--data-urlencode", quote(`${resolve(field.name)}=${resolve(field.value ?? "")}`));
    }
  }

  return parts.join(" ");
}
