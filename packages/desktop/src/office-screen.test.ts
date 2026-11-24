import { describe, expect, it, vi } from "vitest";
import {
  createOfficeScreen,
  OFFICE_SCREEN_COLS,
  OFFICE_SCREEN_PANES,
  OFFICE_SCREEN_ROWS,
  type OfficeScreenDeps,
} from "./office-screen.js";

function deps(overrides: Partial<OfficeScreenDeps> = {}): OfficeScreenDeps {
  return {
    tabs: () => [
      { id: "t1", kind: "terminal" },
      { id: "w1", kind: "web" },
    ],
    panes: () => [
      { paneKey: "t1", exited: false },
      { paneKey: "t1:p2", exited: false },
    ],
    screenText: (key) => (key === "t1" ? "one\ntwo" : "second"),
    paneLog: () => "",
    sessions: () => [{ id: "s1" }],
    sessionLog: () => "log line\n",
    agentOf: () => undefined,
    log: () => undefined,
    ...overrides,
  };
}

describe("office:screen validation", () => {
  it.each([
    undefined,
    null,
    "t1",
    {},
    { type: "tab" },
    { type: "tab", id: 4 },
    { type: "other", id: "t1" },
    { type: "tab", id: "" },
    { type: "tab", id: "x".repeat(300) },
    { type: "tab", id: "nope" },
    { type: "pane", id: "nope" },
    { type: "session", id: "nope" },
    { type: "tab", id: "w1" },
  ])("answers none for %j", (target) => {
    expect(createOfficeScreen(deps()).read(target)).toEqual({ kind: "none" });
  });

  it("refuses a pane that has exited or whose tab is not a terminal", () => {
    const screen = createOfficeScreen(
      deps({
        panes: () => [
          { paneKey: "t1", exited: true },
          { paneKey: "w1:p", exited: false },
        ],
      }),
    );
    expect(screen.read({ type: "pane", id: "t1" })).toEqual({ kind: "none" });
    expect(screen.read({ type: "pane", id: "w1:p" })).toEqual({ kind: "none" });
  });
});

describe("office:screen content", () => {
  it("answers one section per live pane of a split tab, the asking pane first", () => {
    const screen = createOfficeScreen(
      deps({ agentOf: (key) => (key === "t1" ? "Codex" : undefined) }),
    );
    expect(screen.read({ type: "tab", id: "t1" })).toEqual({
      kind: "terminal",
      sections: [
        { paneKey: "t1", agent: "Codex", lines: ["one", "two"] },
        { paneKey: "t1:p2", lines: ["second"] },
      ],
    });
    const asking = screen.read({ type: "pane", id: "t1:p2" });
    expect(asking).toMatchObject({
      kind: "terminal",
      sections: [{ paneKey: "t1:p2" }, { paneKey: "t1" }],
    });
  });

  it("skips exited panes and keeps at most four sections", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      paneKey: i === 0 ? "t1" : `t1:p${i}`,
      exited: i === 1,
    }));
    const result = createOfficeScreen(deps({ panes: () => many })).read({ type: "tab", id: "t1" });
    if (result.kind !== "terminal") throw new Error("terminal expected");
    expect(result.sections).toHaveLength(OFFICE_SCREEN_PANES);
    expect(result.sections.map((s) => s.paneKey)).not.toContain("t1:p1");
  });

  it("keeps the last 16 rows with no trailing blank rows, each at most 200 characters", () => {
    const rows = Array.from({ length: 40 }, (_, i) => `row ${i}`);
    const text = `${rows.join("\n")}\n\n   \n`;
    const long = createOfficeScreen(
      deps({ screenText: () => `${text}`.replace("row 39", "y".repeat(500)) }),
    );
    const result = long.read({ type: "tab", id: "t1" });
    if (result.kind !== "terminal") throw new Error("terminal expected");
    const lines = result.sections[0]?.lines ?? [];
    expect(lines).toHaveLength(OFFICE_SCREEN_ROWS);
    expect(lines[0]).toBe("row 24");
    expect(lines.at(-1)).toBe("y".repeat(OFFICE_SCREEN_COLS));
  });

  it("strips control characters and escapes, and leaves hostile text as text", () => {
    const hostile = "\u001b[31mred\u001b[0m\u0007\u0000 <img src=x onerror=alert(1)>\u009b\ttab";
    const result = createOfficeScreen(deps({ screenText: () => hostile })).read({
      type: "tab",
      id: "t1",
    });
    if (result.kind !== "terminal") throw new Error("terminal expected");
    const line = result.sections[0]?.lines[0] ?? "";
    expect(line).toContain("red <img src=x onerror=alert(1)>");
    const controls = [...line].filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    });
    expect(controls).toEqual([]);
  });

  it("falls back to the retained log, ANSI stripped, for a pane with no screen yet", () => {
    const result = createOfficeScreen(
      deps({
        screenText: () => undefined,
        paneLog: () => "\u001b[1mhello\u001b[0m\r\nprogress 10%\rprogress 90%\n\n",
      }),
    ).read({ type: "tab", id: "t1" });
    if (result.kind !== "terminal") throw new Error("terminal expected");
    expect(result.sections[0]?.lines).toEqual(["hello", "progress 90%"]);
  });

  it("answers a session with its retained log tail under the same limits", () => {
    const log = `${Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n")}\n`;
    const result = createOfficeScreen(deps({ sessionLog: () => log })).read({
      type: "session",
      id: "s1",
    });
    expect(result).toMatchObject({ kind: "session" });
    if (result.kind !== "session") throw new Error("session expected");
    expect(result.lines).toHaveLength(OFFICE_SCREEN_ROWS);
    expect(result.lines.at(-1)).toBe("l29");
  });

  it("is side-effect free and never throws: a failing source answers none, logging a token only", () => {
    const log = vi.fn();
    const result = createOfficeScreen(
      deps({
        tabs: () => {
          throw new Error("secret content");
        },
        log,
      }),
    ).read({ type: "tab", id: "t1" });
    expect(result).toEqual({ kind: "none" });
    expect(log).toHaveBeenCalledWith("office-screen: read");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });

  it("only reads: it calls no writer and logs nothing on success", () => {
    const log = vi.fn();
    const base = deps({ log });
    createOfficeScreen(base).read({ type: "tab", id: "t1" });
    expect(log).not.toHaveBeenCalled();
    expect(Object.keys(base).sort()).toEqual(
      ["agentOf", "log", "paneLog", "panes", "screenText", "sessionLog", "sessions", "tabs"].sort(),
    );
  });
});
