import {
  installFor,
  manualLine,
  packageManager,
  PREREQUISITES,
  type Detection,
  type PrerequisiteId,
} from "./prerequisites.js";

// Which prerequisites this machine already has.
//
// The one thing worth understanding here is which PATH the answer is measured
// against: the *login shell's*, handed in by the caller, and never this
// process's.
//
// That is not fussiness. A tool installed under nvm, rbenv or pyenv sits on an
// interactive shell's PATH and not on a GUI process's, and Jarvis resolves its
// sidecars against the former. Detection that used process.env would report
// dbgate-serve present, the screen would show a tick beside it, and the
// Database tab would then fail to find it — which is the exact bug this
// feature exists to stop a user from hitting, re-created inside the tool meant
// to prevent it.
//
// So every input is a parameter: the platform, the architecture, the
// environment, and the file check itself. Nothing here reads the world.

export type PrerequisiteStatus = {
  id: PrerequisiteId;
  installed: boolean;
  /** True when Jarvis can install it on this platform without root. */
  installable: boolean;
  /** The line to show and let the user copy, when Jarvis will not do it. */
  manual?: string;
};

export type CheckDeps = {
  platform: NodeJS.Platform;
  arch: string;
  /** The login shell's environment — see loginShellPath. */
  env: NodeJS.ProcessEnv;
  /** Injected so every case above is deterministic on any machine. */
  fileExists: (path: string) => boolean;
  home: string;
};

/** `~` against the home directory the caller gave, so the catalogue can write
 *  paths the way the config file does. */
function expand(path: string, home: string): string {
  return path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}

/** Whether `command` is on this PATH. The same walk onPath does, with the
 *  existence check injected. */
function onGivenPath(command: string, deps: CheckDeps): boolean {
  const parts = (deps.env["PATH"] ?? "").split(deps.platform === "win32" ? ";" : ":");
  const suffixes = deps.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of parts) {
    if (dir === "") continue;
    for (const suffix of suffixes) {
      if (deps.fileExists(`${dir}/${command}${suffix}`)) return true;
    }
  }
  return false;
}

function detected(detect: Detection, deps: CheckDeps): boolean {
  if (detect.kind === "binary") return onGivenPath(detect.command, deps);
  if (detect.kind === "anyBinary") {
    return detect.commands.some((command) => onGivenPath(command, deps));
  }
  return deps.fileExists(expand(detect.path, deps.home));
}

/**
 * Every prerequisite, with what this machine has and what it would take to
 * get the rest.
 *
 * Order follows the catalogue, which is ordered by how much its absence costs
 * — the required agent first, then voice, then the workspace tabs.
 */
export function checkPrerequisites(deps: CheckDeps): PrerequisiteStatus[] {
  const manager = packageManager(deps.platform, (command) => onGivenPath(command, deps));

  return PREREQUISITES.map((prerequisite) => {
    const installed = detected(prerequisite.detect, deps);
    const step = installFor(prerequisite.id, deps.platform, deps.arch);

    if (installed || step === undefined) {
      return { id: prerequisite.id, installed, installable: false };
    }

    if (step.kind === "manual") {
      return {
        id: prerequisite.id,
        installed: false,
        installable: false,
        manual: manualLine(step.display, manager),
      };
    }

    return { id: prerequisite.id, installed: false, installable: true };
  });
}

/** The required prerequisites this machine is missing. The first-run screen
 *  opens itself for these even when it is not a first run. */
export function missingRequired(statuses: readonly PrerequisiteStatus[]): PrerequisiteId[] {
  const required = new Set(PREREQUISITES.filter((p) => p.required).map((p) => p.id));
  return statuses.filter((s) => required.has(s.id) && !s.installed).map((s) => s.id);
}
