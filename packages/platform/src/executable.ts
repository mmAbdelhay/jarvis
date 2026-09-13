import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

// How a command name becomes something Windows can actually start.
//
// On macOS and Linux `spawn("dbgate-serve", [])` is the whole story: the
// kernel walks PATH and execs whatever it finds. Windows has two gaps that
// each turn the same call into a silent failure:
//
//   1. CreateProcess resolves a bare name only with `.exe` appended. Every
//      tool installed through npm — dbgate-serve, code-server, an
//      npm-installed agent CLI — is a `.cmd` shim, which a bare name never
//      finds. ConPTY reports it as "File not found: " with the name missing.
//
//   2. Node refuses to spawn a `.cmd` or `.bat` at all without a shell
//      (CVE-2024-27980: cmd.exe's argument parsing is not CreateProcess's, so
//      a batch file started directly can be made to run something else).
//      `shell: true` would work, but hands every argument to cmd.exe's own
//      quoting rules, which no caller here wants to reason about.
//
// So a command is resolved here, the PATHEXT way a shell would, and a batch
// file is started through cmd.exe explicitly with the arguments quoted for
// it. Everything else — a real `.exe`, an absolute path, any other platform —
// passes through untouched, so the change is invisible where it is not
// needed.
//
// `platform` is a parameter everywhere, never `process.platform`: the whole
// matrix is then a unit test on one machine rather than something only a
// Windows laptop could prove. See platform-convention.test.ts.
//
// For the same reason the path helpers are taken from `win32` and `posix`
// explicitly rather than from the module's own default. `join` on macOS is
// posix.join, which would build `C:\tools/claude` for the Windows lookup and
// make every Windows test pass only on Windows — the one machine the rule
// above exists to avoid depending on.

/** The extensions Windows tries for a bare command name, in PATHEXT order.
 *  The default is what a fresh Windows has; a user's own additions (`.PY`,
 *  say) come through the environment. */
export function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD";
  return raw
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension !== "");
}

/** The directories a Windows PATH lookup walks: the current directory first,
 *  as cmd.exe does, then PATH. */
function searchDirectories(env: NodeJS.ProcessEnv, cwd: string): string[] {
  const path = env["PATH"] ?? env["Path"] ?? "";
  return [cwd, ...path.split(";").filter((entry) => entry !== "")];
}

/**
 * Where `command` lives on Windows, or undefined when nothing answers to it.
 *
 * A name with a directory in it is only ever checked where it points (plus
 * the PATHEXT extensions, so `~/.local/bin/claude` finds `claude.exe`); a
 * bare name is walked across PATH. A name that already carries an extension
 * is tried as-is first, so `claude.exe` is not looked for as `claude.exe.exe`
 * before being found.
 */
