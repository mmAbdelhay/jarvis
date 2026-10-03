// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const response = (body: string) => ({
  status: 200,
  statusText: "OK",
  headers: {},
  body,
  timeMs: 1,
  bytes: body.length,
  unresolved: [],
});

async function show(body: string) {
  vi.resetModules();
  document.body.innerHTML = `
    <div id="api-response-tabs"></div><div id="api-response-head"></div><div id="api-response"></div>`;
  const module = await import("./api-response.js");
  module.setResponse({ response: response(body) as never, assertions: [] });
  return module;
}

const input = () => document.getElementById("api-response-search") as HTMLInputElement;
const count = () => document.querySelector(".api-find-count")?.textContent;
const current = () => document.querySelector(".api-match--current")?.textContent;
function type(value: string) {
  input().value = value;
  input().dispatchEvent(new Event("input"));
}
function key(name: string, shiftKey = false) {
  input().dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey }));
}

describe("find in response", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("marks every case-insensitive match and counts them", async () => {
    await show("Error: one error, then ERROR again");
    type("error");
    expect(document.querySelectorAll(".api-match")).toHaveLength(3);
    expect(count()).toBe("1/3");
    expect(current()).toBe("Error");
    // The text itself is untouched around the marks.
    expect(document.querySelector(".api-response-body")?.textContent).toBe(
      "Error: one error, then ERROR again",
    );
  });

  it("steps forward with Enter and back with Shift+Enter, wrapping around", async () => {
    await show("a1 a2 a3");
    type("a");
    key("Enter");
    expect(count()).toBe("2/3");
    key("Enter", true);
    key("Enter", true);
    expect(count()).toBe("3/3");
    expect(current()).toBe("a");
  });

  it("keeps the field — and its focus — while redrawing as you type", async () => {
    await show("abc");
    const field = input();
    field.focus();
    type("b");
    expect(input()).toBe(field);
    expect(document.activeElement).toBe(field);
  });

  it("clears with Escape, and says 0/0 for no match", async () => {
    await show("hello");
    type("zzz");
    expect(count()).toBe("0/0");
    key("Escape");
    expect(input().value).toBe("");
    expect(count()).toBe("");
    expect(document.querySelectorAll(".api-match")).toHaveLength(0);
  });

  it("marks at most a capped number of matches, and says there are more", async () => {
    const module = await show("x".repeat(5000));
    type("x");
    expect(document.querySelectorAll(".api-match")).toHaveLength(module.MAX_MARKED_MATCHES);
    expect(count()).toBe(`1/${module.MAX_MARKED_MATCHES}+`);
  });
});
