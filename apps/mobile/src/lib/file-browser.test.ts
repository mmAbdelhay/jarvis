import { describe, expect, it, vi } from "vitest";
import {
  childPath,
  crumbs,
  FILE_OP_ERROR_KEYS,
  listDir,
  parseDirEntries,
  parseFileOp,
  renameEntry,
  shellQuote,
  trashEntry,
  validateEntryName,
} from "./file-browser";
import { STRINGS } from "./i18n";

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

describe("file operations", () => {
  it("validates a new name before asking the laptop", () => {
    expect(validateEntryName("notes.md")).toBeUndefined();
    for (const bad of ["", "  ", ".", "..", "a/b", "a\\b", "a\nb"]) {
      expect(validateEntryName(bad)).toBe("invalid-name");
    }
  });

  it("parses a FileOpResult field by field", () => {
    expect(parseFileOp({ ok: true, path: "a/b" })).toEqual({ ok: true });
    expect(parseFileOp({ ok: false, reason: "exists" })).toEqual({ ok: false, reason: "exists" });
    expect(parseFileOp({ ok: false, reason: "weird" })).toEqual({ ok: false, reason: "failed" });
    expect(parseFileOp(null)).toEqual({ ok: false, reason: "failed" });
  });

  it("builds the rename and trash calls with project-relative paths", async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: { ok: true, path: "x" } }));
    const client = { call } as unknown as Parameters<typeof renameEntry>[0];
    expect(await renameEntry(client, "pane", "src/a.ts", "b.ts")).toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith(
      "terminal:renameEntry",
      ["pane", "src/a.ts", "b.ts"],
      expect.anything(),
    );
    expect(await trashEntry(client, "pane", "src/a.ts")).toEqual({ ok: true });
    expect(call).toHaveBeenLastCalledWith(
      "terminal:trashEntry",
      ["pane", "src/a.ts"],
      expect.anything(),
    );
    call.mockClear();
    expect(await renameEntry(client, "pane", "src/a.ts", "../x")).toEqual({
      ok: false,
      reason: "invalid-name",
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("reports a transport failure as a plain failure", async () => {
    const client = {
      call: async () => ({ ok: false as const, error: { kind: "offline" } }),
    } as unknown as Parameters<typeof trashEntry>[0];
    expect(await trashEntry(client, "p", "a")).toEqual({ ok: false, reason: "failed" });
  });

  it("has a bilingual message for every refusal", () => {
    for (const key of Object.values(FILE_OP_ERROR_KEYS)) {
      expect(STRINGS[key].ar).not.toBe(STRINGS[key].en);
    }
  });
});
