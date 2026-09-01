import { describe, expect, it } from "vitest";
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
