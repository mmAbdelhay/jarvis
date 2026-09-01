import { describe, expect, it } from "vitest";
import { createCookieJar } from "./cookies.js";
import { interpolate, sendRequest } from "./http-runner.js";

type Captured = { url: string; init: RequestInit };

function harness(
  response: Response | Error = new Response("ok", { status: 200, statusText: "OK" }),
) {
  const captured: Captured[] = [];
  let clock = 1000;
  const deps = {
    fetch: ((url: string, init: RequestInit) => {
      captured.push({ url, init });
      clock += 42;
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    }) as unknown as typeof fetch,
    now: () => clock,
  };
  return { captured, deps };
}

const get = (overrides: Record<string, unknown> = {}) => ({
  meta: { name: "R", type: "http", seq: "1" },
  http: { method: "get", url: "{{base}}/api/orders", body: "none", auth: "none" },
  ...overrides,
});

describe("interpolate", () => {
  it("replaces a known variable", () => {
    expect(interpolate("{{base}}/x", { base: "http://h" })).toEqual({
      text: "http://h/x",
      unresolved: [],
    });
  });

  // A blank is worse than a literal: https:///api is a confusing failure,
  // while {{token}} in the URL says exactly what went wrong.
  it("leaves an unknown variable as its literal and names it", () => {
    expect(interpolate("{{a}}/{{b}}", { a: "1" })).toEqual({ text: "1/{{b}}", unresolved: ["b"] });
  });

  it("names an unresolved variable once however often it appears", () => {
    expect(interpolate("{{b}}{{b}}", {}).unresolved).toEqual(["b"]);
  });

  it("tolerates spaces inside the braces", () => {
    expect(interpolate("{{ base }}", { base: "h" }).text).toBe("h");
  });

  it("leaves text with no variables alone", () => {
    expect(interpolate("plain", {})).toEqual({ text: "plain", unresolved: [] });
  });
});

