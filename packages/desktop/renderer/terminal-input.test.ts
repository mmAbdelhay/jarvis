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

  it("kills the word before the cursor on ^W mid-line, leaving the rest", () => {
    const { editor: e } = editor();
    e.setValue("git commit --amend now");
    const textarea = e.element.querySelector("textarea") as HTMLTextAreaElement;
    // Cursor right after "--amend", before the space and "now".
    const pos = "git commit --amend".length;
    textarea.selectionStart = pos;
    textarea.selectionEnd = pos;
    press(e.element, { key: "w", ctrlKey: true });
    expect(e.value()).toBe("git commit  now");
  });

  it("kills the whole line on ^U", () => {
    const { editor: e } = editor();
    e.setValue("rm -rf /");
    press(e.element, { key: "u", ctrlKey: true });
    expect(e.value()).toBe("");
  });

  it("hands ^C to the pty rather than eating it, leaving the value alone", () => {
    const { editor: e, hooks } = editor();
    e.setValue("sleep 10");
    press(e.element, { key: "c", ctrlKey: true });
    expect(hooks.passthrough).toHaveBeenCalled();
    expect(e.value()).toBe("sleep 10");
    expect(hooks.submit).not.toHaveBeenCalled();
  });

  it("hands ^D to the pty, so exit still exits, leaving the value alone", () => {
    const { editor: e, hooks } = editor();
    e.setValue("");
    press(e.element, { key: "d", ctrlKey: true });
    expect(hooks.passthrough).toHaveBeenCalled();
    expect(e.value()).toBe("");
    expect(hooks.submit).not.toHaveBeenCalled();
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

  it("shows the prompt", () => {
    const { editor: e } = editor();
    e.show("user@host $ ");
    expect(e.element.querySelector(".terminal-input-prompt")?.textContent).toBe("user@host $ ");
  });

  it("renders a prompt containing markup as text", () => {
    const { editor: e } = editor();
    e.show("<img src=x>$ ");
    expect(e.element.querySelector("img")).toBeNull();
    expect(e.element.querySelector(".terminal-input-prompt")?.textContent).toBe("<img src=x>$ ");
  });

  it("replaces rather than appends the prompt on a second show()", () => {
    const { editor: e } = editor();
    e.show("first $ ");
    e.show("second $ ");
    const prompts = e.element.querySelectorAll(".terminal-input-prompt");
    expect(prompts.length).toBe(1);
    expect(prompts[0]?.textContent).toBe("second $ ");
  });

  it("leaves no stale prompt after hide() then show('')", () => {
    const { editor: e } = editor();
    e.show("user@host $ ");
    e.hide();
    e.show("");
    expect(e.element.querySelector(".terminal-input-prompt")?.textContent).toBe("");
  });

  it("tokenizes a single word with no spaces as just the command", () => {
    const { editor: e } = editor();
    e.setValue("ls");
    expect(e.element.querySelector(".tok-command")?.textContent).toBe("ls");
    expect(e.element.textContent).toBe("ls");
  });

  it("tokenizes an all-whitespace line without throwing", () => {
    const { editor: e } = editor();
    e.setValue("   ");
    expect(e.element.querySelector(".tok-command")).toBeNull();
    expect(e.element.textContent).toBe("   ");
  });

  it("tokenizes one very long token without hanging", () => {
    const { editor: e } = editor();
    const long = "a".repeat(50_000);
    e.setValue(long);
    expect(e.element.querySelector(".tok-command")?.textContent).toBe(long);
  });
});
