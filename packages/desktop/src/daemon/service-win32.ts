import { serviceInstanceId } from "./service-name.js";

type Command = readonly [command: string, args: readonly string[]];

export interface WindowsServiceDefinition {
  /** The Run value's name: JarvisDaemon, suffixed for another home. */
  valueName: string;
  commands: {
    install: Command;
    uninstall: Command;
    status: Command;
  };
}

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/** The binary the Run value `valueName` starts, read from `reg query`'s
 *  output (the quoted path before --jarvis-daemon); undefined when there is none. */
export function windowsRecordedExecPath(
  regQueryOutput: string,
  valueName = "JarvisDaemon",
): string | undefined {
  const match = new RegExp(`(?:^|\\s)${valueName}\\s+REG_SZ\\s+"([^"]*)"`).exec(regQueryOutput);
  return match?.[1];
}

export function buildWindowsService(options: {
  home: string;
  /** The OS account's home (os.userInfo().homedir): any other home is a
   *  separate instance with its own Run value. */
  accountHome: string;
  execPath: string;
}): WindowsServiceDefinition {
  const instance = serviceInstanceId(options.home, options.accountHome);
  const valueName = instance === undefined ? "JarvisDaemon" : `JarvisDaemon-${instance}`;
  return {
    valueName,
    commands: {
      install: [
        "reg",
        [
          "add",
          RUN_KEY,
          "/v",
          valueName,
          "/t",
          "REG_SZ",
          "/d",
          `"${options.execPath}" --jarvis-daemon`,
          "/f",
        ],
      ],
      uninstall: ["reg", ["delete", RUN_KEY, "/v", valueName, "/f"]],
      status: ["reg", ["query", RUN_KEY, "/v", valueName]],
    },
  };
}
