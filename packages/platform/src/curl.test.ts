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
    const command = toCurl(request({ headers: [{ name: "Accept", value: "application/json", enabled: true }] }), {});
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
