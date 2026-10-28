import { describe, expect, it } from "vitest";
import { buildWindowsService, windowsRecordedExecPath } from "./service-win32.js";

describe("buildWindowsService", () => {
  it("builds exact registry argv with the quoted executable value", () => {
    const service = buildWindowsService({
      home: "C:\\Users\\u",
      accountHome: "C:\\Users\\u",
      execPath: "C:\\Program Files\\Jarvis\\Jarvis.exe",
    });

    expect(service.commands).toEqual({
      install: [
        "reg",
        [
          "add",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
          "/v",
          "JarvisDaemon",
          "/t",
          "REG_SZ",
          "/d",
          '"C:\\Program Files\\Jarvis\\Jarvis.exe" --jarvis-daemon',
          "/f",
        ],
      ],
      uninstall: [
        "reg",
        [
          "delete",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
          "/v",
          "JarvisDaemon",
          "/f",
        ],
      ],
      status: [
        "reg",
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "JarvisDaemon"],
      ],
    });
  });

  it("reads back the binary the Run value records from reg query's output", () => {
    const stdout = [
      "",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      '    JarvisDaemon    REG_SZ    "C:\\Users\\Zoë\\Jarvis App\\Jarvis.exe" --jarvis-daemon',
      "",
    ].join("\r\n");
    expect(windowsRecordedExecPath(stdout)).toBe("C:\\Users\\Zoë\\Jarvis App\\Jarvis.exe");
    expect(windowsRecordedExecPath("ERROR: The system was unable to find")).toBeUndefined();
  });

  it("gives an instance whose home is not the account's its own Run value", () => {
    const build = (home: string) =>
      buildWindowsService({ home, accountHome: "C:\\Users\\u", execPath: "C:\\J\\Jarvis.exe" });
    const service = build("C:\\Users\\u\\test-home");
    expect(service.valueName).toBe("JarvisDaemon-b9b34085");
    for (const [, args] of Object.values(service.commands)) {
      expect(args[args.indexOf("/v") + 1]).toBe("JarvisDaemon-b9b34085");
    }
    expect(build("C:\\Users\\u").valueName).toBe("JarvisDaemon");
    expect(build("C:\\Users\\u\\").valueName).toBe("JarvisDaemon");
    expect(build("C:\\Users\\v").valueName).not.toBe(service.valueName);
    const stdout = '    JarvisDaemon-b9b34085    REG_SZ    "C:\\J\\Jarvis.exe" --jarvis-daemon';
    expect(windowsRecordedExecPath(stdout, "JarvisDaemon-b9b34085")).toBe("C:\\J\\Jarvis.exe");
    expect(windowsRecordedExecPath(stdout, "JarvisDaemon")).toBeUndefined();
  });
});
