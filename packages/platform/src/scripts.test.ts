import { describe, expect, it } from "vitest";
import { runScript } from "./scripts.js";

const request = { method: "GET", url: "http://h/x", headers: {}, body: undefined };

const run = (code: string, over: Partial<Parameters<typeof runScript>[1]> = {}) =>
  runScript(code, { variables: { base: "http://h" }, request, ...over });

describe("runScript", () => {
  it("does nothing at all for an empty script", () => {
    expect(run("")).toEqual({ variables: {}, logs: [], tests: [] });
  });

  it("collects variables a script sets", () => {
    const result = run("bru.setVar('token', 'abc'); bru.setVar('n', 41);");

    expect(result.variables).toEqual({ token: "abc", n: "41" });
  });

  it("reads variables the request was given", () => {
    const result = run("console.log(bru.getVar('base'));");

    expect(result.logs).toEqual(["http://h"]);
  });

  it("prefers a variable the script set over the one it started with", () => {
    const result = run("bru.setVar('base', 'http://new'); console.log(bru.getVar('base'));");

    expect(result.logs).toEqual(["http://new"]);
  });

  it("gives a post-response script the response", () => {
    const result = run("console.log(res.status); console.log(res.body.id);", {
      response: {
        status: 201,
        statusText: "Created",
        headers: {},
        body: { id: 7 },
        responseTime: 5,
      },
    });

    expect(result.logs).toEqual(["201", "7"]);
  });

  it("runs a tests block and reports each assertion", () => {
    const result = run(
      `test('status is ok', function () { expect(res.status).to.equal(200); });
       test('has an id', function () { expect(res.body).to.have.property('id'); });
       test('this one fails', function () { expect(res.status).to.equal(500); });`,
      {
        response: { status: 200, statusText: "OK", headers: {}, body: { id: 1 }, responseTime: 2 },
      },
    );

    expect(result.tests).toEqual([
      { name: "status is ok", passed: true },
      { name: "has an id", passed: true },
      { name: "this one fails", passed: false, error: "expected 200 to equal 500" },
    ]);
  });

  it.each([
    ["expect(1).to.be.a('number')", true],
    ["expect(2).to.be.above(1)", true],
    ["expect(2).to.be.below(1)", false],
    ["expect('abc').to.include('b')", true],
    ["expect([1,2]).to.have.length(2)", true],
    ["expect(null).to.exist", false],
    ["expect(1).to.exist", true],
    ["expect(true).to.be.true", true],
    ["expect(false).to.be.true", false],
    ["expect(null).to.be.null", true],
    ["expect('abc').to.match(/b/)", true],
    ["expect({a:1}).to.eql({a:1})", true],
  ])("supports %s", (assertion, passes) => {
    const result = run(`test('t', function () { ${assertion}; });`);

    expect(result.tests[0]?.passed).toBe(passes);
  });

  // The request still happened; a broken script must not hide a response that
  // arrived.
  it("reports a script that throws rather than raising", () => {
    const result = run("throw new Error('boom');");

    expect(result.error).toBe("boom");
    expect(result.tests).toEqual([]);
  });

  it("reports a syntax error the same way", () => {
    expect(run("this is not javascript {").error).toBeDefined();
  });

  it("keeps the variables set before a script threw", () => {
    const result = run("bru.setVar('a', '1'); throw new Error('later');");

    expect(result.variables).toEqual({ a: "1" });
  });

  // An endless loop in someone's repo must not take the window with it.
  it("stops an endless loop at the timeout", () => {
    const result = run("while (true) {}", { timeoutMs: 50 });

    expect(result.error).toContain("timed out");
  });

  // A narrow context is containment against accident, not a security
  // boundary — but reaching for something absent should fail clearly.
  it("gives a clear error for something the context does not have", () => {
    expect(run("require('node:fs')").error).toContain("require is not defined");
    expect(run("process.exit(1)").error).toContain("process is not defined");
  });
});
