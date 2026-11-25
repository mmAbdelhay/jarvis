import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkSvg, plainFileName } from "../scripts/material-icons-lib.mjs";
import table from "../renderer/vendor/material-icons/table.mjs";

const HERE = import.meta.dirname;
const VENDOR = join(HERE, "..", "renderer", "vendor", "material-icons");

function referenced(): Set<string> {
  const names = new Set<string>([table.file, table.folder, table.folderExpanded]);
  for (const map of [
    table.fileNames,
    table.fileExtensions,
    table.folderNames,
    table.folderNamesExpanded,
    table.languageIds,
  ]) {
    for (const name of Object.values(map)) names.add(name);
  }
  return names;
}

describe("the vendored Material icons", () => {
  it("holds exactly the pictures the table names, all plain and safe", () => {
    const files = readdirSync(join(VENDOR, "icons")).sort();
    expect(files).toEqual([...referenced()].sort());
    for (const name of files) {
      expect(plainFileName(name), name).toBe(true);
      expect(checkSvg(readFileSync(join(VENDOR, "icons", name), "utf8")), name).toEqual({
        ok: true,
      });
    }
  });

  it("is the 5.40.0 release, with its MIT licence beside it", () => {
    expect(table.version).toBe("5.40.0");
    expect(readFileSync(join(VENDOR, "LICENSE"), "utf8")).toMatch(/MIT License/i);
  });

  it("has no light variants, and the keys are lower case", () => {
    expect(JSON.stringify(table)).not.toContain("_light");
    for (const key of Object.keys(table.fileNames)) expect(key).toBe(key.toLowerCase());
  });

  it("is named in the third-party notice", () => {
    const notice = readFileSync(join(HERE, "..", "..", "..", "NOTICE"), "utf8");
    expect(notice).toContain("Material Icon Theme");
    expect(notice).toContain("5.40.0");
  });

  it("travels in the build: the copy step takes the whole vendor folder, and mac and Linux list it", () => {
    const copy = readFileSync(join(HERE, "..", "scripts", "copy-vendor.mjs"), "utf8");
    expect(copy).toMatch(/cp\(from, to, \{ recursive: true \}\)/);
    const config = parse(readFileSync(join(HERE, "..", "electron-builder.yml"), "utf8")) as {
      mac: { files: string[] };
      linux: { files: string[] };
    };
    for (const platform of [config.mac, config.linux]) {
      expect(platform.files).toContain("renderer/vendor/**/*");
      expect(platform.files).not.toContain("!renderer/vendor/material-icons/**");
    }
    expect(existsSync(join(VENDOR, "table.mjs"))).toBe(true);
  });
});