export function resolveWindowsExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
  cwd = ".",
): string | undefined {
  if (command === "") return undefined;
  const extensions = pathExtensions(env);
  const hasExtension = win32.extname(command) !== "";
  // Lower-cased: the filesystem does not care, and `claude.exe` is what the
  // file is actually called far more often than `claude.EXE`.
  const withExtensions = (base: string): string[] =>
    extensions.map((extension) => base + extension.toLowerCase());
  const candidates = (base: string): string[] =>
    hasExtension ? [base, ...withExtensions(base)] : withExtensions(base);

  if (win32.isAbsolute(command) || command.includes("\\") || command.includes("/")) {
    return candidates(command).find(exists);
  }
  for (const directory of searchDirectories(env, cwd)) {
    const found = candidates(win32.join(directory, command)).find(exists);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Where `command` lives on this platform — the Windows lookup above, and the
 * plain PATH walk every other platform does.
 *
 * A POSIX lookup appends no extensions and tests no execute bit: `exists` is
 * the seam, and the caller that cares (is this installed?) is answered
 * correctly by presence alone.
 */
export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (command === "") return undefined;
  if (platform === "win32") return resolveWindowsExecutable(command, env, exists);
  if (command.includes("/")) return exists(command) ? command : undefined;
  for (const directory of (env["PATH"] ?? "")
    .split(posix.delimiter)
    .filter((entry) => entry !== "")) {
    const candidate = posix.join(directory, command);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** A `.cmd` or `.bat`: something only cmd.exe can run. */
export function isBatchFile(path: string): boolean {
  const extension = win32.extname(path).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

/**
 * One argument, quoted the way CreateProcess's standard parser (and so
 * cmd.exe, and the `%*` a batch shim forwards) unquotes it. This is libuv's
 * `quote_cmd_arg`, which is what Node itself applies to every argument on
 * Windows — reproduced here because the batch route below builds the whole
 * command line by hand.
 */
export function quoteWindowsArgument(argument: string): string {
  if (argument === "") return '""';
  if (!/[ \t"]/.test(argument)) return argument;
  if (!/["\\]/.test(argument)) return `"${argument}"`;

  // Backslashes matter only when they precede a quote — including the closing
  // quote added at the end — in which case each is doubled and the quote
  // itself escaped. Walking backwards from the end is how libuv keeps that
  // rule to one flag: "the character after this one was a quote".
  const reversed: string[] = [];
  let quoteFollows = true;
  for (let index = argument.length - 1; index >= 0; index -= 1) {
    const character = argument[index] as string;
    reversed.push(character);
    if (quoteFollows && character === "\\") {
      reversed.push("\\");
    } else if (character === '"') {
      quoteFollows = true;
      reversed.push("\\");
    } else {
      quoteFollows = false;
    }
  }
  return `"${reversed.reverse().join("")}"`;
}

export type SpawnTarget = {
  file: string;
  args: string[];
  /** Set only for the batch route, where the whole command line is already
   *  quoted and Node must not quote it again. */
  windowsVerbatimArguments?: boolean;
};

/**
 * What to hand `child_process.spawn` for `command args`.
 *
 * Off Windows, exactly what came in. On Windows the command is resolved, a
 * batch file is rerouted through `cmd.exe /d /s /c "..."` (`/s` strips the
 * outer quotes and nothing else; `/d` skips AutoRun, a registry key that
 * could otherwise run arbitrary commands first) and everything else spawns
 * from its resolved path. An unresolved name passes through unchanged, so the
 * failure the caller sees is Node's own ENOENT naming the command rather than
 * an error invented here.
 */
export function spawnTarget(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): SpawnTarget {
  if (platform !== "win32") return { file: command, args: [...args] };
  const resolved = resolveWindowsExecutable(command, env, exists);
  if (resolved === undefined) return { file: command, args: [...args] };
  if (!isBatchFile(resolved)) return { file: resolved, args: [...args] };

  const commandLine = [resolved, ...args].map(quoteWindowsArgument).join(" ");
  return {
    file: commandShell(env),
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Where cmd.exe is.
 *
 * Never the bare name: the caller frequently hands a deliberately narrow
 * environment — a spawner given only the PATH it should search — and a bare
 * "cmd.exe" then resolves against that PATH and is not found. ComSpec when
 * the environment has one, the process's own as the next best, and finally
 * the absolute path every Windows install has.
 */
function commandShell(env: NodeJS.ProcessEnv): string {
  const named =
    env["ComSpec"] ?? env["COMSPEC"] ?? process.env["ComSpec"] ?? process.env["COMSPEC"];
  if (named !== undefined && named !== "") return named;
  const systemRoot = env["SystemRoot"] ?? process.env["SystemRoot"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\cmd.exe`;
}

/**
 * The same, for node-pty. ConPTY hands the command line straight to
 * CreateProcess, which runs a `.cmd` through cmd.exe of its own accord — and
 * node-pty quotes each argument itself, so the pre-quoted batch route above
 * would be quoted twice. All a pty needs is the resolved path, so that the
 * name has its extension and CreateProcess can find the file.
 */
export function ptySpawnTarget(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): SpawnTarget {
  if (platform !== "win32") return { file: command, args: [...args] };
  return { file: resolveWindowsExecutable(command, env, exists) ?? command, args: [...args] };
}
