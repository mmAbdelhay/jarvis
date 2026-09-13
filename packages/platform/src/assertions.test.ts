import { describe, expect, it } from "vitest";
import { evaluateAssertions, type AssertionSubject } from "./assertions.js";

const subject = (overrides: Partial<AssertionSubject> = {}): AssertionSubject => ({
  status: 200,
  headers: { "Content-Type": "application/json" },
  body: '{"id":41,"total":230,"user":{"name":"Ali"},"tags":[]}',
  timeMs: 120,
  ...overrides,
});

const run = (name: string, value: string, over: Partial<AssertionSubject> = {}) =>
  evaluateAssertions([{ name, value, enabled: true }], subject(over))[0];

describe("evaluateAssertions", () => {
  it("compares the status", () => {
    expect(run("res.status", "eq 200")?.passed).toBe(true);
    expect(run("res.status", "eq 404")?.passed).toBe(false);
  });

  it("reads a nested body field", () => {
    expect(run("res.body.user.name", "eq Ali")?.passed).toBe(true);
    expect(run("res.body.id", "eq 41")?.passed).toBe(true);
  });

  it("reads a header case-insensitively", () => {
    expect(run("res.headers.content-type", "contains json")?.passed).toBe(true);
  });

  it("compares numbers as numbers, not as text", () => {
    expect(run("res.body.total", "gt 100")?.passed).toBe(true);
    expect(run("res.body.total", "lt 100")?.passed).toBe(false);
    // "9" > "100" as text, and that is exactly the bug this guards.
    expect(run("res.body.total", "gt 9")?.passed).toBe(true);
  });

  it("supports the response time", () => {
    expect(run("res.responseTime", "lt 500")?.passed).toBe(true);
  });

  it.each([
    ["contains", "Ali", true],
    ["notContains", "Sara", true],
    ["matches", "^Al", true],
    ["startsWith", "Al", true],
    ["endsWith", "li", true],
    ["neq", "Sara", true],
  ] as const)("supports %s", (operator, operand, expected) => {
    expect(run("res.body.user.name", `${operator} ${operand}`)?.passed).toBe(expected);
  });

  it("supports the presence operators", () => {
    expect(run("res.body.user", "isDefined")?.passed).toBe(true);
    expect(run("res.body.missing", "isUndefined")?.passed).toBe(true);
    // tags is [], which is empty.
    expect(run("res.body.tags", "isEmpty")?.passed).toBe(true);
    expect(run("res.body.user.name", "isNotEmpty")?.passed).toBe(true);
  });

  it("reports what the target actually was, so a failure reads", () => {
    const result = run("res.status", "eq 404", { status: 500 });

    expect(result).toMatchObject({
      target: "res.status",
      expression: "eq 404",
      passed: false,
      actual: "500",
    });
  });

  it("fails an unknown path rather than passing it", () => {
    expect(run("res.body.nope.deeper", "eq 1")?.passed).toBe(false);
  });

  it("treats a non-JSON body as text", () => {
    expect(run("res.body", "contains hello", { body: "hello world" })?.passed).toBe(true);
  });

  it("survives an invalid regex instead of throwing", () => {
    expect(run("res.body.user.name", "matches [")?.passed).toBe(false);
  });

  // Reporting a skipped assertion as passing would be a claim nobody checked.
  it("skips a disabled assertion entirely", () => {
    expect(
      evaluateAssertions([{ name: "res.status", value: "eq 999", enabled: false }], subject()),
    ).toEqual([]);
  });

  it("fails an unknown operator rather than passing it", () => {
    expect(run("res.status", "isProbably 200")?.passed).toBe(false);
  });
});
