import { describe, expect, it } from "vitest";
import {
  acceptsHtml,
  cookieFor,
  type Headers,
  isPlainHtml,
  parseProxyPath,
  requestHeaders,
  responseHeaders,
  rewriteClusterHtml,
  setCookieHeader,
  takeKey,
} from "./proxy-rewrite.js";

const HANDLE = "0123456789abcdef0123456789abcdef";
const KEY = "a".repeat(64);
const COOKIE = "b".repeat(64);

describe("parseProxyPath", () => {
  it.each<[string, string, { handle: string; rest: string } | undefined]>([
    ["a good handle with a trailing path", `/s/${HANDLE}/foo`, { handle: HANDLE, rest: "/foo" }],
    ["no trailing slash", `/s/${HANDLE}`, { handle: HANDLE, rest: "/" }],
    ["a trailing slash and query", `/s/${HANDLE}/?a=1`, { handle: HANDLE, rest: "/?a=1" }],
    ["a raw .. segment", `/s/${HANDLE}/a/../b`, undefined],
    ["a percent-encoded .. segment", `/s/${HANDLE}/%2e%2e/b`, undefined],
    ["a raw backslash", `/s/${HANDLE}/a\\b`, undefined],
    // fix round 1, Important 1: a segment that decodes to a "/"-joined
    // traversal (the raw-segment check alone missed these).
    ["a slash-encoded .. segment", `/s/${HANDLE}/..%2fx`, undefined],
    ["a fully-encoded .. segment before an encoded slash", `/s/${HANDLE}/%2e%2e%2fx`, undefined],
    ["a plain segment hiding an encoded ..", `/s/${HANDLE}/a%2f..`, undefined],
    ["an encoded backslash", `/s/${HANDLE}/%5c`, undefined],
    ["an encoded control character", `/s/${HANDLE}/%0a`, undefined],
    ["a raw control character", `/s/${HANDLE}/a\nb`, undefined],
    ["an upper-case handle", `/s/${HANDLE.toUpperCase()}/foo`, undefined],
    ["/s/ with no handle", "/s/", undefined],
    ["a too-short handle", "/s/abc", undefined],
    ["garbage right after the handle", `/s/${HANDLE}x`, undefined],
    ["a double leading slash", `//s/${HANDLE}/foo`, undefined],
    ["an unrelated path", "/rpc", undefined],
    [
      "percent-encoding left untouched elsewhere",
      `/s/${HANDLE}/a%20b`,
      { handle: HANDLE, rest: "/a%20b" },
    ],
  ])("%s", (_label, url, expected) => {
    expect(parseProxyPath(url)).toEqual(expected);
  });
});

describe("takeKey", () => {
  it("extracts the only k, dropping the ? when nothing remains", () => {
    expect(takeKey(`/foo?k=${KEY}`)).toEqual({ key: KEY, rest: "/foo" });
  });

  it("extracts k among other params, keeping the others in order", () => {
    expect(takeKey(`/foo?a=1&k=${KEY}&b=2`)).toEqual({ key: KEY, rest: "/foo?a=1&b=2" });
  });

  it("returns undefined for two ks", () => {
    expect(takeKey(`/foo?k=${KEY}&k=${KEY}`)).toBeUndefined();
  });

  it("returns undefined for a malformed k", () => {
    expect(takeKey("/foo?k=not-hex")).toBeUndefined();
  });

  it("returns undefined when there is no k", () => {
    expect(takeKey("/foo?a=1")).toBeUndefined();
    expect(takeKey("/foo")).toBeUndefined();
  });
});

describe("cookieFor", () => {
  it("finds the value for the given handle among other cookies", () => {
    expect(cookieFor(`a=b; jarvis_s_${HANDLE}=${COOKIE}; c=d`, HANDLE)).toBe(COOKIE);
  });

  it("returns undefined for a cookie naming a different handle", () => {
    const otherHandle = "f".repeat(32);
    expect(cookieFor(`jarvis_s_${otherHandle}=${COOKIE}`, HANDLE)).toBeUndefined();
  });

  it("returns the first when two cookies name the same handle", () => {
    const second = "c".repeat(64);
    expect(cookieFor(`jarvis_s_${HANDLE}=${COOKIE}; jarvis_s_${HANDLE}=${second}`, HANDLE)).toBe(
      COOKIE,
    );
  });

  it("returns undefined when the header is absent", () => {
    expect(cookieFor(undefined, HANDLE)).toBeUndefined();
  });

  it("returns undefined for a malformed cookie value", () => {
    expect(cookieFor(`jarvis_s_${HANDLE}=not-hex`, HANDLE)).toBeUndefined();
  });
});

