import { describe, expect, it } from "vitest";
import { createShellManager, shellEnv, type ShellProcess, type ShellSpawner } from "./shell.js";

class FakeShell implements ShellProcess {
  written: string[] = [];
  resized: [number, number][] = [];
  killed = false;
  #data: ((chunk: string) => void)[] = [];
  #exit: ((code: number) => void)[] = [];
  onData(listener: (chunk: string) => void): void {
    this.#data.push(listener);
  }
  onExit(listener: (code: number) => void): void {
    this.#exit.push(listener);
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
  }
  emit(chunk: string): void {
    for (const listener of this.#data) listener(chunk);
  }
  emitExit(code: number): void {
    for (const listener of this.#exit) listener(code);
  }
}

function manager(options: { maxBufferBytes?: number } = {}) {
  const shells: FakeShell[] = [];
  const spawnArgs: { cwd: string; cols: number; rows: number }[] = [];
  const spawn: ShellSpawner = (args) => {
    spawnArgs.push(args);
    const shell = new FakeShell();
    shells.push(shell);
    return shell;
  };
  const instance = createShellManager({ spawn, ...options });
  return { instance, shells, spawnArgs };
}

describe("createShellManager", () => {
  it("starts one shell per tab, rooted at the project path", () => {
    const { instance, spawnArgs } = manager();

    instance.start("tab-1", "/p/acme");
    instance.start("tab-2", "/p/storefront");

    expect(spawnArgs.map((args) => args.cwd)).toEqual(["/p/acme", "/p/storefront"]);
  });

  it("never starts a second shell for a tab that already has one", () => {
    const { instance, shells } = manager();

    instance.start("tab-1", "/p/acme");
    instance.start("tab-1", "/p/acme");

    expect(shells).toHaveLength(1);
  });

  // A shell prints its prompt immediately, well before the renderer has
  // built an xterm for the tab. Losing it would leave the terminal blank
  // until the first keystroke.
  it("buffers output written before anything attaches, and replays it once", () => {
    const { instance, shells } = manager();
    instance.start("tab-1", "/p/acme");
    shells[0]?.emit("$ ");

    const seen: string[] = [];
    const replayed = instance.attach("tab-1", (chunk) => seen.push(chunk));
    shells[0]?.emit("ls\r\n");

    expect(replayed).toBe("$ ");
    expect(seen).toEqual(["ls\r\n"]);
  });

  it("replays nothing to a second attach after the buffer is drained", () => {
    const { instance, shells } = manager();
    instance.start("tab-1", "/p/acme");
    shells[0]?.emit("$ ");
    instance.attach("tab-1", () => {});

    expect(instance.attach("tab-1", () => {})).toBe("");
  });

  it("caps the pre-attach buffer, keeping the most recent output", () => {
    const { instance, shells } = manager({ maxBufferBytes: 8 });
    instance.start("tab-1", "/p/acme");

    shells[0]?.emit("0123456789");
    shells[0]?.emit("abc");

    // 8-byte cap: "0123456789" is trimmed to "23456789", then "abc" is
    // appended and the head trimmed again.
    expect(instance.attach("tab-1", () => {})).toBe("56789abc");
  });

  it("routes a write to that tab's shell and no other", () => {
    const { instance, shells } = manager();
    instance.start("tab-1", "/p/a");
    instance.start("tab-2", "/p/b");

    instance.write("tab-2", "ls\r");

    expect(shells[0]?.written).toEqual([]);
    expect(shells[1]?.written).toEqual(["ls\r"]);
  });

  it("routes a resize to that tab's shell", () => {
    const { instance, shells } = manager();
    instance.start("tab-1", "/p/a");

    instance.resize("tab-1", 120, 40);

    expect(shells[0]?.resized).toEqual([[120, 40]]);
  });

  it("ignores a write, resize or kill for a tab with no shell", () => {
    const { instance } = manager();

    expect(() => {
      instance.write("nope", "x");
      instance.resize("nope", 80, 24);
      instance.kill("nope");
    }).not.toThrow();
  });

  it("kills a tab's shell and forgets it", () => {
    const { instance, shells } = manager();
    instance.start("tab-1", "/p/a");

    instance.kill("tab-1");
    instance.start("tab-1", "/p/a");

    expect(shells[0]?.killed).toBe(true);
    expect(shells).toHaveLength(2);
  });

  it("tells the attached listener when the shell exits, and forgets it", () => {
    const { instance, shells } = manager();
    instance.start("tab-1", "/p/a");
    let exitCode: number | undefined;
    instance.attach(
      "tab-1",
      () => {},
      (code) => {
        exitCode = code;
      },
    );

    shells[0]?.emitExit(0);
    instance.start("tab-1", "/p/a");

    expect(exitCode).toBe(0);
    expect(shells).toHaveLength(2);
  });

  it("kills every shell on stopAll", () => {
    const { instance, shells } = manager();
    instance.start("tab-1", "/p/a");
    instance.start("tab-2", "/p/b");

    instance.stopAll();

    expect(shells.map((shell) => shell.killed)).toEqual([true, true]);
  });
});

describe("shellEnv", () => {
  it("points ZDOTDIR at the wrapper and names the command log", () => {
    const env = shellEnv(
      { HOME: "/home/me" },
      { zdotdir: "/jarvis/zdotdir", commandLog: "/jarvis/commands.log" },
    );

    expect(env["ZDOTDIR"]).toBe("/jarvis/zdotdir");
    expect(env["JARVIS_COMMAND_LOG"]).toBe("/jarvis/commands.log");
  });

  // Fig, Amazon Q and Kiro CLI all ship the same zsh integration: it
  // re-execs the shell under their own pty wrapper (figterm) unless Q_TERM
  // says something already did. Jarvis is that something — node-pty below,
  // xterm.js above — and saying so is what stops the double wrap. Left
  // unsaid, Kiro's wrapper launched inside a Finder-launched Jarvis and
  // panicked ("index out of bounds" in its alacritty grid), taking the
  // shell integration down with it: no OSC 133, so no blocks, no file
  // sidebar and no chips, in the installed build only.
  it("tells a Fig-family wrapper it is already inside a pty", () => {
    expect(shellEnv({ HOME: "/home/me" }, {})["Q_TERM"]).toBe("1");
  });

  // Whatever the user's own shell had is not the point: this is about the
  // shell Jarvis is spawning, and it is always inside Jarvis's pty.
  it("says so even when the launching environment did not", () => {
    expect(shellEnv({ HOME: "/home/me", Q_TERM: "" }, {})["Q_TERM"]).toBe("1");
  });

  // No integration must mean no trace of it: a ZDOTDIR left pointing
  // anywhere would change which startup files the user's shell reads.
  it("leaves ZDOTDIR alone when there is no wrapper", () => {
    const env = shellEnv({ HOME: "/home/me" }, {});

    expect(env["ZDOTDIR"]).toBeUndefined();
    expect(env["JARVIS_COMMAND_LOG"]).toBeUndefined();
  });

  it("does not inherit a ZDOTDIR the user had set when there is no wrapper", () => {
    const env = shellEnv({ HOME: "/home/me", ZDOTDIR: "/home/me/.config/zsh" }, {});

    expect(env["ZDOTDIR"]).toBe("/home/me/.config/zsh");
  });

  it("keeps the terminal markers a modern prompt checks for", () => {
    const env = shellEnv({ HOME: "/home/me" }, {});

    expect(env["TERM"]).toBe("xterm-256color");
    expect(env["COLORTERM"]).toBe("truecolor");
  });
});
