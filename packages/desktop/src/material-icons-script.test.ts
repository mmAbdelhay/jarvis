import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSvg, plainFileName, vendorIcons } from "../scripts/material-icons-lib.mjs";

const SAFE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#0288d1" d="M2 2v12h12V2z"/></svg>';

describe("checkSvg", () => {
  it("accepts a plain drawing, local references and a gradient", () => {
    expect(checkSvg(SAFE)).toEqual({ ok: true });
    expect(
      checkSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><use href="#g"/><path fill="url(#g)"/></svg>',
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    ["a script", "<svg><script>alert(1)</script></svg>"],
    ["an upper-case script", '<svg><SCRIPT src="x"></SCRIPT></svg>'],
    ["an event handler", '<svg><path onload="x()" d="M0 0"/></svg>'],
    ["an event handler with spaces", '<svg><path onclick = "x()" d="M0 0"/></svg>'],
    ["a foreignObject", "<svg><foreignObject><div/></foreignObject></svg>"],
    ["an outside href", '<svg><image href="https://example.com/a.png"/></svg>'],
    ["an outside xlink:href", '<svg><use xlink:href="http://example.com/a.svg#x"/></svg>'],
    ["a file href", '<svg><image href="file:///etc/passwd"/></svg>'],
    ["a data href", '<svg><image href="data:image/svg+xml;base64,AAAA"/></svg>'],
    ["a javascript href", '<svg><a href="javascript:alert(1)"/></svg>'],
    ["an outside url()", '<svg><path style="fill:url(https://example.com/x)"/></svg>'],
    ["an entity", '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>'],
    ["an iframe", "<svg><iframe src='x'/></svg>"],
  ])("refuses %s", (_name, svg) => {
    expect(checkSvg(svg).ok).toBe(false);
  });
});

describe("plainFileName", () => {
  it("takes plain svg names only", () => {
    expect(plainFileName("typescript.svg")).toBe(true);
    expect(plainFileName("folder-src-open.svg")).toBe(true);
    for (const bad of [
      "../x.svg",
      "a/b.svg",
      "a\\b.svg",
      ".hidden.svg",
      "x.png",
      "x.svg\0",
      "",
      "a b.svg",
    ]) {
      expect(plainFileName(bad), bad).toBe(false);
    }
  });
});

describe("vendorIcons", () => {
  let root: string;
  let from: string;
  let to: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "material-icons-"));
    from = join(root, "package");
    to = join(root, "out");
    mkdirSync(join(from, "dist"), { recursive: true });
    mkdirSync(join(from, "icons"), { recursive: true });
    writeFileSync(join(from, "LICENSE"), "MIT licence text\n");
    writeFileSync(
      join(from, "package.json"),
      JSON.stringify({ name: "material-icon-theme", version: "9.9.9" }),
    );
    for (const name of [
      "file",
      "folder",
      "folder-open",
      "typescript",
      "git",
      "folder-src",
      "folder-src-open",
      "unused",
    ]) {
      writeFileSync(join(from, "icons", `${name}.svg`), `${SAFE}<!-- ${name} -->`);
    }
    writeFileSync(
      join(from, "dist", "material-icons.json"),
      JSON.stringify({
        iconDefinitions: Object.fromEntries(
          [
            "file",
            "folder",
            "folder-open",
            "typescript",
            "git",
            "folder-src",
            "folder-src-open",
            "unused",
            "file_light",
          ].map((id) => [id, { iconPath: `./../icons/${id}.svg` }]),
        ),
        file: "file",
        folder: "folder",
        folderExpanded: "folder-open",
        fileNames: { ".GitIgnore": "git", ".config/thing": "git", constructor: "git" },
        fileExtensions: { TS: "typescript", "test.ts": "typescript" },
        folderNames: { SRC: "folder-src" },
        folderNamesExpanded: { SRC: "folder-src-open" },
        languageIds: { typescript: "typescript" },
        light: { fileExtensions: { ts: "file_light" } },
      }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("copies the licence and only the referenced icons, byte for byte", () => {
    const result = vendorIcons({ from, to });
    expect(readFileSync(join(to, "LICENSE"), "utf8")).toBe("MIT licence text\n");
    expect(readdirSync(join(to, "icons")).sort()).toEqual([
      "file.svg",
      "folder-open.svg",
      "folder-src-open.svg",
      "folder-src.svg",
      "folder.svg",
      "git.svg",
      "typescript.svg",
    ]);
    expect(readFileSync(join(to, "icons", "git.svg"), "utf8")).toBe(
      readFileSync(join(from, "icons", "git.svg"), "utf8"),
    );
    expect(result.icons).toBe(7);
  });

  it("writes a table of plain file names under lower-case keys, without light variants", async () => {
    vendorIcons({ from, to });
    const table = (await import(`${join(to, "table.mjs")}?${Math.random()}`)).default;
    expect(table).toMatchObject({
      version: "9.9.9",
      file: "file.svg",
      folder: "folder.svg",
      folderExpanded: "folder-open.svg",
      fileExtensions: { ts: "typescript.svg", "test.ts": "typescript.svg" },
      folderNames: { src: "folder-src.svg" },
      folderNamesExpanded: { src: "folder-src-open.svg" },
      languageIds: { typescript: "typescript.svg" },
    });
    expect(Object.keys(table.fileNames)).toEqual([".gitignore", ".config/thing", "constructor"]);
    expect(JSON.stringify(table)).not.toContain("light");
    expect(JSON.stringify(table)).not.toMatch(/[\\]|\.\.\//);
  });

  it("refuses an unsafe icon and writes nothing", () => {
    writeFileSync(join(from, "icons", "git.svg"), "<svg><script>x</script></svg>");
    expect(() => vendorIcons({ from, to })).toThrow(/git\.svg/);
    expect(() => readdirSync(to)).toThrow();
  });

  it("refuses a table entry that names a path instead of a file", () => {
    const table = JSON.parse(readFileSync(join(from, "dist", "material-icons.json"), "utf8"));
    table.iconDefinitions.git.iconPath = "./../../../etc/passwd.svg";
    writeFileSync(join(from, "dist", "material-icons.json"), JSON.stringify(table));
    expect(() => vendorIcons({ from, to })).toThrow(/git/);
  });

  it("refuses a missing icon file", () => {
    rmSync(join(from, "icons", "typescript.svg"));
    expect(() => vendorIcons({ from, to })).toThrow(/typescript/);
  });
});
