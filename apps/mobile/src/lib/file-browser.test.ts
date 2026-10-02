import { describe, expect, it } from "vitest";
import { childPath, crumbs, listDir, parseDirEntries, shellQuote } from "./file-browser";

describe("parseDirEntries", () => {
  it("keeps sound entries, folders first then by name", () => {
    expect(
      parseDirEntries([
        { name: "z.ts", directory: false },
        { name: "src", directory: true },
        { name: "a.ts", directory: false },
        { name: "..", directory: true },
        { name: "a/b", directory: false },
        { name: "x", directory: "yes" },
        "junk",
      ]),
    ).toEqual([
      { name: "src", directory: true },
      { name: "a.ts", directory: false },
      { name: "z.ts", directory: false },
    ]);
  });
});

describe("paths", () => {
  it("joins and splits relative paths", () => {
    expect(childPath("", "src")).toBe("src");
    expect(childPath("src", "db")).toBe("src/db");
    expect(crumbs("src/db/x")).toEqual([
      { name: "src", path: "src" },
      { name: "db", path: "src/db" },
      { name: "x", path: "src/db/x" },
    ]);
    expect(crumbs("")).toEqual([]);
  });

  it("quotes a path only when the shell would read it as syntax", () => {
    expect(shellQuote("src/index.ts")).toBe("src/index.ts");
    expect(shellQuote("my file.ts")).toBe("'my file.ts'");
    expect(shellQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`);
  });
});

describe("listDir", () => {
  it("asks for the pane's relative path and reads nothing from a refusal", async () => {
    const calls: unknown[][] = [];
    const ok = {
      call: async (_: string, args: unknown[]) => {
        calls.push(args);
        return { ok: true as const, value: [{ name: "a", directory: false }] };
      },
    };
    expect(await listDir(ok as never, "tab-1", "src")).toEqual([{ name: "a", directory: false }]);
    expect(calls).toEqual([["tab-1", "src"]]);
    const refused = {
      call: async () => ({ ok: false as const, error: { kind: "offline" as const } }),
    };
    expect(await listDir(refused as never, "tab-1", "")).toBeUndefined();
  });
});
