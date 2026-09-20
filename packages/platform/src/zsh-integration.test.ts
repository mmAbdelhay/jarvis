import { describe, expect, it } from "vitest";
import {
  installZshIntegration,
  isZsh,
  zshWrapperFiles,
  type ZshIntegrationDeps,
} from "./zsh-integration.js";

function installer(overrides: Partial<ZshIntegrationDeps> = {}) {
  const written = new Map<string, string>();
  const deps: ZshIntegrationDeps = {
    shell: "/bin/zsh",
    enabled: true,
    dir: "/jarvis/zdotdir",
    realZdotdir: "/home/me",
    write: async (path, contents) => {
      written.set(path, contents);
    },
    ...overrides,
  };
  return { deps, written };
}

describe("isZsh", () => {
  it("accepts the paths a zsh login shell is spelled as", () => {
    expect(isZsh("/bin/zsh")).toBe(true);
    expect(isZsh("/opt/homebrew/bin/zsh")).toBe(true);
    expect(isZsh("-zsh")).toBe(true);
  });

  // v1 is zsh only. bash and fish emit the same OSC 133 marks with
  // different hook syntax, and a wrapper written for the wrong one is how a
  // user gets a broken prompt instead of no autocomplete.
  it("rejects every other shell, and an unset SHELL", () => {
    expect(isZsh("/bin/bash")).toBe(false);
    expect(isZsh("/usr/local/bin/fish")).toBe(false);
    expect(isZsh(undefined)).toBe(false);
    expect(isZsh("")).toBe(false);
  });
});

describe("zshWrapperFiles", () => {
  const files = zshWrapperFiles("/home/me");

  // The single riskiest mechanical piece of the feature: Jarvis's terminal
  // is a login shell, so all of .zshenv, .zprofile and .zshrc are read, and
  // a wrapper that chains only some of them costs the user their PATH —
  // which is worse than having no autocomplete at all.
  it("chains .zprofile, .zshrc and .zshenv to the user's real files", () => {
    for (const name of [".zprofile", ".zshrc", ".zshenv"]) {
      expect(files[name]).toContain(`source '/home/me/${name}'`);
    }
  });

  it("also chains .zlogin, which a login shell reads last", () => {
    expect(files[".zlogin"]).toContain("source '/home/me/.zlogin'");
  });

  it("sources each real file only when it is there", () => {
    for (const name of [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) {
      expect(files[name]).toContain(`[[ -r '/home/me/${name}' ]]`);
    }
  });

  // Without the restore, zsh reads the user's .zshenv with ZDOTDIR pointing
  // at their home and then looks for .zprofile and .zshrc there too — so
  // the hook never loads and the feature is silently dead.
  it("hands the user's file the real ZDOTDIR and then restores Jarvis's own", () => {
    expect(files[".zshenv"]).toContain("ZDOTDIR='/home/me'");
    expect(files[".zshenv"]).toContain('ZDOTDIR="$JARVIS_ZDOTDIR"');
  });

  it("remembers Jarvis's own ZDOTDIR in .zshenv, the first file zsh reads", () => {
    expect(files[".zshenv"]).toContain("JARVIS_ZDOTDIR=${JARVIS_ZDOTDIR:-$ZDOTDIR}");
  });

  // A Jarvis launched from inside Jarvis's own Terminal tab inherits
  // $ZDOTDIR already pointing at the wrapper. Without this, a nested
  // instance has no way to recover the user's real dotfile directory and
  // regenerates the wrapper pointing at itself — the recursion bug.
  it("remembers the user's real ZDOTDIR too, for a Jarvis launched from inside Jarvis", () => {
    for (const name of [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) {
      expect(files[name]).toContain("export JARVIS_REAL_ZDOTDIR='/home/me'");
    }
  });

  it("emits the four OSC 133 marks the tracker keys off", () => {
    for (const mark of ["133;%s", "A", "B", "C", "D"]) {
      expect(files[".zshrc"]).toContain(mark);
    }
  });

  it("appends the prompt-end mark to the user's own prompt rather than replacing it", () => {
    expect(files[".zshrc"]).toContain('PS1="${PS1}"');
  });

  it("installs the hooks only in an interactive shell", () => {
    expect(files[".zshrc"]).toContain("[[ -o interactive ]]");
  });

  it("carries the command text on the C mark and the cwd on OSC 7", () => {
    expect(files[".zshrc"]).toContain("__jarvis_osc7");
    expect(files[".zshrc"]).toContain('"C;${1}"');
  });

  it("logs each command with its directory, for the affinity boost", () => {
    expect(files[".zshrc"]).toContain("$JARVIS_COMMAND_LOG");
    expect(files[".zshrc"]).toContain("${PWD}");
    expect(files[".zshrc"]).toContain("${EPOCHSECONDS}");
  });

  it("never writes to any of the user's own dotfiles", () => {
    for (const contents of Object.values(files)) {
      expect(contents).not.toMatch(/>>?\s*\/home\/me\/\./);
    }
  });

  // The wrapper is generated shell source, so every interpolated path is
  // single-quoted with the shell's own escaping — a home directory with a
  // space in it is ordinary on macOS, and one with a quote in it must not
  // be able to end the string.
  it("quotes a ZDOTDIR containing a space", () => {
    expect(zshWrapperFiles("/Users/me/My Home")[".zshrc"]).toContain("'/Users/me/My Home/.zshrc'");
  });

  it("escapes a ZDOTDIR containing a single quote", () => {
    const contents = zshWrapperFiles("/Users/o'brien")[".zshrc"] ?? "";
    expect(contents).toContain("'/Users/o'\\''brien/.zshrc'");
  });
});

describe("installZshIntegration", () => {
  it("writes the four wrapper files and returns the directory to use", async () => {
    const { deps, written } = installer();

    expect(await installZshIntegration(deps)).toBe("/jarvis/zdotdir");
    expect([...written.keys()].sort()).toEqual([
      "/jarvis/zdotdir/.zlogin",
      "/jarvis/zdotdir/.zprofile",
      "/jarvis/zdotdir/.zshenv",
      "/jarvis/zdotdir/.zshrc",
    ]);
  });

  // One switch, no half-state: a disabled feature must not leave a ZDOTDIR
  // redirection behind it.
  it("installs nothing when completion is disabled", async () => {
    const { deps, written } = installer({ enabled: false });

    expect(await installZshIntegration(deps)).toBeUndefined();
    expect(written.size).toBe(0);
  });

  it("installs nothing for a shell that is not zsh", async () => {
    const { deps, written } = installer({ shell: "/bin/bash" });

    expect(await installZshIntegration(deps)).toBeUndefined();
    expect(written.size).toBe(0);
  });

  it("degrades to no integration when a write fails, rather than throwing", async () => {
    const { deps } = installer({
      write: async () => {
        throw new Error("EACCES");
      },
    });

    await expect(installZshIntegration(deps)).resolves.toBeUndefined();
  });
});
