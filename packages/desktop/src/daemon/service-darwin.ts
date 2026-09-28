export const DARWIN_SERVICE_LABEL = "dev.jarvis.daemon";

type Command = readonly [command: string, args: readonly string[]];

export interface DarwinServiceDefinition {
  filePath: string;
  fileMode: number;
  logDirectory: string;
  contents: string;
  commands: {
    install: Command;
    uninstall: Command;
    start: Command;
    stop: Command;
    status: Command;
  };
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unxml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name] ?? "");
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** The binary an installed plist runs (ProgramArguments' first string), as
 *  buildDarwinService wrote it; undefined when the file has none. */
export function darwinRecordedExecPath(plist: string): string | undefined {
  const match = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(plist);
  return match?.[1] === undefined ? undefined : unxml(match[1]);
}

export function buildDarwinService(options: {
  home: string;
  uid: number;
  execPath: string;
  daemonScript: string;
}): DarwinServiceDefinition {
  const filePath = `${options.home}/Library/LaunchAgents/${DARWIN_SERVICE_LABEL}.plist`;
  const logDirectory = `${options.home}/.config/jarvis/logs`;
  const target = `gui/${options.uid}/${DARWIN_SERVICE_LABEL}`;
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DARWIN_SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(options.execPath)}</string>
    <string>${xml(options.daemonScript)}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
    <key>JARVISD_SUPERVISOR</key>
    <string>launchd</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(`${logDirectory}/jarvisd.out.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(`${logDirectory}/jarvisd.err.log`)}</string>
</dict>
</plist>
`;

  return {
    filePath,
    fileMode: 0o644,
    logDirectory,
    contents,
    commands: {
      install: ["launchctl", ["bootstrap", `gui/${options.uid}`, filePath]],
      uninstall: ["launchctl", ["bootout", target]],
      start: ["launchctl", ["kickstart", "-k", target]],
      stop: ["launchctl", ["bootout", target]],
      status: ["launchctl", ["print", target]],
    },
  };
}