describe("requestHeaders", () => {
  it("[bite-proof] drops cookie and authorization", () => {
    const incoming: Headers = {
      cookie: "jarvis_s_x=y",
      authorization: "Basic zzzz",
      accept: "text/html",
    };
    const output = requestHeaders(incoming, { port: 9001 });
    expect(output.cookie).toBeUndefined();
    expect(output.authorization).toBeUndefined();
    expect(output.accept).toBe("text/html");
  });

  it("[final review] drops referer so a redeemed ?k= URL cannot reach sidecar logs", () => {
    const output = requestHeaders(
      { referer: `https://phone.example/s/${HANDLE}/?k=${KEY}`, accept: "text/html" },
      { port: 9001 },
    );
    expect(output.referer).toBeUndefined();
    expect(output.accept).toBe("text/html");
  });

  it("drops hop-by-hop headers", () => {
    const incoming: Headers = {
      "keep-alive": "timeout=5",
      "proxy-authenticate": "x",
      "proxy-authorization": "x",
      te: "trailers",
      trailer: "x",
      "transfer-encoding": "chunked",
      connection: "keep-alive",
      accept: "text/html",
    };
    const output = requestHeaders(incoming, { port: 9001 });
    expect(output["keep-alive"]).toBeUndefined();
    expect(output["proxy-authenticate"]).toBeUndefined();
    expect(output["proxy-authorization"]).toBeUndefined();
    expect(output.te).toBeUndefined();
    expect(output.trailer).toBeUndefined();
    expect(output["transfer-encoding"]).toBeUndefined();
    expect(output.connection).toBeUndefined();
    expect(output.accept).toBe("text/html");
  });

  // Final review, M1: none of these must ever reach a sidecar, in either
  // mode — DbGate and code-server both trust one of these over the real
  // Host/socket address.
  it.each<[string, boolean]>([
    ["plain", false],
    ["upgrade", true],
  ])("[%s mode] drops forwarded / x-forwarded-* / x-real-ip", (_label, upgrade) => {
    const incoming: Headers = {
      forwarded: "for=1.2.3.4",
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
      "x-forwarded-port": "443",
      "x-real-ip": "1.2.3.4",
      accept: "text/html",
    };
    const output = requestHeaders(incoming, { port: 9001, upgrade });
    expect(output.forwarded).toBeUndefined();
    expect(output["x-forwarded-for"]).toBeUndefined();
    expect(output["x-forwarded-host"]).toBeUndefined();
    expect(output["x-forwarded-proto"]).toBeUndefined();
    expect(output["x-forwarded-port"]).toBeUndefined();
    expect(output["x-real-ip"]).toBeUndefined();
    expect(output.accept).toBe("text/html");
  });

  // Final review, I1: code-server 4.112's `ensureOrigin` compares `Origin`
  // against `Host`/`X-Forwarded-Host`; forwarding the phone's own Origin
  // verbatim while forcing Host to loopback made that comparison always
  // fail, 403-ing every workbench WebSocket. Rewriting it to the same
  // loopback target as Host fixes the comparison in both modes; an absent
  // Origin must stay absent rather than being invented.
  it.each<[string, boolean]>([
    ["plain", false],
    ["upgrade", true],
  ])("[%s mode] rewrites a present origin to the loopback target", (_label, upgrade) => {
    const incoming: Headers = { origin: "https://name.tail.ts.net:7717" };
    const output = requestHeaders(incoming, { port: 4200, upgrade });
    expect(output.origin).toBe("http://127.0.0.1:4200");
  });

  it("leaves an absent origin absent", () => {
    const output = requestHeaders({ accept: "text/html" }, { port: 4200 });
    expect(output.origin).toBeUndefined();
  });

  it("drops a header named in the incoming Connection header", () => {
    const incoming: Headers = { connection: "x-custom", "x-custom": "value", accept: "text/html" };
    const output = requestHeaders(incoming, { port: 9001 });
    expect(output["x-custom"]).toBeUndefined();
    expect(output.accept).toBe("text/html");
  });

  it("forces host to 127.0.0.1:<port>, overriding any incoming host", () => {
    const incoming: Headers = { host: "phone.example:1" };
    const output = requestHeaders(incoming, { port: 4200 });
    expect(output.host).toBe("127.0.0.1:4200");
  });

  it("injects basic auth with the exact base64 for jarvis:pw", () => {
    const output = requestHeaders({}, { port: 1, basicAuth: { login: "jarvis", password: "pw" } });
    expect(output.authorization).toBe("Basic amFydmlzOnB3");
  });

  it("omits authorization when basicAuth is not given", () => {
    const output = requestHeaders({}, { port: 1 });
    expect(output.authorization).toBeUndefined();
  });

  it("upgrade mode preserves connection/upgrade/sec-websocket-* verbatim", () => {
    const incoming: Headers = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "abc123",
      "sec-websocket-version": "13",
      "sec-websocket-protocol": "chat",
      "sec-websocket-extensions": "permessage-deflate",
      cookie: "jarvis_s_x=y",
    };
    const output = requestHeaders(incoming, { port: 9001, upgrade: true });
    expect(output.connection).toBe("Upgrade");
    expect(output.upgrade).toBe("websocket");
    expect(output["sec-websocket-key"]).toBe("abc123");
    expect(output["sec-websocket-version"]).toBe("13");
    expect(output["sec-websocket-protocol"]).toBe("chat");
    expect(output["sec-websocket-extensions"]).toBe("permessage-deflate");
    expect(output.cookie).toBeUndefined();
  });

  it("never mutates its input", () => {
    const incoming: Headers = { accept: "text/html", cookie: "x" };
    const snapshot = { ...incoming };
    requestHeaders(incoming, { port: 1 });
    expect(incoming).toEqual(snapshot);
  });

  it("[fix round 1, M7] returns a null-prototype object", () => {
    const output = requestHeaders({}, { port: 1 });
    expect(Object.getPrototypeOf(output)).toBeNull();
  });
});

