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

/**
 * Where the user's shell keeps its history, by default.
 *
 * Read and never written. zsh's HISTFILE is the file this feature's frequency
 * analysis was built from; bash's is where the same information lives on a
 * machine that runs bash — and reading one with the other's parser does not
 * fail, it silently drops every timestamp and with it the recency half of the
 * ranking.
 *
 * A shell neither installer knows gets zsh's path. Nothing else is known
 * about them, and a file that does not exist reads as an empty history, which
 * is what it already did.
 */
export function defaultHistoryPath(shell: string | undefined, home: string): string {
  return isBash(shell) ? `${home}/.bash_history` : `${home}/.zsh_history`;
}
