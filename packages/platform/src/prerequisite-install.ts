import type { InstallStep } from "./prerequisites.js";

// Running one install step.
//
// Every side effect is a parameter — spawning, downloading, extracting,
// linking — so the whole of the decision-making is testable without touching
// a network or a filesystem, and so the two front ends (the first-run screen
// and `pnpm setup`) share one implementation of what "install this" means.

export type InstallOutcome = { ok: boolean; detail?: string };

export type InstallDeps = {
  /** Runs a command, streaming its output through `onOutput`, and resolves
   *  with its exit code. */
  run: (
    command: string,
    args: readonly string[],
    onOutput: (chunk: string) => void,
  ) => Promise<number>;
  /** Fetches `url` to `dest`, creating parent directories. */
  download: (url: string, dest: string) => Promise<void>;
  /** Unpacks the archive at `url` into `dest` and resolves with the directory
   *  the contents landed in. */
  extract: (url: string, dest: string) => Promise<string>;
  /** Symlinks `from` to `to`, replacing an existing link. */
  link: (from: string, to: string) => Promise<void>;
  /** Where a command resolves to, for the npm link. Undefined when it is not
   *  on the PATH afterwards, which is itself the interesting outcome. */
  locate: (command: string) => Promise<string | undefined>;
  home: string;
  onOutput: (chunk: string) => void;
};

function expand(path: string, home: string): string {
  return path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}

/**
 * Installs one prerequisite, and never throws.
 *
 * A failing step is an outcome the screen renders beside its row, not an
 * exception that abandons the other rows the user ticked. The detail it
 * carries is the whole of the diagnosis — "npm ERR! EACCES" and nothing else
 * — which is why the output is streamed as it arrives rather than summarised
 * at the end.
 */
export async function runInstall(step: InstallStep, deps: InstallDeps): Promise<InstallOutcome> {
  try {
    if (step.kind === "manual") {
      // The runtime half of the guarantee the types already make
      // structurally. Reaching here means a caller ignored `installable`, and
      // running a root command because of a caller's bug is precisely what
      // this design refuses.
      return { ok: false, detail: "this one is installed by hand, not by Jarvis" };
    }

    if (step.kind === "download") {
      for (const file of step.files) {
        deps.onOutput(`downloading ${file.url}\n`);
        await deps.download(file.url, expand(file.dest, deps.home));
      }
      return { ok: true };
    }

    if (step.kind === "extract") {
      const dest = expand(step.dest, deps.home);
      deps.onOutput(`downloading ${step.url}\n`);
      const into = await deps.extract(step.url, dest);
      const binary = `${into}/${step.binary}`;
      await deps.link(binary, `${expand(step.linkInto, deps.home)}/${step.binary}`);
      return { ok: true };
    }

    const code = await deps.run(step.command, step.args, deps.onOutput);
    if (code !== 0) {
      return { ok: false, detail: `${step.command} exited with code ${code}` };
    }

    // npm under nvm installs into a bin a non-interactive login shell cannot
    // see — the exact reason the Database tab failed with dbgate-serve
    // installed and on PATH in every terminal. One symlink into a directory
    // the login PATH already carries makes it visible to every shell.
    //
    // Best-effort: a tool that installed fine and could not be linked is
    // still installed, and saying otherwise would be a lie about the thing
    // that matters.
    if (step.linkInto !== undefined && step.linkBinary !== undefined) {
      const found = await deps.locate(step.linkBinary);
      const target = `${expand(step.linkInto, deps.home)}/${step.linkBinary}`;
      if (found !== undefined && found !== target) {
        await deps.link(found, target).catch(() => undefined);
      }
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
