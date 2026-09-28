import { describe, expect, it } from "vitest";
import type { ControlFs } from "./deps.js";
import { controlPaths, endpointFor, runDirectoryFor, windowsPipeName } from "./endpoint.js";

function readOnlyFs(files: Record<string, string>): Pick<ControlFs, "readFile"> {
  return {
    async readFile(path) {
      const content = files[path];
      if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return content;
    },
  };
}

describe("runDirectoryFor", () => {
  it("is ~/.config/jarvis/run, with the platform's own separator", () => {
    expect(runDirectoryFor({ platform: "darwin", home: "/Users/me" })).toBe(
      "/Users/me/.config/jarvis/run",
    );
    expect(runDirectoryFor({ platform: "win32", home: "C:\\Users\\Me" })).toBe(
      "C:\\Users\\Me\\.config\\jarvis\\run",
    );
  });
});

describe("controlPaths", () => {
  it("keeps the socket, secret, pipe name and pid lock in the run dir", () => {
    expect(controlPaths("linux", "/home/me/.config/jarvis/run")).toEqual({
      runDirectory: "/home/me/.config/jarvis/run",
      socketPath: "/home/me/.config/jarvis/run/jarvisd.sock",
      secretPath: "/home/me/.config/jarvis/run/control.secret",
      endpointPath: "/home/me/.config/jarvis/run/control.endpoint",
      pidPath: "/home/me/.config/jarvis/run/jarvisd.pid",
    });
    expect(controlPaths("win32", "C:\\Users\\Me\\.config\\jarvis\\run").secretPath).toBe(
      "C:\\Users\\Me\\.config\\jarvis\\run\\control.secret",
    );
  });
});

describe("windowsPipeName", () => {
  it("is jarvisd- plus 16 random hex, not derived from the user", () => {
    expect(windowsPipeName(Buffer.from("0123456789abcdef", "hex"))).toBe(
      "\\\\.\\pipe\\jarvisd-0123456789abcdef",
    );
  });
});

describe("endpointFor", () => {
  it("is the fixed socket on Unix", async () => {
    await expect(
      endpointFor({ platform: "darwin", runDirectory: "/r", fs: readOnlyFs({}) }),
    ).resolves.toBe("/r/jarvisd.sock");
  });

  it("reads the daemon's published pipe name on Windows", async () => {
    const fs = readOnlyFs({
      "C:\\r\\control.endpoint": "\\\\.\\pipe\\jarvisd-00112233aabbccdd\n",
    });
    await expect(endpointFor({ platform: "win32", runDirectory: "C:\\r", fs })).resolves.toBe(
      "\\\\.\\pipe\\jarvisd-00112233aabbccdd",
    );
  });

  it("refuses a published name that is not a jarvisd pipe", async () => {
    const fs = readOnlyFs({ "C:\\r\\control.endpoint": "\\\\.\\pipe\\someone-else" });
    await expect(endpointFor({ platform: "win32", runDirectory: "C:\\r", fs })).rejects.toThrow(
      /pipe name/,
    );
  });
});
