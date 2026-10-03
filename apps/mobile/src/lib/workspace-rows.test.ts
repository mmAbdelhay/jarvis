import { describe, expect, it } from "vitest";
import {
  breadcrumbParts,
  defaultWorkspaceProject,
  requestedWorkspaceProject,
  filesPaneFor,
  tabRowModel,
} from "./workspace-rows";

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

describe("defaultWorkspaceProject", () => {
  it("opens on the first project with a laptop tab, else the first one", () => {
    expect(
      defaultWorkspaceProject(
        [
          { name: "api", tabs: [] },
          { name: "web", tabs: [{}] },
        ],
        undefined,
      ),
    ).toBe("web");
    expect(defaultWorkspaceProject([{ name: "api", tabs: [] }], undefined)).toBe("api");
  });

  it("keeps a chosen project and chooses nothing from an empty list", () => {
    expect(defaultWorkspaceProject([{ name: "api", tabs: [{}] }], "web")).toBeUndefined();
    expect(defaultWorkspaceProject([], undefined)).toBeUndefined();
  });
});

describe("requestedWorkspaceProject", () => {
  const projects = [{ name: "api" }, { name: "web" }];
  it("names a listed project that is not selected yet", () => {
    expect(requestedWorkspaceProject(projects, "web", "api")).toBe("web");
    expect(requestedWorkspaceProject(projects, "web", undefined)).toBe("web");
  });
  it("ignores an unknown, absent or already selected project", () => {
    expect(requestedWorkspaceProject(projects, "nope", "api")).toBeUndefined();
    expect(requestedWorkspaceProject(projects, undefined, "api")).toBeUndefined();
    expect(requestedWorkspaceProject(projects, "web", "web")).toBeUndefined();
  });
});
