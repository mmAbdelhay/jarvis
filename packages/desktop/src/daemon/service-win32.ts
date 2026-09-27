type Command = readonly [command: string, args: readonly string[]];

export interface WindowsServiceDefinition {
  filePath: string;
  contents: string;
  commands: {
    install: Command;
    start: Command;
    stop: Command;
    uninstall: Command;
    status: Command;
  };
}

function cmdQuote(value: string): string {
  return `"${value.replaceAll("%", "%%")}"`;
}

export function buildWindowsService(options: {
  localAppData: string;
  execPath: string;
  daemonScript: string;
}): WindowsServiceDefinition {
  const filePath = `${options.localAppData}\\Jarvis\\jarvisd.cmd`;
  const contents = `@echo off\r
set "ELECTRON_RUN_AS_NODE=1"\r
${cmdQuote(options.execPath)} ${cmdQuote(options.daemonScript)} run\r
`;
  return {
    filePath,
    contents,
    commands: {
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
          `"${filePath}"`,
        ],
      ],
      start: ["schtasks", ["/Run", "/TN", "JarvisDaemon"]],
      stop: ["schtasks", ["/End", "/TN", "JarvisDaemon"]],
      uninstall: ["schtasks", ["/Delete", "/F", "/TN", "JarvisDaemon"]],
      status: ["schtasks", ["/Query", "/TN", "JarvisDaemon"]],
    },
  };
}
