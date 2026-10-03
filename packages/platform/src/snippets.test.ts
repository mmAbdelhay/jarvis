import { describe, expect, it } from "vitest";
import { toCurl, toSnippet } from "./curl.js";

const post = {
  http: { method: "post", url: "{{base}}/runs", body: "json", auth: "bearer" },
  headers: [
    { name: "Accept", value: "application/json" },
    { name: "X-Off", value: "1", enabled: false },
  ],
  params: [{ name: "q", value: "a b" }],
  auth: { bearer: { token: "{{token}}" } },
  body: { json: '{"name":"Jarvis\'s"}' },
};
const vars = { base: "https://api.example.com", token: "t0k" };

describe("toSnippet", () => {
  it("defaults to exactly what toCurl produces", () => {
    expect(toSnippet(post, vars)).toBe(toCurl(post, vars));
  });

  it("writes fetch with the same resolved URL, headers and body", () => {
    expect(toSnippet(post, vars, "fetch")).toBe(
      [
        'const response = await fetch("https://api.example.com/runs?q=a%20b", {',
        '  method: "POST",',
        "  headers: {",
        '    "Accept": "application/json",',
        '    "Authorization": "Bearer t0k",',
        "  },",
        '  body: "{\\"name\\":\\"Jarvis\'s\\"}",',
        "});",
        "console.log(response.status, await response.text());",
      ].join("\n"),
    );
  });

  it("writes Python requests, with basic auth as auth= rather than a header", () => {
    const basic = {
      http: { method: "get", url: "https://x.test/me", auth: "basic" },
      auth: { basic: { username: "u", password: "p" } },
    };
    expect(toSnippet(basic, {}, "python")).toBe(
      [
        "import requests",
        "",
        "response = requests.request(",
        '    "GET",',
        '    "https://x.test/me",',
        '    auth=("u", "p"),',
        ")",
        "print(response.status_code, response.text)",
      ].join("\n"),
    );
    // fetch has no auth= of its own, so the same credentials become a header.
    expect(toSnippet(basic, {}, "fetch")).toContain('"Authorization": "Basic dTpw"');
  });

  it("sends form and multipart bodies the way each language does", () => {
    const form = {
      http: { method: "post", url: "https://x.test/f", body: "formUrlEncoded" },
      body: { formUrlEncoded: [{ name: "a", value: "1" }] },
    };
    expect(toSnippet(form, {}, "fetch")).toContain('body.append("a", "1");');
    expect(toSnippet(form, {}, "python")).toContain('data={\n        "a": "1",');

    const multipart = {
      http: { method: "post", url: "https://x.test/u", body: "multipartForm" },
      body: {
        multipartForm: [
          { name: "note", value: "hi" },
          { name: "file", type: "file", value: ["/tmp/a.png"] },
        ],
      },
    };
    expect(toSnippet(multipart, {}, "python")).toContain('("file", open("/tmp/a.png", "rb"))');
    expect(toSnippet(multipart, {}, "fetch")).toContain("new FormData()");
  });
});
