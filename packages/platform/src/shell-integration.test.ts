import { describe, expect, it } from "vitest";
import { defaultHistoryPath, installShellIntegration } from "./shell-integration.js";

const base = {
  enabled: true,
  zdotdirDir: "/cfg/zdotdir",
  bashDir: "/cfg/bash",
  powerShellDir: "/cfg/powershell",
  realZdotdir: "/home/u",
  home: "/home/u",
};

const refuse = async (): Promise<void> => {
  throw new Error("must not write");
};

describe("installShellIntegration", () => {
  it("installs the zsh wrapper for zsh, and reports it as a ZDOTDIR", async () => {
    const written: string[] = [];
    const result = await installShellIntegration({
      ...base,
      shell: "/bin/zsh",
      write: async (p) => {
        written.push(p);
      },
    });
    expect(result).toEqual({ zdotdir: "/cfg/zdotdir" });
    expect(written).toContain("/cfg/zdotdir/.zshrc");
  });

  it("installs the PowerShell script for PowerShell, and reports it as one", async () => {
    const written: string[] = [];
    const result = await installShellIntegration({
      ...base,
      shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      write: async (p) => {
        written.push(p);
      },
    });
    expect(result).toEqual({ powerShellScript: "/cfg/powershell\\jarvis-integration.ps1" });
    expect(written).toEqual(["/cfg/powershell\\jarvis-integration.ps1"]);
  });

  // pwsh is PowerShell 7, and the same integration serves it.
  it("recognises pwsh as well", async () => {
    const result = await installShellIntegration({
      ...base,
      shell: "/usr/local/bin/pwsh",
      write: async () => {},
    });
    expect(result).toEqual({ powerShellScript: "/cfg/powershell\\jarvis-integration.ps1" });
  });

  it("installs the bash wrapper for bash, and reports it as an rcfile", async () => {
    const written: string[] = [];
    const result = await installShellIntegration({
      ...base,
      shell: "/usr/bin/bash",
      write: async (p) => {
        written.push(p);
      },
    });
    expect(result).toEqual({ rcfile: "/cfg/bash/bashrc" });
    expect(written).toEqual(["/cfg/bash/bashrc"]);
  });

  it("recognises the argv[0] spelling a login shell uses", async () => {
    const zsh = await installShellIntegration({ ...base, shell: "-zsh", write: async () => {} });
    const bash = await installShellIntegration({ ...base, shell: "-bash", write: async () => {} });
    expect(zsh).toEqual({ zdotdir: "/cfg/zdotdir" });
    expect(bash).toEqual({ rcfile: "/cfg/bash/bashrc" });
  });

  it("installs nothing for a shell it does not know", async () => {
    // fish, nu, dash. A plain working terminal, exactly as a non-zsh macOS
    // user gets today — never a wrapper guessing at a shell's syntax.
    for (const shell of ["/usr/bin/fish", "/usr/bin/nu", "/bin/dash"]) {
      expect(await installShellIntegration({ ...base, shell, write: refuse })).toBeUndefined();
    }
  });

  it("installs nothing when $SHELL is unset", async () => {
    expect(
      await installShellIntegration({ ...base, shell: undefined, write: refuse }),
    ).toBeUndefined();
  });

  it("installs nothing when the feature is off, whatever the shell", async () => {
    for (const shell of ["/bin/zsh", "/bin/bash"]) {
      expect(
        await installShellIntegration({ ...base, shell, enabled: false, write: refuse }),
      ).toBeUndefined();
    }
  });

  it("reports no integration when the write fails, for either shell", async () => {
    const failing = async (): Promise<void> => {
      throw new Error("read-only filesystem");
    };
    for (const shell of ["/bin/zsh", "/bin/bash"]) {
      expect(
        await installShellIntegration({ ...base, shell, write: failing }),
      ).toBeUndefined();
    }
  });

  it("keeps each shell's wrapper in its own directory", async () => {
    // One directory for both would mean a user who changes shell keeps a
    // stale wrapper for the other, in a place the new one might read.
    const written: string[] = [];
    await installShellIntegration({
      ...base,
      shell: "/bin/bash",
      write: async (p) => {
        written.push(p);
      },
    });
    expect(written.every((path) => path.startsWith("/cfg/bash/"))).toBe(true);
  });
});

describe("defaultHistoryPath", () => {
  it("reads zsh's HISTFILE for a zsh user", () => {
    expect(defaultHistoryPath("/bin/zsh", "/home/u")).toBe("/home/u/.zsh_history");
  });

  it("reads bash's for a bash user", () => {
    // Not cosmetic: zsh's parser reads a bash history without failing, and
    // silently drops every timestamp — the recency half of the ranking.
    expect(defaultHistoryPath("/bin/bash", "/home/u")).toBe("/home/u/.bash_history");
  });

  it("falls back to zsh's for a shell with no integration", () => {
    expect(defaultHistoryPath("/usr/bin/fish", "/home/u")).toBe("/home/u/.zsh_history");
    expect(defaultHistoryPath(undefined, "/home/u")).toBe("/home/u/.zsh_history");
  });
});