describe("responseHeaders", () => {
  it("rewrites a relative location to /s/<handle>/...", () => {
    const output = responseHeaders({ location: "/foo?a=1" }, HANDLE);
    expect(output.location).toBe(`/s/${HANDLE}/foo?a=1`);
  });

  it("rewrites a loopback-absolute location (127.0.0.1)", () => {
    const output = responseHeaders({ location: "http://127.0.0.1:9001/foo?a=1" }, HANDLE);
    expect(output.location).toBe(`/s/${HANDLE}/foo?a=1`);
  });

  it("rewrites a localhost-absolute location", () => {
    const output = responseHeaders({ location: "http://localhost:9001/foo" }, HANDLE);
    expect(output.location).toBe(`/s/${HANDLE}/foo`);
  });

  it("leaves an external location unchanged", () => {
    const output = responseHeaders({ location: "https://example.com/foo" }, HANDLE);
    expect(output.location).toBe("https://example.com/foo");
  });

  // fix round 1, M3: the port must never reach the phone, whether or not
  // the sidecar's Location happened to carry a path or an explicit port.
  it("rewrites a loopback location with no path (port only) to /s/<handle>/", () => {
    const output = responseHeaders({ location: "http://127.0.0.1:9001" }, HANDLE);
    expect(output.location).toBe(`/s/${HANDLE}/`);
  });

  it("rewrites a loopback location with a query but no path to /s/<handle>/?...", () => {
    const output = responseHeaders({ location: "http://localhost:9001?x=1" }, HANDLE);
    expect(output.location).toBe(`/s/${HANDLE}/?x=1`);
  });

  it("rewrites a loopback location with no port at all", () => {
    const output = responseHeaders({ location: "http://127.0.0.1/foo" }, HANDLE);
    expect(output.location).toBe(`/s/${HANDLE}/foo`);
  });

  it("rewrites an https loopback location", () => {
    const output = responseHeaders({ location: "https://localhost:9001/foo" }, HANDLE);
    expect(output.location).toBe(`/s/${HANDLE}/foo`);
  });

  it("rewrites each element of a location array", () => {
    const output = responseHeaders({ location: ["/a", "/b"] }, HANDLE);
    expect(output.location).toEqual([`/s/${HANDLE}/a`, `/s/${HANDLE}/b`]);
  });

  it("prefixes an existing Path attribute", () => {
    const output = responseHeaders({ "set-cookie": "n=v; Path=/api" }, HANDLE);
    expect(output["set-cookie"]).toBe(`n=v; Path=/s/${HANDLE}/api; Secure`);
  });

  it("removes a Domain attribute", () => {
    const output = responseHeaders({ "set-cookie": "n=v; Domain=example.com; Path=/" }, HANDLE);
    expect(output["set-cookie"]).toBe(`n=v; Path=/s/${HANDLE}/; Secure`);
  });

  it("adds Path when missing", () => {
    const output = responseHeaders({ "set-cookie": "n=v" }, HANDLE);
    expect(output["set-cookie"]).toBe(`n=v; Path=/s/${HANDLE}; Secure`);
  });

  it("adds Secure when absent, leaves it when present", () => {
    const withoutSecure = responseHeaders({ "set-cookie": "n=v" }, HANDLE);
    expect(withoutSecure["set-cookie"]).toContain("Secure");
    const withSecure = responseHeaders({ "set-cookie": "n=v; Secure" }, HANDLE);
    expect((withSecure["set-cookie"] as string).match(/Secure/g)?.length).toBe(1);
  });

  it("keeps a set-cookie array as an array", () => {
    const output = responseHeaders({ "set-cookie": ["n=v", "m=w"] }, HANDLE);
    expect(Array.isArray(output["set-cookie"])).toBe(true);
    expect(output["set-cookie"]).toEqual([
      `n=v; Path=/s/${HANDLE}; Secure`,
      `m=w; Path=/s/${HANDLE}; Secure`,
    ]);
  });

  it("[bite-proof] removes www-authenticate", () => {
    const output = responseHeaders({ "www-authenticate": "Basic realm=x" }, HANDLE);
    expect(output["www-authenticate"]).toBeUndefined();
  });

  it("drops hop-by-hop headers", () => {
    const output = responseHeaders(
      { "transfer-encoding": "chunked", "content-type": "text/html" },
      HANDLE,
    );
    expect(output["transfer-encoding"]).toBeUndefined();
    expect(output["content-type"]).toBe("text/html");
  });

  it("never mutates its input", () => {
    const incoming: Headers = { location: "/a", "set-cookie": ["n=v"] };
    const snapshot = { location: "/a", "set-cookie": ["n=v"] };
    responseHeaders(incoming, HANDLE);
    expect(incoming).toEqual(snapshot);
  });

  it("[fix round 1, M7] returns a null-prototype object", () => {
    const output = responseHeaders({}, HANDLE);
    expect(Object.getPrototypeOf(output)).toBeNull();
  });
});

