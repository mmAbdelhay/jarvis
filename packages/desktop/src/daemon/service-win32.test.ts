import { describe, expect, it } from "vitest";
import { buildWindowsService } from "./service-win32.js";

describe("buildWindowsService", () => {
  it("builds a quoted cmd wrapper and exact schtasks argv", () => {
    const service = buildWindowsService({
      localAppData: "C:\\Users\\Jarvis User\\AppData\\Local",
      execPath: "C:\\Program Files\\Jarvis\\Jarvis.exe",
      daemonScript: "C:\\Program Files\\Jarvis\\resources\\dist\\daemon-main.js",
    });

    expect(service.filePath).toBe("C:\\Users\\Jarvis User\\AppData\\Local\\Jarvis\\jarvisd.cmd");
    expect(service.contents).toBe(`@echo off\r
set "ELECTRON_RUN_AS_NODE=1"\r
"C:\\Program Files\\Jarvis\\Jarvis.exe" "C:\\Program Files\\Jarvis\\resources\\dist\\daemon-main.js" run\r
`);
    expect(service.commands).toEqual({
      install: [
        "schtasks",
        [
          "/Create",
          "/F",
          "/SC",
          "ONLOGON",
          "/TN",
          "JarvisDaemon",
          "/RL",
          "LIMITED",
          "/TR",
          `"${service.filePath}"`,
        ],
      ],
      start: ["schtasks", ["/Run", "/TN", "JarvisDaemon"]],
      stop: ["schtasks", ["/End", "/TN", "JarvisDaemon"]],
      uninstall: ["schtasks", ["/Delete", "/F", "/TN", "JarvisDaemon"]],
      status: ["schtasks", ["/Query", "/TN", "JarvisDaemon"]],
    });
  });
});
