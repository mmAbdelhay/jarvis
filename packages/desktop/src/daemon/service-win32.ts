type Command = readonly [command: string, args: readonly string[]];

export interface WindowsServiceDefinition {
  commands: {
    install: Command;
    uninstall: Command;
    status: Command;
  };
}

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/** The binary the Run value starts, read from `reg query`'s output (the
 *  quoted path before --jarvis-daemon); undefined when there is none. */
export function windowsRecordedExecPath(regQueryOutput: string): string | undefined {
  const match = /JarvisDaemon\s+REG_SZ\s+"([^"]*)"/.exec(regQueryOutput);
  return match?.[1];
}

export function buildWindowsService(options: { execPath: string }): WindowsServiceDefinition {
  return {
    commands: {
      install: [
        "reg",
        [
          "add",
          RUN_KEY,
          "/v",
          "JarvisDaemon",
          "/t",
          "REG_SZ",
          "/d",
          `"${options.execPath}" --jarvis-daemon`,
          "/f",
        ],
      ],
      uninstall: ["reg", ["delete", RUN_KEY, "/v", "JarvisDaemon", "/f"]],
      status: ["reg", ["query", RUN_KEY, "/v", "JarvisDaemon"]],
    },
  };
}
