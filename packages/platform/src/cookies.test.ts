import { describe, expect, it } from "vitest";
import { createCookieJar, parseSetCookie } from "./cookies.js";

describe("parseSetCookie", () => {
  it("reads a name, value and defaults", () => {
    const cookie = parseSetCookie("sid=abc", "https://api.test/v1/orders");

    expect(cookie).toMatchObject({ name: "sid", value: "abc", domain: "api.test", path: "/v1" });
  });

  it("reads Domain, Path, Secure and HttpOnly", () => {
    const cookie = parseSetCookie(
      "sid=abc; Domain=.api.test; Path=/; Secure; HttpOnly",
      "https://a.api.test/x",
    );

    expect(cookie).toMatchObject({ domain: "api.test", path: "/", secure: true, httpOnly: true });
  });

  it("prefers Max-Age over Expires, as the spec requires", () => {
    const cookie = parseSetCookie(
      "sid=abc; Expires=Thu, 01 Jan 2030 00:00:00 GMT; Max-Age=60",
      "https://api.test/",
    );

    expect(cookie?.expires).toBeGreaterThan(Date.now());
    expect(cookie?.expires).toBeLessThan(Date.now() + 61_000);
  });

  it("refuses a header with no name=value pair", () => {
    expect(parseSetCookie("Secure; HttpOnly", "https://api.test/")).toBeUndefined();
  });
});

describe("createCookieJar", () => {
  const jar = () => createCookieJar([], () => 1_000_000);

  it("returns a cookie to the host that set it", () => {
    const store = jar();
    store.store("https://api.test/v1/x", ["sid=abc; Path=/"]);

    expect(store.headerFor("https://api.test/v1/y")).toBe("sid=abc");
  });

  it("sends nothing to a different host", () => {
    const store = jar();
    store.store("https://api.test/", ["sid=abc; Path=/"]);

    expect(store.headerFor("https://other.test/")).toBe("");
  });

  it("sends a Domain cookie to a subdomain", () => {
    const store = jar();
    store.store("https://api.test/", ["sid=abc; Domain=api.test; Path=/"]);

    expect(store.headerFor("https://v2.api.test/")).toBe("sid=abc");
  });

  it("respects the path", () => {
    const store = jar();
    store.store("https://api.test/", ["sid=abc; Path=/admin"]);

    expect(store.headerFor("https://api.test/admin/users")).toBe("sid=abc");
    expect(store.headerFor("https://api.test/public")).toBe("");
  });

  // A Secure cookie over plain http would be exactly the leak the flag exists
  // to prevent.
  it("withholds a Secure cookie from http", () => {
    const store = jar();
    store.store("https://api.test/", ["sid=abc; Path=/; Secure"]);

    expect(store.headerFor("http://api.test/")).toBe("");
    expect(store.headerFor("https://api.test/")).toBe("sid=abc");
  });

  // What makes a re-login update the session rather than add a second one.
  it("replaces a cookie with the same name, domain and path", () => {
    const store = jar();
    store.store("https://api.test/", ["sid=one; Path=/"]);
    store.store("https://api.test/", ["sid=two; Path=/"]);

    expect(store.headerFor("https://api.test/")).toBe("sid=two");
    expect(store.list()).toHaveLength(1);
  });

  it("treats an expiry in the past as a delete", () => {
    const store = jar();
    store.store("https://api.test/", ["sid=abc; Path=/"]);
    store.store("https://api.test/", ["sid=abc; Path=/; Max-Age=-1"]);

    expect(store.list()).toEqual([]);
  });

  it("hides an expired cookie without being asked to clean up", () => {
    const store = createCookieJar(
      [
        {
          name: "old",
          value: "1",
          domain: "api.test",
          path: "/",
          expires: 500,
          secure: false,
          httpOnly: false,
        },
      ],
      () => 1000,
    );

    expect(store.list()).toEqual([]);
    expect(store.headerFor("https://api.test/")).toBe("");
  });

  it("joins several cookies into one header", () => {
    const store = jar();
    store.store("https://api.test/", ["a=1; Path=/", "b=2; Path=/"]);

    expect(store.headerFor("https://api.test/")).toBe("a=1; b=2");
  });

  it("removes and clears", () => {
    const store = jar();
    store.store("https://api.test/", ["a=1; Path=/", "b=2; Path=/"]);

    store.remove("a", "api.test", "/");
    expect(store.list().map((cookie) => cookie.name)).toEqual(["b"]);

    store.clear();
    expect(store.list()).toEqual([]);
  });
});
