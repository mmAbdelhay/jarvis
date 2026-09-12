import { describe, expect, it } from "vitest";
import { bashWrapperFile, installBashIntegration, isBash } from "./bash-integration.js";

describe("isBash", () => {
  it("recognises a login shell's own argv[0] spelling", () => {
    expect(isBash("-bash")).toBe(true);
  });
  it("recognises a path", () => {
    expect(isBash("/usr/bin/bash")).toBe(true);
  });
  it("rejects zsh, which has its own integration", () => {
    expect(isBash("/bin/zsh")).toBe(false);
  });
  it("rejects a shell neither installer knows", () => {
    expect(isBash("/usr/bin/fish")).toBe(false);
  });
  it("rejects an unset shell", () => {
    expect(isBash(undefined)).toBe(false);
    expect(isBash("")).toBe(false);
  });
});

describe("bashWrapperFile", () => {
  const text = bashWrapperFile("/home/u");

  it("reads the login files in bash's own order", () => {
    // /etc/profile first, then the FIRST of the three personal ones — which
    // is what `bash -l` does, and this wrapper replaces `-l`.
    const etc = text.indexOf("/etc/profile");
    const personal = text.indexOf("/home/u/.bash_profile");
    expect(etc).toBeGreaterThan(-1);
    expect(personal).toBeGreaterThan(etc);
    expect(text).toContain("/home/u/.bash_login");
    expect(text).toContain("/home/u/.profile");
  });

  it("stops after the first personal profile it finds", () => {
    // `break`, not a second source. Reading two of them is not what bash
    // does, and doubles whatever PATH edits they share.
    expect(text).toContain("break");
  });

  it("does not source .bashrc itself", () => {
    // A login shell does not. Distributions that want it source it from the
    // profile, and doing it here as well runs their PATH edits twice.
    expect(text).not.toContain("/home/u/.bashrc");
  });

  it("never writes to the user's own dotfiles", () => {
    // Every path in here is on the right-hand side of a source. A redirection
    // onto one would be this feature's worst possible bug.
    for (const name of [".bash_profile", ".bash_login", ".profile", ".bashrc"]) {
      expect(text).not.toContain(`> '/home/u/${name}'`);
      expect(text).not.toContain(`>> '/home/u/${name}'`);
    }
  });

  it("registers through bash-preexec's own arrays when it is already there", () => {
    // Atuin, Fig/Amazon Q and iTerm2's shell integration all ship it, and it
    // owns the DEBUG trap. A raw trap of ours does not chain with it, it
    // clobbers — and its own lazy install clobbers back on the first prompt.
    expect(text).toContain('if [[ -n "${__bp_imported:-}" ]]; then');
    expect(text).toContain("preexec_functions+=(__jarvis_bp_preexec)");
    expect(text).toContain("precmd_functions+=(__jarvis_bp_precmd)");
  });

  it("reads the exit status bash-preexec saved, not a $? it has already lost", () => {
    expect(text).toContain("${__bp_last_ret_value:-$?}");
  });

  it("takes the DEBUG trap itself only when bash-preexec is absent", () => {
    const guard = text.indexOf('if [[ -n "${__bp_imported:-}" ]]; then');
    const elseBranch = text.indexOf("  else", guard);
    const trap = text.indexOf("trap '__jarvis_preexec' DEBUG");
    expect(elseBranch).toBeGreaterThan(guard);
    expect(trap).toBeGreaterThan(elseBranch);
  });

  it("emits the marks through one pair of functions both paths share", () => {
    // Two copies of the OSC writing would be two places for the mark set to
    // drift, and only one of them is exercised on any given machine.
    expect(text).toContain("__jarvis_emit_preexec()");
    expect(text).toContain("__jarvis_emit_precmd()");
  });

  it("leaves $_ set, or bash-preexec errors into the user's terminal", () => {
    // Its trap is `__bp_preexec_invoke_exec "$_"` and it dereferences that
    // with ${...:?}. A login shell always has a $_ from its last profile
    // line; a --rcfile shell can reach the prompt with none, and the user
    // sees "__bp_last_argument_prev_command: parameter null or not set"
    // before their first command, which is also then lost.
    expect(text.trimEnd().endsWith(": jarvis")).toBe(true);
  });

  it("emits every OSC 133 mark the block splitter needs", () => {
    expect(text).toContain("133;%s");
    expect(text).toContain('__jarvis_osc "D;$1"');
    expect(text).toContain("'A'");
    expect(text).toContain('__jarvis_osc "C;${1}"');
    expect(text).toContain("133;B");
  });

  it("reports the working directory with OSC 7, which the file sidebar follows", () => {
    expect(text).toContain("]7;file://");
  });

  it("wraps the prompt mark so bash does not miscount the prompt width", () => {
    // Without \[ \], bash counts the escape sequence's bytes as printable and
    // every line that reaches the right margin wraps in the wrong column.
    expect(text).toContain("\\[\\e]133;B\\a\\]");
  });

  it("appends to PS1 rather than assigning over it", () => {
    expect(text).toContain('PS1="${PS1}');
  });

  it("chains PROMPT_COMMAND rather than replacing it", () => {
    expect(text).toContain(
      'PROMPT_COMMAND="__jarvis_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}; __jarvis_arm"',
    );
  });

  it("handles a PROMPT_COMMAND that bash 5.1+ made an array", () => {
    // A string prepend against an array keeps only its first element,
    // silently dropping whatever else the user's rc had queued there.
    expect(text).toContain('PROMPT_COMMAND=(__jarvis_precmd "${PROMPT_COMMAND[@]}" __jarvis_arm)');
    expect(text).toContain("BASH_VERSINFO");
  });

  it("arms last and marks first, so nothing between them can steal the arm", () => {
    // On a machine whose profile installs bash-preexec, its PROMPT_COMMAND
    // entry runs after precmd and trips the DEBUG trap. Arming inside precmd
    // spent the arm on that, and the line the user actually typed was never
    // seen — the first command of every session, silently missing.
    for (const form of [
      'PROMPT_COMMAND="__jarvis_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}; __jarvis_arm"',
      'PROMPT_COMMAND=(__jarvis_precmd "${PROMPT_COMMAND[@]}" __jarvis_arm)',
    ]) {
      expect(form.indexOf("__jarvis_precmd")).toBeLessThan(form.indexOf("__jarvis_arm"));
      expect(text).toContain(form);
    }
  });

  it("starts disarmed, so the wrapper's own setup lines do not spend the arm", () => {
    // The remaining setup below the trap is made of simple commands, and
    // DEBUG fires on each. Starting armed logged the version check as if the
    // user had typed it.
    expect(text).toContain("  __jarvis_armed=0\n");
    // Set in exactly one place: __jarvis_arm. Any second assignment would be
    // a path that arms outside the prompt.
    expect(text.split("__jarvis_armed=1").length - 1).toBe(1);
  });

  it("preserves the exit status through the arming hook", () => {
    // __jarvis_arm runs last in PROMPT_COMMAND. A bare return would hand the
    // user's own prompt a 0 in place of their command's real status.
    expect(text).toContain("__jarvis_arm() {");
    expect(text).toContain("local __jarvis_status=$?");
    expect(text).toContain("return $__jarvis_status");
  });

  it("appends the command log line the ranking's directory affinity needs", () => {
    expect(text).toContain("JARVIS_COMMAND_LOG");
    expect(text).toContain('"$PWD"');
  });

  it("falls back when EPOCHSECONDS is unavailable", () => {
    // EPOCHSECONDS is bash 5.0+. An older bash still logs, via `date`.
    expect(text).toContain("${EPOCHSECONDS:-$(date +%s)}");
  });

  it("disarms the DEBUG trap after the first command of a line", () => {
    // DEBUG fires before every simple command, including each one inside
    // PROMPT_COMMAND. Unarmed, one typed line emits a C mark per word of
    // whatever the prompt itself runs.
    expect(text).toContain("__jarvis_armed=0");
    expect(text).toContain("__jarvis_armed=1");
    expect(text).toContain("(( __jarvis_armed )) || return");
  });

  it("ignores the commands bash's own completion runs through DEBUG", () => {
    expect(text).toContain('[[ -n "$COMP_LINE" ]] && return');
  });

  it("preserves the exit status across the prompt hook", () => {
    // precmd runs first in PROMPT_COMMAND, so a `return $?` that lost the
    // status would break every `$?` check the user's own prompt makes.
    expect(text).toContain("local __jarvis_exit=$?");
    expect(text).toContain("return $__jarvis_exit");
  });

  it("ignores the commands bash's own completion runs through DEBUG", () => {
    expect(text).toContain('[[ -n "$COMP_LINE" ]] && return');
  });

  it("guards everything behind an interactive check", () => {
    expect(text).toContain("$- == *i*");
  });

  it("says it is generated, so nobody edits it expecting the edit to survive", () => {
    expect(text).toContain("Generated by Jarvis");
  });

  it("quotes a home directory containing a space or a quote", () => {
    const awkward = bashWrapperFile("/home/a b/o'brien");
    expect(awkward).toContain("'/home/a b/o'\\''brien/.profile'");
  });
});

