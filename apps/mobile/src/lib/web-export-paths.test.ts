// The web export ships inside the desktop app at <resources>/web, so every
// exported path must stay short (Windows MAX_PATH). See
// scripts/web-export-paths.cjs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  overlongPaths,
  vendoredWebAsset,
  WEB_EXPORT_PATH_LIMIT,
} from "../../scripts/web-export-paths.cjs";

const mobileDir = fileURLToPath(new URL("../..", import.meta.url));

describe("overlongPaths", () => {
  it("allows exactly 100 characters by default and flags 101", () => {
    expect(WEB_EXPORT_PATH_LIMIT).toBe(100);
    const at = "a".repeat(100);
    const over = "b".repeat(101);
    expect(overlongPaths([at, over, "index.html"])).toEqual([over]);
  });

  it("measures Windows paths with / separators, and reports them that way", () => {
    const windows = `assets\\${"x".repeat(93)}`;
    expect(overlongPaths([windows])).toEqual([]);
    expect(overlongPaths([`${windows}y`])).toEqual([`assets/${"x".repeat(93)}y`]);
  });

  it("takes an explicit limit", () => {
    expect(overlongPaths(["abcd", "abc"], 3)).toEqual(["abcd"]);
  });
});

describe("vendoredWebAsset", () => {
  const vendorDir = join("/app", "assets", "web-vendor");
  const vendored = new Set([join(vendorDir, "back-icon.png"), join(vendorDir, "back-icon@2x.png")]);
  const exists = (path: string) => vendored.has(path);

  it("leaves the app's own assets alone", () => {
    const own = join("/app", "assets", "icon.png");
    expect(vendoredWebAsset([own], vendorDir, exists)).toEqual([own]);
  });

  it("swaps each node_modules file (every scale) for its vendored copy", () => {
    const pkg = "/repo/node_modules/.pnpm/expo-router@1_x/node_modules/expo-router/assets";
    expect(
      vendoredWebAsset([`${pkg}/back-icon.png`, `${pkg}/back-icon@2x.png`], vendorDir, exists),
    ).toEqual([join(vendorDir, "back-icon.png"), join(vendorDir, "back-icon@2x.png")]);
  });

  it("recognises a Windows node_modules path", () => {
    expect(
      vendoredWebAsset(["C:\\repo\\node_modules\\expo-router\\back-icon.png"], vendorDir, exists),
    ).toEqual([join(vendorDir, "back-icon.png")]);
  });

  it("fails the build, naming the file, when a node_modules asset has no vendored copy", () => {
    expect(() =>
      vendoredWebAsset(["/repo/node_modules/pkg/new-icon.png"], vendorDir, exists),
    ).toThrow("web export: /repo/node_modules/pkg/new-icon.png is an asset inside node_modules");
  });
});

describe("assets/web-vendor", () => {
  it("is byte-identical to the installed expo-router's own images", () => {
    // pnpm links the app's own dependency here (the installed version).
    const routerAssets = join(mobileDir, "node_modules", "expo-router", "assets");
    const vendorDir = join(mobileDir, "assets", "web-vendor");
    const images = readdirSync(vendorDir).filter((name) => name.endsWith(".png"));
    expect(images.length).toBeGreaterThan(0);
    for (const name of images) {
      const upstream = [
        join(routerAssets, name),
        join(routerAssets, "react-navigation", "elements", name),
      ].find(existsSync);
      expect(upstream, name).toBeDefined();
      expect(readFileSync(join(vendorDir, name), "base64"), name).toBe(
        readFileSync(upstream ?? "", "base64"),
      );
    }
  });
});

describe("app fonts", () => {
  it("are the vendored files, each of which exists", () => {
    const source = readFileSync(join(mobileDir, "src", "lib", "app-fonts.ts"), "utf8");
    const files = [...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1] ?? "");
    expect(files).toHaveLength(8);
    for (const file of files) {
      expect(existsSync(join(mobileDir, "src", "lib", file)), file).toBe(true);
    }
  });

  it("are not imported from @expo-google-fonts, whose index bundles every weight", () => {
    const layout = readFileSync(join(mobileDir, "app", "_layout.tsx"), "utf8");
    expect(layout).not.toContain("@expo-google-fonts");
    expect(layout).toContain("useFonts(APP_FONTS)");
  });
});

describe("favicon.ico (D7)", () => {
  it("ships in public/, which the web export copies to its root", () => {
    const icon = readFileSync(join(mobileDir, "public", "favicon.ico"), "latin1");
    const u16 = (offset: number) => icon.charCodeAt(offset) | (icon.charCodeAt(offset + 1) << 8);
    // ICONDIR: reserved 0, type 1 (icon), at least one image.
    expect(u16(0)).toBe(0);
    expect(u16(2)).toBe(1);
    expect(u16(4)).toBeGreaterThan(0);
  });
});
