// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  EXTENSION_LANGUAGES,
  fileIcon,
  fileIconFor,
  folderIcon,
  folderIconFor,
  setFolderIcon,
} from "./file-icons.js";
import table from "./vendor/material-icons/table.mjs";

const COMMON = [
  "package.json",
  "tsconfig.json",
  "index.ts",
  "app.tsx",
  "main.js",
  "App.jsx",
  "script.mjs",
  "x.cjs",
  "main.py",
  "index.php",
  "main.go",
  "lib.rs",
  "Main.java",
  "Main.kt",
  "app.swift",
  "main.c",
  "util.h",
  "a.cpp",
  "a.hpp",
  "Program.cs",
  "a.rb",
  "a.lua",
  "a.pl",
  "run.sh",
  "a.bash",
  "a.zsh",
  "a.ps1",
  "q.sql",
  "a.json",
  "a.yaml",
  "a.yml",
  "a.toml",
  "a.xml",
  "a.html",
  "a.css",
  "a.scss",
  "a.md",
  "README.md",
  "Dockerfile",
  "Makefile",
  ".gitignore",
  ".env",
  "LICENSE",
  "a.vue",
  "a.svelte",
  "a.tf",
  "a.proto",
  "a.graphql",
  "a.svg",
  "a.log",
  "a.csv",
  "pnpm-lock.yaml",
  "vite.config.ts",
  ".eslintrc.json",
  ".prettierrc",
  "biome.json",
  "a.dart",
  "a.scala",
  "a.ex",
  "a.hs",
  "a.ipynb",
  "a.pyi",
  "a.fish",
];

describe("fileIconFor", () => {
  it("gives common files their own icon, not the generic one (at least 40 names)", () => {
    expect(COMMON.length).toBeGreaterThanOrEqual(40);
    for (const name of COMMON) {
      expect(fileIconFor(name), name).not.toBe(table.file);
    }
  });

  it("matches the whole name first, case-insensitively", () => {
    expect(fileIconFor("package.json")).toBe(table.fileNames["package.json"]);
    expect(fileIconFor("PACKAGE.JSON")).toBe(table.fileNames["package.json"]);
    expect(fileIconFor("Dockerfile")).toBe(fileIconFor("dockerfile"));
  });

  it("prefers the longest compound extension", () => {
    expect(fileIconFor("foo.test.ts")).toBe(table.fileExtensions["test.ts"]);
    expect(fileIconFor("foo.test.ts")).not.toBe(fileIconFor("foo.ts"));
    expect(fileIconFor("a.b.c.ts")).toBe(fileIconFor("x.ts"));
  });

  it("falls back to the language of an extension the theme does not list", () => {
    expect(Object.hasOwn(table.fileExtensions, "pyx")).toBe(false);
    expect(fileIconFor("fast.pyx")).toBe(table.languageIds["python"]);
    expect(Object.hasOwn(table.fileExtensions, "bats")).toBe(false);
    expect(fileIconFor("t.bats")).toBe(table.languageIds["shellscript"]);
  });

  it("maps every extension of its own language table to a language the theme has", () => {
    for (const [extension, language] of Object.entries(EXTENSION_LANGUAGES)) {
      expect(Object.hasOwn(table.languageIds, language), `${extension} -> ${language}`).toBe(true);
    }
  });

  it("uses own properties only: constructor and __proto__ are plain files", () => {
    for (const name of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
      ".constructor",
      "a.__proto__",
    ]) {
      expect(fileIconFor(name), name).toBe(table.file);
    }
  });

  it("handles path-keyed names through the parent folder", () => {
    expect(fileIconFor("graphqlrc.json", { parent: ".config" })).toBe(
      table.fileNames[".config/graphqlrc.json"],
    );
    expect(fileIconFor("graphqlrc.json", { parent: "src" })).not.toBe(
      table.fileNames[".config/graphqlrc.json"],
    );
  });

  it("is generic for an empty or odd name", () => {
    expect(fileIconFor("")).toBe(table.file);
    expect(fileIconFor("noextension")).toBe(table.file);
    expect(fileIconFor("trailingdot.")).toBe(table.file);
  });
});

describe("folderIconFor", () => {
  it("knows named folders, open and closed", () => {
    expect(folderIconFor("src", false)).toBe(table.folderNames["src"]);
    expect(folderIconFor("src", true)).toBe(table.folderNamesExpanded["src"]);
    expect(folderIconFor("SRC", false)).toBe(table.folderNames["src"]);
    expect(folderIconFor("src", true)).not.toBe(folderIconFor("src", false));
  });

  it("uses the generic folder, open or closed, for an unknown name and own properties only", () => {
    expect(folderIconFor("zzz-unknown", false)).toBe(table.folder);
    expect(folderIconFor("zzz-unknown", true)).toBe(table.folderExpanded);
    expect(folderIconFor("constructor", false)).toBe(table.folder);
    expect(folderIconFor("__proto__", true)).toBe(table.folderExpanded);
  });

  it("handles path-keyed folders through the parent", () => {
    expect(folderIconFor("workflows", false, { parent: ".github" })).toBe(
      table.folderNames[".github/workflows"],
    );
  });
});

describe("the image", () => {
  it("is a quiet 16px lazy image from the vendor folder", () => {
    const img = fileIcon("index.ts");
    expect(img.tagName).toBe("IMG");
    expect(img.alt).toBe("");
    expect(img.getAttribute("aria-hidden")).toBe("true");
    expect(img.draggable).toBe(false);
    expect(img.loading).toBe("lazy");
    expect(img.decoding).toBe("async");
    expect(img.width).toBe(16);
    expect(img.getAttribute("src")).toBe(`vendor/material-icons/icons/${fileIconFor("index.ts")}`);
    expect(img.className).toContain("file-icon");
  });

  it("falls back to the generic icon once when the image is missing", () => {
    const img = fileIcon("index.ts");
    img.dispatchEvent(new Event("error"));
    expect(img.getAttribute("src")).toBe(`vendor/material-icons/icons/${table.file}`);
    img.dispatchEvent(new Event("error"));
    expect(img.getAttribute("src")).toBe(`vendor/material-icons/icons/${table.file}`);
    expect(img.hidden).toBe(true);
  });

  it("swaps a folder's picture when it opens", () => {
    const img = folderIcon("src", { expanded: false });
    const closed = img.getAttribute("src");
    setFolderIcon(img, "src", true);
    expect(img.getAttribute("src")).not.toBe(closed);
    expect(img.getAttribute("src")).toBe(
      `vendor/material-icons/icons/${table.folderNamesExpanded["src"]}`,
    );
  });
});
