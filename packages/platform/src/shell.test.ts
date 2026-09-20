import { describe, expect, it } from "vitest";
import {
  createShellManager,
  EXITED_LOG_CHARS,
  shellArgs,
  shellCommand,
  shellEnv,
  type ShellProcess,
  type ShellSpawner,
} from "./shell.js";

/**
 * A small deterministic PRNG (mulberry32) so the retention property test
 * below is reproducible without pulling in a new dependency.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

function manager(options: { maxLogChars?: number } = {}) {
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
  // until the first keystroke — so the log is read, never drained.
  it("retains output written before anyone subscribes, and log() does not drain it", () => {
    const { instance, shells } = manager();
    instance.start("tab-1", "/p/acme");
    shells[0]?.emit("$ ");

    expect(instance.log("tab-1")).toBe("$ ");
    expect(instance.log("tab-1")).toBe("$ ");
  });

  it("returns '' from log() for a tab with no shell", () => {
    const { instance } = manager();

    expect(instance.log("nope")).toBe("");
  });

  // The whole point of the change: the laptop's own xterm and a remote
  // client both watch the same pane, and neither takes it from the other.
  it("delivers output to every subscriber", () => {
    const { instance, shells } = manager();
    instance.start("tab-1", "/p/acme");
    const first: string[] = [];
    const second: string[] = [];
    instance.onOutput(({ chunk }) => first.push(chunk));
    instance.onOutput(({ chunk }) => second.push(chunk));

    shells[0]?.emit("ls\r\n");

    expect(first).toEqual(["ls\r\n"]);
    expect(second).toEqual(["ls\r\n"]);
  });

  it("names the pane each chunk came from, and keeps two panes apart", () => {
    const { instance, shells } = manager();
    instance.start("tab-1", "/p/acme");
    instance.start("tab-1:pane-2", "/p/acme");
    const seen: [string, string][] = [];
    instance.onOutput(({ paneKey, chunk }) => seen.push([paneKey, chunk]));

    shells[0]?.emit("a");
    shells[1]?.emit("b");

    expect(seen).toEqual([
      ["tab-1", "a"],
      ["tab-1:pane-2", "b"],
    ]);
  });

  it("stops delivering to a subscriber that unsubscribed", () => {
    const { instance, shells } = manager();
    instance.start("tab-1", "/p/acme");
    const seen: string[] = [];
    const off = instance.onOutput(({ chunk }) => seen.push(chunk));

    shells[0]?.emit("first");
    off();
    shells[0]?.emit("second");

    expect(seen).toEqual(["first"]);
  });

  it("caps the retained log, keeping the most recent output", () => {
    const { instance, shells } = manager({ maxLogChars: 8 });
    instance.start("tab-1", "/p/acme");

    shells[0]?.emit("0123456789");

    expect(instance.log("tab-1")).toBe("23456789");
  });

  it("tells every exit subscriber when the shell exits, and keeps the pane spawnable again", () => {
    const { instance, shells } = manager();
    instance.start("tab-1", "/p/acme");
    const seen: [string, number][] = [];
    instance.onShellExit(({ paneKey, code }) => seen.push([paneKey, code]));

    shells[0]?.emitExit(3);

    expect(seen).toEqual([["tab-1", 3]]);
    // An exited pane's key is not forgotten — the tab can still be reopened,
    // reusing its retained log and offset counter (ruling 11) — but start()
    // spawns a genuinely new process rather than reusing the dead one.
    instance.start("tab-1", "/p/acme");
    expect(shells).toHaveLength(2);
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

  it("kills a tab's shell and forgets it, including its log and offset counter", () => {
    const { instance, shells } = manager();
    instance.start("tab-1", "/p/a");
    shells[0]?.emit("some output");

    instance.kill("tab-1");
    expect(instance.has("tab-1")).toBe(false);
    instance.start("tab-1", "/p/a");

    expect(shells[0]?.killed).toBe(true);
    expect(shells).toHaveLength(2);
    expect(instance.snapshot("tab-1")).toEqual({ text: "", end: 0 });
  });

  it("kills every shell on stopAll, and forgets every pane", () => {
    const { instance, shells } = manager();
    instance.start("tab-1", "/p/a");
    instance.start("tab-2", "/p/b");

    instance.stopAll();

    expect(shells.map((shell) => shell.killed)).toEqual([true, true]);
    expect(instance.has("tab-1")).toBe(false);
    expect(instance.has("tab-2")).toBe(false);
  });

  it("lists fresh pane records without cwd or process handles, including retained exited panes", () => {
    const { instance, shells } = manager();
    instance.start("tab-1", "/private/path");
    instance.start("tab-1:split-a", "/private/path");
    shells[1]?.emitExit(0);

    const first = instance.panes();
    const second = instance.panes();

    expect(first).toEqual([
      { paneKey: "tab-1", exited: false },
      { paneKey: "tab-1:split-a", exited: true },
    ]);
    expect(second).toEqual(first);
    expect(second[0]).not.toBe(first[0]);
    expect(Object.keys(first[0] ?? {}).sort()).toEqual(["exited", "paneKey"]);
  });

  it("does not list a pane after kill forgets it", () => {
    const { instance, shells } = manager();
    instance.start("tab-1", "/p/a");
    shells[0]?.emitExit(0);

    expect(instance.panes()).toEqual([{ paneKey: "tab-1", exited: true }]);

    instance.kill("tab-1");

    expect(instance.panes()).toEqual([]);
  });

  it("lets a listener unsubscribe itself mid-dispatch without skipping the next listener", () => {
    const { instance, shells } = manager();
    instance.start("tab-1", "/p/acme");
    const seenA: string[] = [];
    const seenB: string[] = [];
    const offA = instance.onOutput(({ chunk }) => {
      seenA.push(chunk);
      offA();
    });
    instance.onOutput(({ chunk }) => seenB.push(chunk));

    shells[0]?.emit("first");
    shells[0]?.emit("second");

    expect(seenA).toEqual(["first"]);
    expect(seenB).toEqual(["first", "second"]);
  });

  describe("offsets and snapshots", () => {
    it("gives each chunk its own offset and reports a coherent snapshot", () => {
      const { instance, shells } = manager();
      instance.start("tab-1", "/p/acme");
      expect(instance.has("tab-1")).toBe(true);
      const seen: number[] = [];
      instance.onOutput(({ offset }) => seen.push(offset));

      shells[0]?.emit("ab");
      shells[0]?.emit("cde");

      expect(seen).toEqual([0, 2]);
      expect(instance.snapshot("tab-1")).toEqual({ text: "abcde", end: 5 });
    });

    it("returns an empty snapshot and false has() for an unknown pane", () => {
      const { instance } = manager();
      expect(instance.snapshot("nope")).toEqual({ text: "", end: 0 });
      expect(instance.has("nope")).toBe(false);
    });

    it("caps the retained log while end keeps counting every emitted character", () => {
      const { instance, shells } = manager({ maxLogChars: 4 });
      instance.start("tab-1", "/p");

      shells[0]?.emit("abc");
      shells[0]?.emit("defg");
      shells[0]?.emit("h");

      expect(instance.log("tab-1")).toBe("efgh");
      expect(instance.snapshot("tab-1")).toEqual({ text: "efgh", end: 8 });
    });

    // Bite-proof: `end` must come from the emitted counter, not from the
    // retained log's length — a single chunk bigger than the cap would
    // otherwise report `end` as the (smaller) trimmed log length.
    it("keeps `end` as the true emitted count even when a single chunk is truncated", () => {
      const { instance, shells } = manager({ maxLogChars: 4 });
      instance.start("tab-1", "/p");

      shells[0]?.emit("0123456789");

      expect(instance.log("tab-1")).toBe("6789");
      expect(instance.snapshot("tab-1").end).toBe(10);
    });

    it("matches the naive slice-based trim over 500 random chunk sequences", () => {
      const cap = 10;
      const { instance, shells } = manager({ maxLogChars: cap });
      instance.start("tab-1", "/p");
      const rand = mulberry32(20260917);
      const alphabet = "abcdefghij";
      let naive = "";

      for (let i = 0; i < 500; i += 1) {
        const length = Math.floor(rand() * 6); // 0..5 chars, including empty chunks
        let chunk = "";
        for (let j = 0; j < length; j += 1) {
          chunk += alphabet[Math.floor(rand() * alphabet.length)];
        }
        shells[0]?.emit(chunk);
        naive = (naive + chunk).slice(-cap);
        expect(instance.log("tab-1")).toBe(naive);
      }
    });

    it("updates the log and counter before dispatching to listeners", () => {
      const { instance, shells } = manager();
      instance.start("tab-1", "/p");
      let seenEnd: number | undefined;
      let seenLog: string | undefined;
      instance.onOutput(() => {
        seenEnd = instance.snapshot("tab-1").end;
        seenLog = instance.log("tab-1");
      });

      shells[0]?.emit("hi");

      expect(seenLog).toBe("hi");
      expect(seenEnd).toBe(2);
    });

    it("keeps an exited pane's tail retrievable, but refuses writes and resizes to the dead process", () => {
      const { instance, shells } = manager();
      instance.start("tab-1", "/p");
      const chunk = "x".repeat(1024);
      for (let i = 0; i < 100; i += 1) shells[0]?.emit(chunk);
      shells[0]?.emitExit(0);

      expect(instance.has("tab-1")).toBe(true);
      const log = instance.log("tab-1");
      expect(log.length).toBe(EXITED_LOG_CHARS);
      expect(instance.snapshot("tab-1")).toEqual({ text: log, end: 100 * 1024 });

      instance.write("tab-1", "should not land");
      instance.resize("tab-1", 80, 24);
      expect(shells[0]?.written).toEqual([]);
      expect(shells[0]?.resized).toEqual([]);
    });

    it("forgets a killed pane before its process's own exit event arrives, but still fires listeners once", () => {
      const { instance, shells } = manager();
      instance.start("tab-1", "/p");
      const seen: number[] = [];
      instance.onShellExit(({ code }) => seen.push(code));

      instance.kill("tab-1");
      expect(instance.has("tab-1")).toBe(false);
      // The pty's own exit event, delivered after kill() already tore the
      // entry down — a stale event, not a second pane.
      shells[0]?.emitExit(0);

      expect(instance.has("tab-1")).toBe(false);
      expect(seen).toEqual([0]);
    });

    it("spawns a fresh process for an exited pane, continuing the offset where it left off", () => {
      const { instance, shells } = manager();
      instance.start("tab-1", "/p");
      shells[0]?.emit("hello"); // 5 chars
      shells[0]?.emitExit(0);

      instance.start("tab-1", "/p");
      expect(shells).toHaveLength(2);

      const seen: number[] = [];
      instance.onOutput(({ offset }) => seen.push(offset));
      shells[1]?.emit("world");

      expect(seen).toEqual([5]);
    });

    // 64 MiB in 1 KiB chunks. The ceiling is a generous sanity check, not a
    // bite-proof — see the report for the measured time (old code: 881ms).
    it("stays fast and correct flooding 64 MiB through in 1 KiB chunks", () => {
      const { instance, shells } = manager();
      instance.start("tab-1", "/p");

      const totalChunks = 64 * 1024;
      const chunkSize = 1024;
      const chunks: string[] = new Array(totalChunks);
      for (let i = 0; i < totalChunks; i += 1) {
        chunks[i] = `${String(i).padStart(8, "0")}${"x".repeat(chunkSize - 8)}`;
      }

      const startedAt = Date.now();
      for (const chunk of chunks) shells[0]?.emit(chunk);
      const elapsed = Date.now() - startedAt;

      const log = instance.log("tab-1");
      const expectedTail = chunks.join("").slice(-(256 * 1024));
      expect(log.length).toBe(256 * 1024);
      expect(log).toBe(expectedTail);
      expect(instance.snapshot("tab-1").end).toBe(64 * 1024 * 1024);
      expect(elapsed).toBeLessThan(10_000);
    }, 20_000);
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

describe("shellCommand", () => {
  // The passwd lookup is injected so these stay true on any machine.
  const passwd = (value: string | undefined) => () => value;

  it("uses $SHELL when the user has one", () => {
    expect(shellCommand({ SHELL: "/usr/bin/fish" }, "linux")).toBe("/usr/bin/fish");
    expect(shellCommand({ SHELL: "/usr/bin/fish" }, "darwin")).toBe("/usr/bin/fish");
  });

  it("reads the passwd entry when $SHELL is unset", () => {
    // $SHELL is exported by a shell, and nothing that starts an app from a
    // desktop launcher, a .desktop entry or Finder is one — so a
    // launcher-started Jarvis has no $SHELL at all. The user still has a
    // login shell; it is in their passwd entry.
    //
    // This is not cosmetic. loginShellPath asks this shell for the real PATH,
    // and without it every binary is resolved against a GUI PATH of
    // /usr/bin:/bin — which is how the Editor, Database, Cluster and Docker
    // tabs all failed on a machine where those binaries were installed, and
    // why the startup report said "No agents are working".
    expect(shellCommand({}, "linux", passwd("/usr/bin/fish"))).toBe("/usr/bin/fish");
    expect(shellCommand({}, "darwin", passwd("/bin/zsh"))).toBe("/bin/zsh");
  });

  it("prefers $SHELL over the passwd entry when both are there", () => {
    // A user who exported a different shell for this session means it.
    expect(shellCommand({ SHELL: "/usr/bin/fish" }, "linux", passwd("/bin/bash"))).toBe(
      "/usr/bin/fish",
    );
  });

  it("falls back to zsh on macOS, its default since Catalina", () => {
    expect(shellCommand({}, "darwin", passwd(undefined))).toBe("/bin/zsh");
  });

  it("falls back to bash on Linux, where zsh is often not installed at all", () => {
    // A missing /bin/zsh is not a degraded terminal, it is no terminal: the
    // pty spawn fails and the tab shows nothing.
    expect(shellCommand({}, "linux", passwd(undefined))).toBe("/bin/bash");
  });

  it("treats an empty $SHELL, and an empty passwd shell, as unset", () => {
    expect(shellCommand({ SHELL: "" }, "linux", passwd(""))).toBe("/bin/bash");
    expect(shellCommand({ SHELL: "" }, "darwin", passwd(undefined))).toBe("/bin/zsh");
  });
});

describe("shellArgs", () => {
  it("asks for a login shell when there is no integration", () => {
    // Their profile, their PATH, their aliases, their prompt — the terminal
    // they actually have.
    expect(shellArgs({})).toEqual(["-l"]);
  });

  it("asks for a login shell under the zsh wrapper", () => {
    // ZDOTDIR does the redirection; the shell is still a login shell.
    expect(shellArgs({ zdotdir: "/cfg/zdotdir" })).toEqual(["-l"]);
  });

  it("asks for an interactive shell reading the wrapper under bash", () => {
    // bash honours --rcfile only for an interactive NON-login shell, so the
    // wrapper reads the profile files itself. See bash-integration.ts.
    expect(shellArgs({ rcfile: "/cfg/bash/bashrc" })).toEqual([
      "--rcfile",
      "/cfg/bash/bashrc",
      "-i",
    ]);
  });

  it("never passes -l beside --rcfile, which would make bash ignore it", () => {
    expect(shellArgs({ rcfile: "/cfg/bash/bashrc" })).not.toContain("-l");
  });
});

describe("shellEnv under each wrapper", () => {
  it("sets ZDOTDIR only for the zsh wrapper", () => {
    expect(shellEnv({}, { zdotdir: "/z" })["ZDOTDIR"]).toBe("/z");
    // bash's wrapper is an argument, not a variable; setting ZDOTDIR for it
    // would change which startup files a zsh started later reads.
    expect(shellEnv({}, { rcfile: "/b" })["ZDOTDIR"]).toBeUndefined();
  });

  it("sets the command log for either wrapper", () => {
    expect(shellEnv({}, { zdotdir: "/z", commandLog: "/l" })["JARVIS_COMMAND_LOG"]).toBe("/l");
    expect(shellEnv({}, { rcfile: "/b", commandLog: "/l" })["JARVIS_COMMAND_LOG"]).toBe("/l");
  });
});
