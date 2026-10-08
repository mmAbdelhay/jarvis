// theme.ts is the only place a colour is written: screens and components take
// every colour from it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { theme } from "./theme";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = resolve(HERE, "../..");

const HEX_COLOUR = /#[0-9a-fA-F]{3,8}\b/;

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function collectTsx(dir: string, recursive: boolean): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (recursive) {
        files.push(...collectTsx(full, true));
      }
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe("theme", () => {
  it("keeps hex colour literals out of app/, src/components, src/screens and src/plan", () => {
    const files = [
      ...collectTsx(join(MOBILE_ROOT, "app"), true),
      ...collectTsx(join(MOBILE_ROOT, "src", "components"), true),
      ...collectTsx(join(MOBILE_ROOT, "src", "screens"), true),
      ...collectTsx(join(MOBILE_ROOT, "src", "plan"), false).filter((f) => f.endsWith(".tsx")),
    ];
    const offenders = files.filter((file) =>
      HEX_COLOUR.test(stripComments(readFileSync(file, "utf8"))),
    );
    expect(offenders, `hex colour literal found in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("loads a font file for every face the theme names", () => {
    const faces = [
      theme.font.body,
      theme.font.medium,
      theme.font.semibold,
      theme.font.bold,
      theme.font.extrabold,
      theme.font.mono,
      theme.font.monoMedium,
      theme.font.monoSemibold,
    ];
    // Read as text: app-fonts.ts requires .ttf files, which Node cannot load.
    const source = readFileSync(join(HERE, "app-fonts.ts"), "utf8");
    for (const face of faces) {
      expect(source, face).toMatch(new RegExp(`^  ${face}: require\\(`, "m"));
    }
  });

  it("only names faces from the theme in the type presets", () => {
    const faces = new Set<string>(Object.values(theme.font).filter((v) => typeof v === "string"));
    for (const [name, preset] of Object.entries(theme.type)) {
      expect(faces.has(preset.fontFamily), name).toBe(true);
    }
  });
});
