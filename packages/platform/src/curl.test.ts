import { describe, expect, it } from "vitest";
import { toCurl } from "./curl.js";

const request = (overrides: Record<string, unknown> = {}) => ({
  meta: { name: "R" },
  http: { method: "get", url: "{{base}}/orders", body: "none", auth: "none" },
  ...overrides,
});

describe("toCurl", () => {
  it("resolves variables, because a command with {{base}} in it is not a command", () => {
    expect(toCurl(request(), { base: "http://h" })).toBe("curl 'http://h/orders'");
  });

  it("names a method other than GET", () => {
    const command = toCurl(
      request({ http: { method: "post", url: "http://h", body: "none", auth: "none" } }),
      {},
    );
    expect(command).toContain("-X POST");
  });

  it("appends enabled query params and skips disabled ones", () => {
    const command = toCurl(
      request({
        params: [
          { name: "page", value: "1", type: "query", enabled: true },
          { name: "off", value: "1", type: "query", enabled: false },
        ],
      }),
      { base: "http://h" },
    );
    expect(command).toContain("http://h/orders?page=1");
    expect(command).not.toContain("off");
  });

  it("adds headers", () => {
    const command = toCurl(
      request({ headers: [{ name: "Accept", value: "application/json", enabled: true }] }),
      {},
    );
    expect(command).toContain("-H 'Accept: application/json'");
  });

  it("adds bearer and basic auth", () => {
    expect(
      toCurl(
        request({
          http: { method: "get", url: "http://h", body: "none", auth: "bearer" },
          auth: { bearer: { token: "{{t}}" } },
        }),
        { t: "abc" },
      ),
    ).toContain("-H 'Authorization: Bearer abc'");

    expect(
      toCurl(
        request({
          http: { method: "get", url: "http://h", body: "none", auth: "basic" },
          auth: { basic: { username: "u", password: "p" } },
        }),
        {},
      ),
    ).toContain("-u 'u:p'");
  });

  it("adds an API key header", () => {
    expect(
      toCurl(
        request({
          http: { method: "get", url: "http://h", body: "none", auth: "apikey" },
          auth: { apikey: { key: "X-API-Key", value: "{{k}}", placement: "header" } },
        }),
        { k: "secret" },
      ),
    ).toContain("-H 'X-API-Key: secret'");
  });

  // A cURL command that quietly drops the body is not the request.
  it("includes a GraphQL body", () => {
    const command = toCurl(
      request({
        http: { method: "post", url: "http://h/graphql", body: "graphql", auth: "none" },
        body: { graphql: { query: "{ a }", variables: '{"b":1}' } },
      }),
      {},
    );

    expect(command).toContain("--data-raw");
    expect(command).toContain("{ a }");
  });

  it("names each file of a multipart body with -F", () => {
    const command = toCurl(
      request({
        http: { method: "post", url: "http://h/upload", body: "multipartForm", auth: "none" },
        body: {
          multipartForm: [
            { name: "note", value: "hi", type: "text", enabled: true },
            { name: "doc", value: ["/tmp/a.pdf"], type: "file", enabled: true },
          ],
        },
      }),
      {},
    );

    expect(command).toContain("-F 'note=hi'");
    expect(command).toContain("-F 'doc=@/tmp/a.pdf'");
  });

  // Minor (review): a remote call's own multipart value is a staged
  // upload-id reference, never a path — resolve() would have nothing to
  // interpolate and nothing on this machine to point `@` at, so the
  // command says so instead of naming a file that was never here.
  it("names an uploaded file's copied cURL part with a placeholder, not a path", () => {
    const command = toCurl(
      request({
        http: { method: "post", url: "http://h/upload", body: "multipartForm", auth: "none" },
        body: {
          multipartForm: [
            { name: "doc", value: [{ uploadId: "a".repeat(32) }], type: "file", enabled: true },
          ],
        },
      }),
      {},
    );

    expect(command).toContain("-F 'doc=@file(<uploaded>)'");
  });

  it("adds a raw body and a form body", () => {
    expect(
      toCurl(
        request({
          http: { method: "post", url: "http://h", body: "json", auth: "none" },
          body: { json: '{"a":1}' },
        }),
        {},
      ),
    ).toContain(`--data-raw '{"a":1}'`);

    expect(
      toCurl(
        request({
          http: { method: "post", url: "http://h", body: "formUrlEncoded", auth: "none" },
          body: { formUrlEncoded: [{ name: "a", value: "1", enabled: true }] },
        }),
        {},
      ),
    ).toContain("--data-urlencode 'a=1'");
  });

  // A single quote inside a single-quoted shell string ends the string; the
  // command would be broken, or worse, still run.
  it("escapes a single quote in a value", () => {
    const command = toCurl(
      request({
        http: { method: "post", url: "http://h", body: "json", auth: "none" },
        body: { json: `{"a":"it's"}` },
      }),
      {},
    );
    expect(command).toContain(`'{"a":"it'\\''s"}'`);
  });
});
