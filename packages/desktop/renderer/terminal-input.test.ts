// @vitest-environment jsdom
// packages/desktop/renderer/terminal-input.test.ts
import { describe, expect, it, vi } from "vitest";
import { createEditor } from "./terminal-input.js";

function editor() {
  const host = document.createElement("div");
  document.body.append(host);
  const hooks = { submit: vi.fn(), passthrough: vi.fn(), history: vi.fn(() => "git status") };
  return { editor: createEditor(host, hooks), hooks };
}

const press = (element: HTMLElement, init: KeyboardEventInit) =>
  element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

describe("the input editor", () => {
  it("submits the line on Enter and clears itself", () => {
    const { editor: e, hooks } = editor();
    e.setValue("pnpm test");
    press(e.element, { key: "Enter" });
    expect(hooks.submit).toHaveBeenCalledWith("pnpm test");
    expect(e.value()).toBe("");
  });

  it("adds a newline on Shift+Enter instead of submitting", () => {
    const { editor: e, hooks } = editor();
    e.setValue("for i in 1 2 3; do");
    press(e.element, { key: "Enter", shiftKey: true });
    expect(hooks.submit).not.toHaveBeenCalled();
    expect(e.value()).toContain("\n");
  });

  it("kills the word before the cursor on ^W", () => {
    const { editor: e } = editor();
    e.setValue("git commit --amend");
    press(e.element, { key: "w", ctrlKey: true });
    expect(e.value()).toBe("git commit ");
  });

  it("kills the whole line on ^U", () => {
    const { editor: e } = editor();
    e.setValue("rm -rf /");
    press(e.element, { key: "u", ctrlKey: true });
    expect(e.value()).toBe("");
  });

  it("hands ^C to the pty rather than eating it", () => {
    const { editor: e, hooks } = editor();
    press(e.element, { key: "c", ctrlKey: true });
    expect(hooks.passthrough).toHaveBeenCalled();
  });

  it("hands ^D to the pty, so exit still exits", () => {
    const { editor: e, hooks } = editor();
    press(e.element, { key: "d", ctrlKey: true });
    expect(hooks.passthrough).toHaveBeenCalled();
  });

  it("walks Jarvis's own history with the arrows", () => {
    const { editor: e, hooks } = editor();
    press(e.element, { key: "ArrowUp" });
    expect(hooks.history).toHaveBeenCalledWith(-1);
    expect(e.value()).toBe("git status");
  });

  it("highlights the command word and its flags", () => {
    const { editor: e } = editor();
    e.setValue("git commit -m x");
    expect(e.element.querySelector(".tok-command")?.textContent).toBe("git");
    expect(e.element.querySelector(".tok-flag")?.textContent).toBe("-m");
  });

  it("renders a command containing markup as text", () => {
    const { editor: e } = editor();
    e.setValue("echo '<script>alert(1)</script>'");
    expect(e.element.querySelector("script")).toBeNull();
    expect(e.element.textContent).toContain("<script>");
  });
});
