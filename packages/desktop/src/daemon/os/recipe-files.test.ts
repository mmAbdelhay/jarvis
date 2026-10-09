import { describe, expect, it } from "vitest";
import {
  MAX_RECIPE_FILES,
  loadRecipeFiles,
  MAX_RECIPE_FILE_BYTES,
  parseOsReleaseId,
} from "./recipe-files.js";

function io(files: Record<string, string>) {
  return {
    listDir: async () => Object.keys(files).map((path) => path.slice("/r/".length)),
    readFile: async (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    },
  };
}

describe("recipe files on disk (M4 §4)", () => {
  it("reads *.json in name order and skips everything else", async () => {
    const lines: string[] = [];
    const loaded = await loadRecipeFiles(
      "/r",
      io({
        "/r/node-dev.json": '{"id":"node-dev"}',
        "/r/docker.json": '{"id":"docker"}',
        "/r/README.md": "#",
        "/r/.hidden.json": "{}",
        "/r/bad.json": "{",
        "/r/huge.json": `{"x":"${"a".repeat(MAX_RECIPE_FILE_BYTES)}"}`,
      }),
      (line) => lines.push(line),
    );
    expect(loaded).toEqual([{ id: "docker" }, { id: "node-dev" }]);
    expect(lines.some((l) => l.includes("bad.json"))).toBe(true);
    expect(lines.some((l) => l.includes("huge.json"))).toBe(true);
  });

  it("has no recipes when the directory is missing", async () => {
    const missing = {
      listDir: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      readFile: async () => "",
    };
    expect(await loadRecipeFiles("/r", missing, () => {})).toEqual([]);
  });

  it("reads ID from /etc/os-release", () => {
    expect(parseOsReleaseId('NAME="Rafiq"\nID=rafiq\nID_LIKE=debian\n')).toBe("rafiq");
    expect(parseOsReleaseId('ID="debian"\n')).toBe("debian");
    expect(parseOsReleaseId("NAME=x\n")).toBeNull();
    expect(parseOsReleaseId("ID=$(reboot)\n")).toBeNull();
  });
});

describe("recipe loader limits", () => {
  it("caps reads at 100 sorted valid filenames and refuses path traversal", async () => {
    const names = Array.from(
      { length: 101 },
      (_, i) => `r-${String(i).padStart(3, "0")}.json`,
    ).reverse();
    const paths: string[] = [];
    const loaded = await loadRecipeFiles(
      "/r",
      {
        listDir: async () => ["../escape.json", "/absolute.json", ...names],
        readFile: async (path) => {
          paths.push(path);
          return "{}";
        },
      },
      () => {},
    );
    expect(loaded).toHaveLength(MAX_RECIPE_FILES);
    expect(paths).toHaveLength(100);
    expect(paths[0]).toBe("/r/r-000.json");
    expect(paths[99]).toBe("/r/r-099.json");
  });

  it("measures UTF-8 bytes and continues after an unreadable file", async () => {
    const lines: string[] = [];
    const loaded = await loadRecipeFiles(
      "/r",
      {
        listDir: async () => ["a.json", "b.json", "c.json"],
        readFile: async (path) => {
          if (path === "/r/a.json") throw new Error("unreadable");
          return path === "/r/b.json" ? JSON.stringify("é".repeat(32768)) : '{"id":"c"}';
        },
      },
      (line) => lines.push(line),
    );
    expect(loaded).toEqual([{ id: "c" }]);
    expect(lines).toHaveLength(2);
  });
});
