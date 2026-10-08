import { describe, expect, it } from "vitest";
import type { RegisteredTool } from "./tool-registry.js";
import {
  createUndoStack,
  parseUndo,
  stepTitle,
  UNDO_LIMIT,
  type UndoStep,
  undoRequestOf,
} from "./undo.js";

function tool(
  name: string,
  server = "jarvis-settings",
  extra: Partial<RegisteredTool> = {},
): RegisteredTool {
  return {
    name,
    modelName: name.replace(/\./g, "_"),
    server,
    description: name,
    risk: "confirm",
    hidden: false,
    secrets: [],
    batchItems: false,
    inputSchema: { type: "object", properties: {} },
    modelSchema: { type: "object", properties: {} },
    ...extra,
  };
}
const HOST = new Set(["jarvis-pkg", "jarvis-settings", "jarvis-files"]);
const tools = new Map<string, RegisteredTool>([
  ["settings.brightness", tool("settings.brightness")],
  ["settings.wifi", tool("settings.wifi")],
  ["files.undo", tool("files.undo", "jarvis-files", { hidden: true })],
  ["files.move", tool("files.move", "jarvis-files")],
  ["pkg.install", tool("pkg.install", "jarvis-pkg")],
  ["users.remove", tool("users.remove", "jarvis-settings", { risk: "password" })],
  ["settings.secret", tool("settings.secret", "jarvis-settings", { secrets: ["password"] })],
]);
const lookup = (name: string) => tools.get(name);
const brightness = tools.get("settings.brightness") as RegisteredTool;

describe("parseUndo (M3 §1: every setter returns {undo: {tool, input}})", () => {
  it("accepts an undo in the same family on the same host server", () => {
    const parsed = parseUndo(
      { previous: 40, current: 80, undo: { tool: "settings.brightness", input: { percent: 40 } } },
      brightness,
      lookup,
      HOST,
    );
    expect(parsed?.tool.name).toBe("settings.brightness");
    expect(parsed?.input).toEqual({ percent: 40 });
  });

  it("accepts a file journal undo from jarvis-files", () => {
    const move = tools.get("files.move") as RegisteredTool;
    expect(
      parseUndo(
        {
          done: [],
          failed: [],
          journalId: "j1",
          undo: { tool: "files.undo", input: { journalId: "j1" } },
        },
        move,
        lookup,
        HOST,
      )?.tool.name,
    ).toBe("files.undo");
  });

  it("refuses an undo outside the tool's own family or server", () => {
    const undo = (target: string) => ({ undo: { tool: target, input: {} } });
    expect(parseUndo(undo("pkg.install"), brightness, lookup, HOST)).toBeUndefined();
    expect(parseUndo(undo("files.undo"), brightness, lookup, HOST)).toBeUndefined();
    expect(parseUndo(undo("settings.unknown"), brightness, lookup, HOST)).toBeUndefined();
  });

  it("refuses password-tier, secret-taking and add-on undo targets", () => {
    const undo = (target: string) => ({ undo: { tool: target, input: {} } });
    expect(parseUndo(undo("users.remove"), brightness, lookup, HOST)).toBeUndefined();
    expect(parseUndo(undo("settings.secret"), brightness, lookup, HOST)).toBeUndefined();
    const addon = tool("settings.brightness", "some-addon");
    expect(parseUndo(undo("settings.brightness"), addon, lookup, HOST)).toBeUndefined();
  });

  it("refuses malformed or oversized undo objects", () => {
    expect(parseUndo({}, brightness, lookup, HOST)).toBeUndefined();
    expect(parseUndo({ undo: "settings.brightness" }, brightness, lookup, HOST)).toBeUndefined();
    expect(
      parseUndo({ undo: { tool: "settings.brightness", input: [] } }, brightness, lookup, HOST),
    ).toBeUndefined();
    expect(
      parseUndo(
        { undo: { tool: "settings.brightness", input: { x: "a".repeat(20_000) } } },
        brightness,
        lookup,
        HOST,
      ),
    ).toBeUndefined();
  });

  it("copies the input so a later mutation of the result cannot change the undo", () => {
    const data = { undo: { tool: "settings.brightness", input: { percent: 40 } } };
    const parsed = parseUndo(data, brightness, lookup, HOST);
    data.undo.input.percent = 1;
    expect(parsed?.input).toEqual({ percent: 40 });
  });
});

describe("createUndoStack", () => {
  const step = (n: number, family = "settings."): UndoStep => ({
    title: `step ${n}`,
    tool: family === "files." ? "files.undo" : "settings.brightness",
    input: { n },
    server: "s",
    family,
    at: n,
  });

  it("keeps only the last 20, newest first out", () => {
    const stack = createUndoStack();
    for (let n = 1; n <= 25; n++) stack.push(step(n));
    expect(UNDO_LIMIT).toBe(20);
    expect(stack.size()).toBe(20);
    expect(stack.pop()?.title).toBe("step 25");
    const rest: string[] = [];
    for (let s = stack.pop(); s !== undefined; s = stack.pop()) rest.push(s.title);
    expect(rest.at(-1)).toBe("step 6");
  });

  it("peeks at the newest step without removing it", () => {
    const stack = createUndoStack();
    expect(stack.peek()).toBeUndefined();
    stack.push(step(1));
    stack.push(step(2));
    expect(stack.peek()?.title).toBe("step 2");
    expect(stack.size()).toBe(2);
  });

  it("pops the newest matching step and leaves the rest", () => {
    const stack = createUndoStack();
    stack.push(step(1, "files."));
    stack.push(step(2));
    expect(stack.pop((s) => s.family === "files.")?.title).toBe("step 1");
    expect(stack.size()).toBe(1);
    expect(stack.pop((s) => s.family === "files.")).toBeUndefined();
  });
});

describe("undo phrases", () => {
  it("recognises the short undo phrases in English and Arabic", () => {
    expect(undoRequestOf("Undo")).toEqual({ kind: "any" });
    expect(undoRequestOf("undo that!")).toEqual({ kind: "any" });
    expect(undoRequestOf("تَراجَع")).toEqual({ kind: "any" });
    expect(undoRequestOf("Undo last file change")).toEqual({ kind: "files" });
    expect(undoRequestOf("تراجع عن آخر تغيير في الملفات")).toEqual({ kind: "files" });
  });
  it("leaves longer requests to the model", () => {
    expect(undoRequestOf("undo the firefox install and then update")).toBeUndefined();
    expect(undoRequestOf("how do I undo in vim")).toBeUndefined();
  });
  it("titles a step from its card items", () => {
    expect(stepTitle(["Set brightness to 80%"])).toBe("Set brightness to 80%");
    expect(stepTitle(["Move a.png", "Move b.png", "Move c.png"])).toBe("Move a.png (+2 more)");
    expect(stepTitle([])).toBe("the last change");
  });
});
