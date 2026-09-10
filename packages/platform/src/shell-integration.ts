// Which shell integration to install, if any.
//
// The two installers are per-shell because the mechanism is: zsh is
// redirected with ZDOTDIR and bash with --rcfile, and the hook syntax has
// nothing in common. This is the one place that has to know both exist, so
// main.ts asks a single question and gets a single answer.

import { installBashIntegration, isBash } from "./bash-integration.js";
import { installZshIntegration, isZsh } from "./zsh-integration.js";

/** What was installed, in the shape the spawner needs to act on it: a
 *  directory to hand zsh as ZDOTDIR, or a file to hand bash as --rcfile.
 *  Undefined means no integration at all — see the installers. */
export type InstalledIntegration = { zdotdir: string } | { rcfile: string } | undefined;

export type ShellIntegrationDeps = {
  /** The user's login shell — `$SHELL`. */
  shell: string | undefined;
  /** `terminal.completion.enabled`. False installs nothing at all: one
   *  switch, no half-state. */
  enabled: boolean;
  /** Where the zsh wrapper directory is written. */
  zdotdirDir: string;
  /** Where the bash wrapper file is written. */
  bashDir: string;
  /** The user's real ZDOTDIR: `$ZDOTDIR` if they set one, else `$HOME`. */
  realZdotdir: string;
  /** The user's home directory, whose profile files the bash wrapper chains
   *  to. */
  home: string;
  write: (path: string, contents: string) => Promise<void>;
};

/**
 * Installs the wrapper for whichever shell the user has, and returns what to
 * do with it.
 *
 * A shell neither installer knows gets nothing, silently — a terminal exactly
 * as it is without this feature, which is a far better outcome than a wrapper
 * guessing at a shell's syntax. fish and nu emit the same OSC 133 marks with
 * entirely different hook syntax; adding either means adding its own module
 * beside these two, not widening a guess here.
 */
export async function installShellIntegration(
  deps: ShellIntegrationDeps,
): Promise<InstalledIntegration> {
  if (isZsh(deps.shell)) {
    const zdotdir = await installZshIntegration({
      shell: deps.shell,
      enabled: deps.enabled,
      dir: deps.zdotdirDir,
      realZdotdir: deps.realZdotdir,
      write: deps.write,
    });
    return zdotdir === undefined ? undefined : { zdotdir };
  }

  if (isBash(deps.shell)) {
    const rcfile = await installBashIntegration({
      shell: deps.shell,
      enabled: deps.enabled,
      dir: deps.bashDir,
      home: deps.home,
      write: deps.write,
    });
    return rcfile === undefined ? undefined : { rcfile };
  }

  return undefined;
}
