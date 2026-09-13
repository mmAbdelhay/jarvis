// Postman collection (v2.0/v2.1) to Bruno requests.
//
// Written here rather than taken from @usebruno/converters, whose
// postmanToBruno returns an empty object for valid input without raising —
// a silent failure is worse than no import at all, and this mapping is
// small enough to own.

export type ImportedRequest = {
  /** Path segments below the collection root, ending in the request name. */
  segments: string[];
  json: Record<string, unknown>;
};

export type ImportResult = { name: string; requests: ImportedRequest[] };

type PostmanItem = {
  name?: string;
  item?: PostmanItem[];
  request?: PostmanRequest | string;
};

type PostmanRequest = {
  method?: string;
  url?: string | { raw?: string; query?: { key?: string; value?: string; disabled?: boolean }[] };
  header?: { key?: string; value?: string; disabled?: boolean }[];
  body?: {
    mode?: string;
    raw?: string;
    urlencoded?: { key?: string; value?: string; disabled?: boolean }[];
  };
  auth?: {
    type?: string;
    bearer?: { key?: string; value?: string }[];
    basic?: { key?: string; value?: string }[];
  };
};

/** Postman writes `{{var}}` the same way Bruno does, so variables need no
 *  translation — one of the few places the two formats agree exactly. */
export function postmanToRequests(collection: unknown): ImportResult {
  if (typeof collection !== "object" || collection === null) {
    throw new Error("Not a Postman collection");
  }
  const root = collection as { info?: { name?: string; schema?: string }; item?: PostmanItem[] };
  const schema = root.info?.schema ?? "";
  if (!schema.includes("v2.0") && !schema.includes("v2.1")) {
    throw new Error("Only Postman Collection v2.0 and v2.1 are supported");
  }

  const requests: ImportedRequest[] = [];
  walk(root.item ?? [], [], requests);
  return { name: root.info?.name ?? "imported", requests };
}

function walk(items: PostmanItem[], prefix: string[], out: ImportedRequest[]): void {
  items.forEach((item, index) => {
    const name = item.name ?? `item-${index + 1}`;
    if (Array.isArray(item.item)) {
      walk(item.item, [...prefix, name], out);
      return;
    }
    if (item.request === undefined) return;
    out.push({ segments: [...prefix, name], json: toBruno(name, item.request, index + 1) });
  });
}

function toBruno(
  name: string,
  request: PostmanRequest | string,
  seq: number,
): Record<string, unknown> {
  // Postman allows a bare URL string where a request object would go.
  const source: PostmanRequest =
    typeof request === "string" ? { method: "GET", url: request } : request;
  const rawUrl = typeof source.url === "string" ? source.url : (source.url?.raw ?? "");
  // Bruno keeps query parameters in their own block, so the URL loses them.
  const [base] = rawUrl.split("?");

  const json: Record<string, unknown> = {
    meta: { name, type: "http", seq: String(seq) },
    http: {
      method: (source.method ?? "GET").toLowerCase(),
      url: base ?? "",
      body: bodyMode(source.body?.mode),
      auth: authMode(source.auth?.type),
    },
  };

  const query = typeof source.url === "object" ? (source.url?.query ?? []) : [];
  if (query.length > 0) {
    json["params"] = query.map((param) => ({
      name: param.key ?? "",
      value: param.value ?? "",
      type: "query",
      enabled: param.disabled !== true,
    }));
  }

  if ((source.header ?? []).length > 0) {
    json["headers"] = (source.header ?? []).map((header) => ({
      name: header.key ?? "",
      value: header.value ?? "",
      enabled: header.disabled !== true,
    }));
  }

  const mode = bodyMode(source.body?.mode);
  if (mode === "json" || mode === "text") {
    json["body"] = { [mode]: source.body?.raw ?? "" };
  } else if (mode === "formUrlEncoded") {
    json["body"] = {
      formUrlEncoded: (source.body?.urlencoded ?? []).map((field) => ({
        name: field.key ?? "",
        value: field.value ?? "",
        enabled: field.disabled !== true,
      })),
    };
  }

  const auth = authMode(source.auth?.type);
  if (auth === "bearer") {
    json["auth"] = { bearer: { token: authValue(source.auth?.bearer, "token") } };
  } else if (auth === "basic") {
    json["auth"] = {
      basic: {
        username: authValue(source.auth?.basic, "username"),
        password: authValue(source.auth?.basic, "password"),
      },
    };
  }

  return json;
}

/** Postman stores auth details as a list of {key, value} pairs. */
function authValue(pairs: { key?: string; value?: string }[] | undefined, key: string): string {
  return pairs?.find((pair) => pair.key === key)?.value ?? "";
}

function bodyMode(mode: string | undefined): string {
  if (mode === "raw") return "json";
  if (mode === "urlencoded") return "formUrlEncoded";
  // formdata, file, graphql: no equivalent this importer can honestly
  // produce, so the request arrives without a body rather than with a wrong
  // one.
  return mode === undefined ? "none" : "none";
}

function authMode(type: string | undefined): string {
  if (type === "bearer") return "bearer";
  if (type === "basic") return "basic";
  return "none";
}
