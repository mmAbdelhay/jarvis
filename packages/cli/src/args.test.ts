import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("parses jarvis account", () => {
    expect(parseArgs(["account"])).toEqual({ kind: "account", action: "status" });
    expect(parseArgs(["account", "login", "gemini"])).toEqual({ kind: "account", action: "login", account: "gemini" });
    expect(parseArgs(["account", "remove", "copilot"])).toEqual({ kind: "account", action: "remove", account: "copilot" });
    expect(parseArgs(["account", "login"])).toMatchObject({ kind: "usage-error" });
    expect(parseArgs(["account", "login", "bard"])).toMatchObject({ kind: "usage-error" });
  });

  it("parses every account action and rejects extra arguments", () => {
    for (const action of ["install", "login", "logout", "remove"] as const) {
      expect(parseArgs(["account", action, "chatgpt"])).toEqual({ kind: "account", action, account: "chatgpt" });
      expect(parseArgs(["account", action, "chatgpt", "extra"]).kind).toBe("usage-error");
    }
    expect(parseArgs(["account", "status"])).toEqual({ kind: "account", action: "status" });
    expect(parseArgs(["account", "status", "extra"]).kind).toBe("usage-error");
  });

  it("defaults to chat", () => {
    expect(parseArgs([])).toEqual({ kind: "chat" });
  });

  it("joins the words after ask into one question", () => {
    expect(parseArgs(["ask", "what", "is", "using", "my", "disk?"])).toEqual({
      kind: "ask",
      text: "what is using my disk?",
    });
    expect(parseArgs(["ask", "  why is wifi slow  "])).toEqual({
      kind: "ask",
      text: "why is wifi slow",
    });
  });

  it("refuses an empty or overlong question", () => {
    expect(parseArgs(["ask"]).kind).toBe("usage-error");
    expect(parseArgs(["ask", "   "]).kind).toBe("usage-error");
    expect(parseArgs(["ask", "x".repeat(8001)]).kind).toBe("usage-error");
    expect(parseArgs(["ask", "x".repeat(8000)]).kind).toBe("ask");
  });

  it("reads setup, memory list (the default) and memory clear with --yes", () => {
    expect(parseArgs(["setup"])).toEqual({ kind: "setup" });
    expect(parseArgs(["memory"])).toEqual({ kind: "memory", action: "list", yes: false });
    expect(parseArgs(["memory", "list"])).toEqual({ kind: "memory", action: "list", yes: false });
    expect(parseArgs(["memory", "clear"])).toEqual({ kind: "memory", action: "clear", yes: false });
    expect(parseArgs(["memory", "clear", "--yes"])).toEqual({
      kind: "memory",
      action: "clear",
      yes: true,
    });
    expect(parseArgs(["memory", "clear", "-y"])).toEqual({
      kind: "memory",
      action: "clear",
      yes: true,
    });
  });

  it("reads help and version", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
  });

  it("refuses unknown commands and stray flags", () => {
    expect(parseArgs(["frobnicate"])).toEqual({
      kind: "usage-error",
      message: "Unknown argument: frobnicate",
    });
    expect(parseArgs(["setup", "now"]).kind).toBe("usage-error");
    expect(parseArgs(["memory", "list", "--yes"]).kind).toBe("usage-error");
    expect(parseArgs(["memory", "delete"]).kind).toBe("usage-error");
    expect(parseArgs(["memory", "clear", "--force"]).kind).toBe("usage-error");
  });
});
