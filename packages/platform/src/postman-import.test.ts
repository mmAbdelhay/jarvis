import { describe, expect, it } from "vitest";
import { postmanToRequests } from "./postman-import.js";

const collection = (items: unknown[]) => ({
  info: {
    name: "Demo",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  item: items,
});

describe("postmanToRequests", () => {
  it("refuses anything that is not a supported collection", () => {
    expect(() => postmanToRequests({ info: { schema: "v1" } })).toThrow("v2.0 and v2.1");
    expect(() => postmanToRequests("nope")).toThrow("Not a Postman collection");
  });

  it("converts a request, splitting the query out of the URL", () => {
    const { name, requests } = postmanToRequests(
      collection([
        {
          name: "Get user",
          request: {
            method: "GET",
            url: { raw: "https://api.test/users?page=1", query: [{ key: "page", value: "1" }] },
            header: [{ key: "Accept", value: "application/json" }],
          },
        },
      ]),
    );

    expect(name).toBe("Demo");
    expect(requests[0]?.segments).toEqual(["Get user"]);
    expect(requests[0]?.json["http"]).toMatchObject({
      method: "get",
      url: "https://api.test/users",
    });
    expect(requests[0]?.json["params"]).toEqual([
      { name: "page", value: "1", type: "query", enabled: true },
    ]);
    expect(requests[0]?.json["headers"]).toEqual([
      { name: "Accept", value: "application/json", enabled: true },
    ]);
  });

  it("keeps folder structure as path segments", () => {
    const { requests } = postmanToRequests(
      collection([
        {
          name: "Orders",
          item: [{ name: "List", request: { method: "GET", url: "https://api.test/o" } }],
        },
      ]),
    );

    expect(requests[0]?.segments).toEqual(["Orders", "List"]);
  });

  it("carries a raw body across as json", () => {
    const { requests } = postmanToRequests(
      collection([
        {
          name: "Create",
          request: {
            method: "POST",
            url: "https://api.test/o",
            body: { mode: "raw", raw: '{"a":1}' },
          },
        },
      ]),
    );

    expect(requests[0]?.json["http"]).toMatchObject({ method: "post", body: "json" });
    expect(requests[0]?.json["body"]).toEqual({ json: '{"a":1}' });
  });

  it("carries a urlencoded body across", () => {
    const { requests } = postmanToRequests(
      collection([
        {
          name: "Form",
          request: {
            method: "POST",
            url: "https://api.test/f",
            body: { mode: "urlencoded", urlencoded: [{ key: "a", value: "1", disabled: true }] },
          },
        },
      ]),
    );

    expect(requests[0]?.json["body"]).toEqual({
      formUrlEncoded: [{ name: "a", value: "1", enabled: false }],
    });
  });

  it("carries bearer and basic auth across", () => {
    const { requests } = postmanToRequests(
      collection([
        {
          name: "B",
          request: {
            method: "GET",
            url: "https://api.test",
            auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}" }] },
          },
        },
        {
          name: "A",
          request: {
            method: "GET",
            url: "https://api.test",
            auth: {
              type: "basic",
              basic: [
                { key: "username", value: "u" },
                { key: "password", value: "p" },
              ],
            },
          },
        },
      ]),
    );

    expect(requests[0]?.json["auth"]).toEqual({ bearer: { token: "{{token}}" } });
    expect(requests[1]?.json["auth"]).toEqual({ basic: { username: "u", password: "p" } });
  });

  it("accepts a bare URL string where a request object would go", () => {
    const { requests } = postmanToRequests(
      collection([{ name: "Bare", request: "https://api.test/x" }]),
    );

    expect(requests[0]?.json["http"]).toMatchObject({ method: "get", url: "https://api.test/x" });
  });

  // A body shape this importer cannot honestly produce must arrive as no
  // body rather than as a wrong one.
  it("drops a body mode it cannot represent instead of guessing", () => {
    const { requests } = postmanToRequests(
      collection([
        {
          name: "F",
          request: { method: "POST", url: "https://api.test", body: { mode: "formdata" } },
        },
      ]),
    );

    expect(requests[0]?.json["http"]).toMatchObject({ body: "none" });
    expect(requests[0]?.json["body"]).toBeUndefined();
  });

  it("names an unnamed item rather than dropping it", () => {
    const { requests } = postmanToRequests(collection([{ request: "https://api.test/x" }]));

    expect(requests[0]?.segments).toEqual(["item-1"]);
  });
});
