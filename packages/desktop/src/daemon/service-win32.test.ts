import { describe, expect, it } from "vitest";
import { buildWindowsService } from "./service-win32.js";

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
});