describe("installBashIntegration", () => {
  const base = {
    shell: "/bin/bash",
    enabled: true,
    dir: "/cfg/bashrc.d",
    home: "/home/u",
  };

  it("writes the wrapper and returns its path", async () => {
    const written: Record<string, string> = {};
    const path = await installBashIntegration({
      ...base,
      write: async (p, c) => {
        written[p] = c;
      },
    });
    expect(path).toBe("/cfg/bashrc.d/bashrc");
    expect(written["/cfg/bashrc.d/bashrc"]).toContain("133;B");
  });

  it("writes into Jarvis's own directory, never the user's", async () => {
    const written: string[] = [];
    await installBashIntegration({
      ...base,
      write: async (p) => {
        written.push(p);
      },
    });
    expect(written).toEqual(["/cfg/bashrc.d/bashrc"]);
  });

  it("installs nothing when the feature is off", async () => {
    const path = await installBashIntegration({
      ...base,
      enabled: false,
      write: async () => {
        throw new Error("must not write");
      },
    });
    expect(path).toBeUndefined();
  });

  it("installs nothing for a shell that is not bash", async () => {
    const path = await installBashIntegration({
      ...base,
      shell: "/bin/zsh",
      write: async () => {
        throw new Error("must not write");
      },
    });
    expect(path).toBeUndefined();
  });

  it("returns undefined rather than throwing when the write fails", async () => {
    // No wrapper, so no rcfile, so no marks, so no dropdown — and a terminal
    // that works exactly as it did before this feature existed.
    const path = await installBashIntegration({
      ...base,
      write: async () => {
        throw new Error("read-only filesystem");
      },
    });
    expect(path).toBeUndefined();
  });
});
