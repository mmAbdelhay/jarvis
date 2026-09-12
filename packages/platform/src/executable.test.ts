import { describe, expect, it } from "vitest";
import {
  isBatchFile,
  pathExtensions,
  ptySpawnTarget,
  quoteWindowsArgument,
  resolveWindowsExecutable,
  spawnTarget,
} from "./executable.js";

/** A made-up Windows filesystem: the paths that exist, nothing else. */
function fs(...paths: string[]): (path: string) => boolean {
  const known = new Set(paths.map((path) => path.toLowerCase()));
  return (path) => known.has(path.toLowerCase());
}

const env = {
  PATH: "C:\\Windows\\System32;C:\\Users\\me\\AppData\\Roaming\\npm;C:\\tools",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
};

describe("pathExtensions", () => {
  it("reads PATHEXT in order, with Windows' own default when unset", () => {
    expect(pathExtensions({ PATHEXT: ".EXE;.CMD" })).toEqual([".EXE", ".CMD"]);
    expect(pathExtensions({})).toEqual([".COM", ".EXE", ".BAT", ".CMD"]);
  });
});

describe("resolveWindowsExecutable", () => {
  it("finds a bare name on PATH with a PATHEXT extension, in PATHEXT order", () => {
    const exists = fs("C:\\tools\\claude.cmd", "C:\\tools\\claude.exe");
    expect(resolveWindowsExecutable("claude", env, exists, "C:\\cwd")).toBe("C:\\tools\\claude.exe");
  });

  it("finds an npm shim", () => {
    const exists = fs("C:\\Users\\me\\AppData\\Roaming\\npm\\dbgate-serve.cmd");
    expect(resolveWindowsExecutable("dbgate-serve", env, exists, "C:\\cwd")).toBe(
      "C:\\Users\\me\\AppData\\Roaming\\npm\\dbgate-serve.cmd",
    );
  });

  it("tries a name that already has an extension as given first", () => {
    const exists = fs("C:\\tools\\claude.exe");
    expect(resolveWindowsExecutable("claude.exe", env, exists, "C:\\cwd")).toBe("C:\\tools\\claude.exe");
  });

  it("checks a path with a directory only as given, plus the extensions", () => {
    const exists = fs("C:\\Users\\me\\.local\\bin\\claude.exe");
    expect(resolveWindowsExecutable("C:\\Users\\me\\.local\\bin\\claude", env, exists)).toBe(
      "C:\\Users\\me\\.local\\bin\\claude.exe",
    );
    expect(resolveWindowsExecutable("C:\\elsewhere\\claude", env, exists)).toBeUndefined();
  });

  it("looks in the current directory before PATH, as cmd.exe does", () => {
    const exists = fs("C:\\cwd\\tool.exe", "C:\\tools\\tool.exe");
    expect(resolveWindowsExecutable("tool", env, exists, "C:\\cwd")).toBe("C:\\cwd\\tool.exe");
  });

  it("is undefined for a name nothing answers to", () => {
    expect(resolveWindowsExecutable("nothing", env, fs(), "C:\\cwd")).toBeUndefined();
    expect(resolveWindowsExecutable("", env, fs(), "C:\\cwd")).toBeUndefined();
  });
});

describe("quoteWindowsArgument", () => {
  it("leaves a plain argument alone and quotes one with spaces", () => {
    expect(quoteWindowsArgument("--model")).toBe("--model");
    expect(quoteWindowsArgument("C:\\Program Files\\x")).toBe('"C:\\Program Files\\x"');
    expect(quoteWindowsArgument("")).toBe('""');
  });

  it("escapes embedded quotes and the backslashes that precede them, libuv's way", () => {
    expect(quoteWindowsArgument('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArgument('a\\"b')).toBe('"a\\\\\\"b"');
    expect(quoteWindowsArgument("trailing\\ slash\\")).toBe('"trailing\\ slash\\\\"');
  });
});

describe("spawnTarget", () => {
  it("passes everything through untouched off Windows", () => {
    expect(spawnTarget("dbgate-serve", ["--x"], env, "darwin", fs())).toEqual({
      file: "dbgate-serve",
      args: ["--x"],
    });
  });

  it("spawns a resolved .exe from its full path", () => {
    const exists = fs("C:\\tools\\claude.exe");
    expect(spawnTarget("claude", ["--version"], env, "win32", exists)).toEqual({
      file: "C:\\tools\\claude.exe",
      args: ["--version"],
    });
  });

  it("routes a batch shim through cmd.exe with a pre-quoted command line", () => {
    const exists = fs("C:\\tools\\dbgate-serve.cmd");
    expect(spawnTarget("dbgate-serve", ["--dir", "C:\\My Dir"], env, "win32", exists)).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", '"C:\\tools\\dbgate-serve.cmd --dir "C:\\My Dir""'],
      windowsVerbatimArguments: true,
    });
  });

  it("leaves an unresolved name for Node to report as ENOENT", () => {
    expect(spawnTarget("missing", ["-v"], env, "win32", fs())).toEqual({ file: "missing", args: ["-v"] });
  });
});

describe("ptySpawnTarget", () => {
  it("resolves the path and nothing else — node-pty quotes for itself", () => {
    const exists = fs("C:\\tools\\claude.cmd");
    expect(ptySpawnTarget("claude", ["--session-id", "x"], env, "win32", exists)).toEqual({
      file: "C:\\tools\\claude.cmd",
      args: ["--session-id", "x"],
    });
    expect(ptySpawnTarget("claude", [], env, "darwin", exists)).toEqual({ file: "claude", args: [] });
  });
});

describe("isBatchFile", () => {
  it("is .cmd or .bat, in any case", () => {
    expect(isBatchFile("x.cmd")).toBe(true);
    expect(isBatchFile("x.BAT")).toBe(true);
    expect(isBatchFile("x.exe")).toBe(false);
  });
});
