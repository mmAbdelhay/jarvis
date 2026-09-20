import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeSdkPackage, resolveClaudeExecutable, unpackedPath } from "./sdk-executable.js";

describe("unpackedPath", () => {
  it("maps an asar path to its unpacked twin [bite-proof: the packaged app spawned from app.asar and got ENOTDIR]", () => {
    expect(
      unpackedPath("/Applications/Jarvis.app/Contents/Resources/app.asar/node_modules/x/claude"),
    ).toBe("/Applications/Jarvis.app/Contents/Resources/app.asar.unpacked/node_modules/x/claude");
  });

  it("leaves a checkout path, an already-unpacked path and a differently named archive alone", () => {
    expect(unpackedPath("/repo/node_modules/x/claude")).toBe("/repo/node_modules/x/claude");
    expect(unpackedPath("/a/app.asar.unpacked/x/claude")).toBe("/a/app.asar.unpacked/x/claude");
    expect(unpackedPath("/a/my-app.asar/x")).toBe("/a/my-app.asar/x");
  });

  it("handles Windows separators", () => {
    expect(unpackedPath("C:\\J\\resources\\app.asar\\node_modules\\x\\claude.exe")).toBe(
      "C:\\J\\resources\\app.asar.unpacked\\node_modules\\x\\claude.exe",
    );
  });
});

describe("nativeSdkPackage", () => {
  it("names the SDK's per-platform optional dependency", () => {
    expect(nativeSdkPackage("darwin", "arm64")).toBe("@anthropic-ai/claude-agent-sdk-darwin-arm64");
    expect(nativeSdkPackage("linux", "x64")).toBe("@anthropic-ai/claude-agent-sdk-linux-x64");
  });
});

describe("resolveClaudeExecutable", () => {
  it("joins the resolved manifest's directory with the binary name, unpacked", () => {
    const manifest =
      "/App/Contents/Resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json";
    const resolve = (specifier: string): string => {
      expect(specifier).toBe("@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json");
      return manifest;
    };
    // `deps.platform: "darwin"` only picks the binary name ("claude", not
    // "claude.exe") — resolveClaudeExecutable's own `join`/`dirname` are
    // node:path's real, host-OS-bound versions regardless of that override,
    // so the expected value is built the same way rather than as a
    // POSIX-literal string (which only matches when the host itself is
    // POSIX; "uses claude.exe on win32" below covers actually running on
    // win32).
    expect(resolveClaudeExecutable({ platform: "darwin", arch: "arm64", resolve })).toBe(
      unpackedPath(join(dirname(manifest), "claude")),
    );
  });

  it("uses claude.exe on win32", () => {
    const resolve = (): string =>
      "C:\\r\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\package.json";
    expect(resolveClaudeExecutable({ platform: "win32", arch: "x64", resolve })).toMatch(
      /claude\.exe$/,
    );
  });

  it("returns undefined when the native package is missing, leaving the SDK's own resolution and error in place", () => {
    const resolve = (): string => {
      throw new Error("Cannot find module");
    };
    expect(resolveClaudeExecutable({ platform: "linux", arch: "x64", resolve })).toBeUndefined();
  });

  it("resolves the real binary in this checkout (no asar here, so the path is untouched and exists)", async () => {
    const path = resolveClaudeExecutable();
    expect(path).toMatch(/claude-agent-sdk-[a-z0-9]+-[a-z0-9]+[\\/]claude(\.exe)?$/);
    await expect(access(path as string)).resolves.toBeUndefined();
  });
});
