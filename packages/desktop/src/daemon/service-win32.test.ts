import { describe, expect, it } from "vitest";
import { buildWindowsService, windowsRecordedExecPath } from "./service-win32.js";

describe("buildWindowsService", () => {
  it("builds exact registry argv with the quoted executable value", () => {
    const service = buildWindowsService({
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
});