describe("setCookieHeader", () => {
  it("returns the exact expected string", () => {
    expect(setCookieHeader(HANDLE, COOKIE)).toBe(
      `jarvis_s_${HANDLE}=${COOKIE}; Path=/s/${HANDLE}; HttpOnly; Secure; SameSite=Strict`,
    );
  });
});

describe("requestHeaders identity option", () => {
  it("drops accept-encoding only when asked [bite-proof: forward it and the sidecar gzips the document the proxy meant to rewrite]", () => {
    const incoming: Headers = { accept: "text/html", "accept-encoding": "gzip, br" };
    expect(
      requestHeaders(incoming, { port: 1, identity: true })["accept-encoding"],
    ).toBeUndefined();
    expect(requestHeaders(incoming, { port: 1 })["accept-encoding"]).toBe("gzip, br");
  });
});

describe("acceptsHtml", () => {
  it("is true for a document navigation and false for assets, API calls and a missing header", () => {
    expect(acceptsHtml("text/html,application/xhtml+xml,*/*;q=0.8")).toBe(true);
    expect(acceptsHtml(["Text/HTML"])).toBe(true);
    expect(acceptsHtml("*/*")).toBe(false);
    expect(acceptsHtml("application/json")).toBe(false);
    expect(acceptsHtml(undefined)).toBe(false);
  });
});

describe("isPlainHtml", () => {
  it("is true for uncompressed text/html only", () => {
    expect(isPlainHtml({ "content-type": "text/html; charset=utf-8" })).toBe(true);
    expect(isPlainHtml({ "content-type": "text/html", "content-encoding": "identity" })).toBe(true);
    expect(isPlainHtml({ "content-type": "text/html", "content-encoding": "gzip" })).toBe(false);
    expect(isPlainHtml({ "content-type": "application/javascript" })).toBe(false);
    expect(isPlainHtml({})).toBe(false);
  });
});

describe("rewriteClusterHtml", () => {
  const HEADLAMP_INDEX = [
    `<link rel="icon" href="/favicon.ico" />`,
    `<link rel="apple-touch-icon" href="logo192.png" />`,
    `<a href="//cdn.example/x">`,
    `__baseUrl__ = '/<%= BASE_URL %>'.replace('%BASE_' + 'URL%', '');`,
    `headlampBaseUrl = '/';`,
    `<script type="module" crossorigin src="/assets/index-abc.js"></script>`,
    `<link rel="stylesheet" href="/assets/index-def.css">`,
  ].join("\n");

  it("re-bases the document exactly as headlamp-server's -base-url would [bite-proof: skip any one replacement and the phone spins on the splash]", () => {
    const out = rewriteClusterHtml(HEADLAMP_INDEX, HANDLE);
    expect(out).toContain(`href="/s/${HANDLE}/favicon.ico"`);
    expect(out).toContain(`src="/s/${HANDLE}/assets/index-abc.js"`);
    expect(out).toContain(`href="/s/${HANDLE}/assets/index-def.css"`);
    expect(out).toContain(`headlampBaseUrl = '/s/${HANDLE}';`);
    expect(out).toContain(`__baseUrl__ = '/s/${HANDLE}/<%= BASE_URL %>'`);
  });

  it("leaves relative and protocol-relative references alone", () => {
    const out = rewriteClusterHtml(HEADLAMP_INDEX, HANDLE);
    expect(out).toContain(`href="logo192.png"`);
    expect(out).toContain(`href="//cdn.example/x"`);
  });

  it("is a no-op on a document with nothing to re-base", () => {
    expect(rewriteClusterHtml("<p>hi</p>", HANDLE)).toBe("<p>hi</p>");
  });
});
