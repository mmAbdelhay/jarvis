import { describe, expect, it } from "vitest";
import { breadcrumbParts, filesPaneFor, tabRowModel } from "./workspace-rows";

describe("tabRowModel", () => {
  it("shows a terminal tab with its pane count", () => {
    expect(tabRowModel({ kind: "terminal", title: "claude-main" }, "en", 2)).toEqual({
      icon: "terminal",
      tone: "accent",
      title: "Terminal · claude-main",
      subtitle: "2 panes",
    });
    expect(tabRowModel({ kind: "terminal", title: "a" }, "en", 1).subtitle).toBe("1 pane");
  });

  it("has a subtitle for a terminal whose panes are unread", () => {
    expect(tabRowModel({ kind: "terminal", title: "a" }, "en").subtitle).toBe(
      "tap to see its panes",
    );
  });

  it("shows a database tab as proxied", () => {
    expect(tabRowModel({ kind: "database", title: "dev" }, "en")).toEqual({
      icon: "database",
      tone: "success",
      title: "Database · dev",
      subtitle: "opens through the secure proxy",
    });
  });

  it("shows an editor tab with its own kind", () => {
    const row = tabRowModel({ kind: "editor", title: "main.ts" }, "en");
    expect(row.title).toBe("Editor · main.ts");
    expect(row.tone).toBe("muted");
  });

  it("keeps the laptop's title and falls back to the kind when it is empty", () => {
    expect(tabRowModel({ kind: "docker", title: "My Custom" }, "en").title).toBe(
      "Docker · My Custom",
    );
    expect(tabRowModel({ kind: "docker", title: "" }, "en").title).toBe("Docker");
  });

  it("differs in Arabic", () => {
    expect(tabRowModel({ kind: "database", title: "dev" }, "ar").subtitle).not.toBe(
      tabRowModel({ kind: "database", title: "dev" }, "en").subtitle,
    );
  });
});

describe("filesPaneFor", () => {
  it("is the first terminal tab", () => {
    expect(
      filesPaneFor([
        { id: "d", kind: "docker" },
        { id: "t1", kind: "terminal" },
        { id: "t2", kind: "terminal" },
      ]),
    ).toBe("t1");
  });

  it("is undefined with no terminal tab", () => {
    expect(filesPaneFor([{ id: "d", kind: "docker" }])).toBeUndefined();
    expect(filesPaneFor([])).toBeUndefined();
  });
});

describe("breadcrumbParts", () => {
  it("flags only the last segment as current", () => {
    expect(breadcrumbParts("project", "src/db")).toEqual([
      { name: "project", path: "", current: false },
      { name: "src", path: "src", current: false },
      { name: "db", path: "src/db", current: true },
    ]);
  });

  it("flags the root at the root", () => {
    expect(breadcrumbParts("project", "")).toEqual([{ name: "project", path: "", current: true }]);
  });
});