describe("sendRequest", () => {
  it("interpolates the URL and issues the request", async () => {
    const { captured, deps } = harness();

    await sendRequest(get(), { base: "http://h" }, deps);

    expect(captured[0]?.url).toBe("http://h/api/orders");
    expect(captured[0]?.init.method).toBe("GET");
  });

  it("returns status, body, size and the elapsed time", async () => {
    const { deps } = harness(new Response("hello", { status: 201, statusText: "Created" }));

    const result = await sendRequest(get(), { base: "http://h" }, deps);

    expect(result).toMatchObject({
      status: 201,
      statusText: "Created",
      body: "hello",
      bytes: 5,
      timeMs: 42,
    });
  });

  it("reports variables it could not resolve alongside the response", async () => {
    const { deps } = harness();

    const result = await sendRequest(
      {
        ...get(),
        http: { method: "get", url: "http://h/x", body: "none", auth: "none" },
        headers: [{ name: "Authorization", value: "Bearer {{token}}", enabled: true }],
      },
      {},
      deps,
    );

    expect("unresolved" in result && result.unresolved).toEqual(["token"]);
  });

  // An unresolved variable in the URL leaves nothing that can be sent, and
  // "not a valid URL" would send the reader looking at the URL rather than at
  // the environment they forgot to select.
  it("fails by naming the variable when the URL depends on one", async () => {
    const { captured, deps } = harness();

    const result = await sendRequest(get(), {}, deps);

    expect(result).toEqual({
      failed: true,
      detail: "No value for {{base}} in the URL",
      timeMs: 0,
    });
    expect(captured).toEqual([]);
  });

  it("appends enabled query params and skips disabled ones", async () => {
    const { captured, deps } = harness();

    await sendRequest(
      get({
        params: [
          { name: "page", value: "1", type: "query", enabled: true },
          { name: "debug", value: "1", type: "query", enabled: false },
        ],
      }),
      { base: "http://h" },
      deps,
    );

    expect(captured[0]?.url).toBe("http://h/api/orders?page=1");
  });

  it("keeps query params the URL already carried", async () => {
    const { captured, deps } = harness();

    await sendRequest(
      {
        ...get(),
        http: { method: "get", url: "http://h/x?a=1", body: "none", auth: "none" },
        params: [{ name: "b", value: "2", type: "query", enabled: true }],
      },
      {},
      deps,
    );

    expect(captured[0]?.url).toBe("http://h/x?a=1&b=2");
  });

  it("sends enabled headers and skips disabled ones", async () => {
    const { captured, deps } = harness();

    await sendRequest(
      get({
        headers: [
          { name: "Accept", value: "application/json", enabled: true },
          { name: "X-Off", value: "1", enabled: false },
        ],
      }),
      { base: "http://h" },
      deps,
    );

    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
    expect(headers["X-Off"]).toBeUndefined();
  });

  it("sets bearer auth from the request", async () => {
    const { captured, deps } = harness();

    await sendRequest(
      {
        ...get(),
        http: { method: "get", url: "http://h", body: "none", auth: "bearer" },
        auth: { bearer: { token: "{{token}}" } },
      },
      { token: "abc" },
      deps,
    );

    expect((captured[0]?.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer abc");
  });

  // The editor offers apikey auth; sending nothing for it is a request that
  // looks configured and is not.
  it("sends an API key in a header", async () => {
    const { captured, deps } = harness();

    await sendRequest(
      {
        ...get(),
        http: { method: "get", url: "http://h", body: "none", auth: "apikey" },
        auth: { apikey: { key: "X-API-Key", value: "{{k}}", placement: "header" } },
      },
      { k: "secret" },
      deps,
    );

    expect((captured[0]?.init.headers as Record<string, string>)["X-API-Key"]).toBe("secret");
  });

  it("sends an API key in the query when that is where it belongs", async () => {
    const { captured, deps } = harness();

    await sendRequest(
      {
        ...get(),
        http: { method: "get", url: "http://h/x", body: "none", auth: "apikey" },
        auth: { apikey: { key: "api_key", value: "secret", placement: "queryparams" } },
      },
      {},
      deps,
    );

    expect(captured[0]?.url).toBe("http://h/x?api_key=secret");
  });

  it("sets basic auth as a base64 credential", async () => {
    const { captured, deps } = harness();

    await sendRequest(
      {
        ...get(),
        http: { method: "get", url: "http://h", body: "none", auth: "basic" },
        auth: { basic: { username: "u", password: "p" } },
      },
      {},
      deps,
    );

    const header = (captured[0]?.init.headers as Record<string, string>)["Authorization"];
    expect(header).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  it("sends a JSON body and defaults its content type", async () => {
    const { captured, deps } = harness();

    await sendRequest(
      {
        ...get(),
        http: { method: "post", url: "http://h", body: "json", auth: "none" },
        body: { json: '{"a":{{n}}}' },
      },
      { n: "1" },
      deps,
    );

    expect(captured[0]?.init.body).toBe('{"a":1}');
    expect((captured[0]?.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("does not override a Content-Type the request already set", async () => {
    const { captured, deps } = harness();

    await sendRequest(
      {
        ...get(),
        http: { method: "post", url: "http://h", body: "json", auth: "none" },
        headers: [{ name: "Content-Type", value: "application/vnd.api+json", enabled: true }],
        body: { json: "{}" },
      },
      {},
      deps,
    );

    expect((captured[0]?.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/vnd.api+json",
    );
  });

  it("sends a form body as urlencoded pairs", async () => {
    const { captured, deps } = harness();

    await sendRequest(
      {
        ...get(),
        http: { method: "post", url: "http://h", body: "formUrlEncoded", auth: "none" },
        body: { formUrlEncoded: [{ name: "a", value: "1", enabled: true }] },
      },
      {},
      deps,
    );

    expect(captured[0]?.init.body).toBe("a=1");
  });

  // A 500 is an answer, not a failure: it has a status, a body and a time,
  // and showing it as an error would hide all three.
  it("returns a 500 as a response", async () => {
    const { deps } = harness(new Response("boom", { status: 500, statusText: "Server Error" }));

    const result = await sendRequest(get(), { base: "http://h" }, deps);

    expect(result).toMatchObject({ status: 500, body: "boom" });
  });

  it("returns a network error as a failure carrying its message", async () => {
    const { deps } = harness(new Error("ECONNREFUSED"));

    const result = await sendRequest(get(), { base: "http://h" }, deps);

    expect(result).toEqual({ failed: true, detail: "ECONNREFUSED", timeMs: 42 });
  });

  it("refuses a URL that is not a URL, without calling fetch", async () => {
    const { captured, deps } = harness();

    const result = await sendRequest(
      { ...get(), http: { method: "get", url: "not a url", body: "none", auth: "none" } },
      {},
      deps,
    );

    expect("failed" in result).toBe(true);
    expect(captured).toEqual([]);
  });
});

describe("sendRequest: graphql, files, cookies and network options", () => {
  it("sends a GraphQL query and its variables as one JSON body", async () => {
    const { captured, deps } = harness();

    await sendRequest(
      {
        ...get(),
        http: { method: "post", url: "http://h/graphql", body: "graphql", auth: "none" },
        body: { graphql: { query: "{ user(id: {{id}}) { name } }", variables: '{"a":1}' } },
      },
      { id: "7" },
      deps,
    );

    expect(JSON.parse(String(captured[0]?.init.body))).toEqual({
      query: "{ user(id: 7) { name } }",
      variables: { a: 1 },
    });
    expect((captured[0]?.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("omits variables entirely when there are none", async () => {
    const { captured, deps } = harness();

    await sendRequest(
      {
        ...get(),
        http: { method: "post", url: "http://h/graphql", body: "graphql", auth: "none" },
        body: { graphql: { query: "{ a }", variables: "" } },
      },
      {},
      deps,
    );

    expect(JSON.parse(String(captured[0]?.init.body))).toEqual({ query: "{ a }" });
  });

  it("uploads a file in a multipart body", async () => {
    const { captured, deps } = harness();
    const read: string[] = [];

    await sendRequest(
      {
        ...get(),
        http: { method: "post", url: "http://h/upload", body: "multipartForm", auth: "none" },
        body: {
          multipartForm: [
            { name: "note", value: "hello", type: "text", enabled: true },
            { name: "doc", value: ["./a.txt"], type: "file", enabled: true, contentType: "text/plain" },
          ],
        },
      },
      {},
      {
        ...deps,
        resolvePath: (path) => `/collection/${path}`,
        readFile: (path) => {
          read.push(path);
          return Promise.resolve(new TextEncoder().encode("file body"));
        },
      },
    );

    const form = captured[0]?.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("note")).toBe("hello");
    const file = form.get("doc") as File;
    expect(file.name).toBe("a.txt");
    expect(await file.text()).toBe("file body");
    expect(read).toEqual(["/collection/./a.txt"]);
  });

  // The boundary is FormData's to choose; any Content-Type set by hand would
  // be wrong and would break the request.
  it("drops a hand-set Content-Type for a multipart body", async () => {
    const { captured, deps } = harness();

    await sendRequest(
      {
        ...get(),
        http: { method: "post", url: "http://h", body: "multipartForm", auth: "none" },
        headers: [{ name: "Content-Type", value: "multipart/form-data", enabled: true }],
        body: { multipartForm: [{ name: "a", value: "1", type: "text", enabled: true }] },
      },
      {},
      deps,
    );

    expect((captured[0]?.init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("sends the jar's cookies and stores what came back", async () => {
    const response = new Response("ok", { status: 200 });
    response.headers.append("set-cookie", "sid=new; Path=/");
    const { captured, deps } = harness(response);
    const jar = createCookieJar();
    jar.store("http://h/", ["existing=1; Path=/"]);

    await sendRequest(
      { ...get(), http: { method: "get", url: "http://h/x", body: "none", auth: "none" } },
      {},
      { ...deps, jar },
    );

    expect((captured[0]?.init.headers as Record<string, string>)["Cookie"]).toBe("existing=1");
    expect(jar.headerFor("http://h/")).toContain("sid=new");
  });

  // An explicit Cookie header is the author saying what they want sent.
  it("never overrides a Cookie header the request set itself", async () => {
    const { captured, deps } = harness();
    const jar = createCookieJar();
    jar.store("http://h/", ["sid=jar; Path=/"]);

    await sendRequest(
      {
        ...get(),
        http: { method: "get", url: "http://h/x", body: "none", auth: "none" },
        headers: [{ name: "Cookie", value: "sid=mine", enabled: true }],
      },
      {},
      { ...deps, jar },
    );

    expect((captured[0]?.init.headers as Record<string, string>)["Cookie"]).toBe("sid=mine");
  });

  it("passes a dispatcher built from the network options", async () => {
    const { captured, deps } = harness();
    const seen: unknown[] = [];

    await sendRequest(get(), { base: "http://h" }, {
      ...deps,
      dispatcherFor: (options) => {
        seen.push(options);
        return { marker: true };
      },
    }, { verifyCertificate: false, timeoutMs: 5000, proxyUrl: "http://proxy:8080" });

    expect(seen).toEqual([{ verifyCertificate: false, timeoutMs: 5000, proxyUrl: "http://proxy:8080" }]);
    expect((captured[0]?.init as Record<string, unknown>)["dispatcher"]).toEqual({ marker: true });
  });

  // A request's own timeout setting is more specific than the global one.
  it("prefers the request's own timeout over the global one", async () => {
    const { deps } = harness();
    const seen: { timeoutMs: number }[] = [];

    await sendRequest({ ...get(), settings: { timeout: 250 } }, { base: "http://h" }, {
      ...deps,
      dispatcherFor: (options) => {
        seen.push(options);
        return undefined;
      },
    }, { verifyCertificate: true, timeoutMs: 9000 });

    expect(seen[0]?.timeoutMs).toBe(250);
  });

  it("places an OAuth2 token in the Authorization header", async () => {
    const { captured, deps } = harness();

    await sendRequest(
      { ...get(), http: { method: "get", url: "http://h", body: "none", auth: "oauth2" } },
      {},
      {
        ...deps,
        token: { accessToken: "t0ken", placement: "header", headerPrefix: "Bearer", queryKey: "access_token" },
      },
    );

    expect((captured[0]?.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer t0ken");
  });

  it("places an OAuth2 token in the query when the provider wants it there", async () => {
    const { captured, deps } = harness();

    await sendRequest(
      { ...get(), http: { method: "get", url: "http://h/x", body: "none", auth: "oauth2" } },
      {},
      { ...deps, token: { accessToken: "t0ken", placement: "url", headerPrefix: "Bearer", queryKey: "tok" } },
    );

    expect(captured[0]?.url).toBe("http://h/x?tok=t0ken");
  });

  it("attaches an abort signal when there is a timeout", async () => {
    const { captured, deps } = harness();

    await sendRequest(get(), { base: "http://h" }, deps, { verifyCertificate: true, timeoutMs: 1000 });

    expect((captured[0]?.init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});

describe("sendRequest: redirects and the cookie jar", () => {
  /** A fetch that answers a scripted sequence, recording each call. */
  function chain(responses: Response[]) {
    const captured: { url: string; init: RequestInit }[] = [];
    let index = 0;
    return {
      captured,
      deps: {
        fetch: ((url: string, init: RequestInit) => {
          captured.push({ url, init });
          return Promise.resolve(responses[index++] ?? new Response("done", { status: 200 }));
        }) as unknown as typeof fetch,
        now: () => 0,
      },
    };
  }

  function redirect(to: string, status = 302, setCookie?: string): Response {
    const response = new Response(null, { status, headers: { location: to } });
    if (setCookie !== undefined) response.headers.append("set-cookie", setCookie);
    return response;
  }

  // The bug this exists for: a login endpoint answers 302 with Set-Cookie,
  // fetch follows it silently, and the cookie is set on a response nobody
  // ever sees — the jar stays empty and the next request is anonymous.
  it("stores a cookie set on a redirect, not only on the final response", async () => {
    const { deps } = chain([redirect("https://api.test/home", 302, "sid=abc; Path=/")]);
    const jar = createCookieJar();

    await sendRequest(
      { meta: {}, http: { method: "get", url: "https://api.test/login", body: "none", auth: "none" } },
      {},
      { ...deps, jar },
    );

    expect(jar.headerFor("https://api.test/home")).toBe("sid=abc");
  });

  it("sends the cookie it just received on the next hop", async () => {
    const { captured, deps } = chain([redirect("https://api.test/home", 302, "sid=abc; Path=/")]);

    await sendRequest(
      { meta: {}, http: { method: "get", url: "https://api.test/login", body: "none", auth: "none" } },
      {},
      { ...deps, jar: createCookieJar() },
    );

    expect(captured[1]?.url).toBe("https://api.test/home");
    expect((captured[1]?.init.headers as Record<string, string>)["Cookie"]).toBe("sid=abc");
  });

  // What every browser does, and what an API that redirects after a POST
  // expects.
  it("turns a redirected POST into a GET with no body", async () => {
    const { captured, deps } = chain([redirect("https://api.test/done", 303)]);

    await sendRequest(
      {
        meta: {},
        http: { method: "post", url: "https://api.test/submit", body: "json", auth: "none" },
        body: { json: '{"a":1}' },
      },
      {},
      { ...deps, jar: createCookieJar() },
    );

    expect(captured[1]?.init.method).toBe("GET");
    expect(captured[1]?.init.body).toBeUndefined();
  });

  it("resolves a relative Location against the URL it came from", async () => {
    const { captured, deps } = chain([redirect("/v2/orders")]);

    await sendRequest(
      { meta: {}, http: { method: "get", url: "https://api.test/v1/orders", body: "none", auth: "none" } },
      {},
      { ...deps, jar: createCookieJar() },
    );

    expect(captured[1]?.url).toBe("https://api.test/v2/orders");
  });

  // A loop must stop rather than run until the timeout.
  it("gives up after ten hops", async () => {
    const { captured, deps } = chain(
      Array.from({ length: 20 }, () => redirect("https://api.test/loop")),
    );

    await sendRequest(
      { meta: {}, http: { method: "get", url: "https://api.test/loop", body: "none", auth: "none" } },
      {},
      { ...deps, jar: createCookieJar() },
    );

    expect(captured).toHaveLength(11);
  });

  it("leaves redirect handling to fetch when there is no jar", async () => {
    const { captured, deps } = chain([new Response("ok", { status: 200 })]);

    await sendRequest(
      { meta: {}, http: { method: "get", url: "https://api.test/x", body: "none", auth: "none" } },
      {},
      deps,
    );

    expect((captured[0]?.init as RequestInit).redirect).toBeUndefined();
  });

  // The other bug live testing found: a multipart body built from a different
  // realm's FormData is not recognised as one — it is stringified, and the
  // request goes out as text/plain with no fields in it.
  it("builds the multipart body with the classes the caller supplied", async () => {
    const { captured, deps } = chain([new Response("ok")]);
    class TaggedFormData extends FormData {}

    await sendRequest(
      {
        meta: {},
        http: { method: "post", url: "https://api.test/upload", body: "multipartForm", auth: "none" },
        body: { multipartForm: [{ name: "a", value: "1", type: "text", enabled: true }] },
      },
      {},
      { ...deps, multipart: { FormData: TaggedFormData, File } },
    );

    expect(captured[0]?.init.body).toBeInstanceOf(TaggedFormData);
  });
});
