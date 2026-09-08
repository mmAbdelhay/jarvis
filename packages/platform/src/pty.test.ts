import { describe, expect, it } from "vitest";
import type { AgentConfig } from "@jarvis/core";
import { argsFor, createPtySpawner, DEFAULT_COLS, DEFAULT_ROWS } from "./pty.js";

// These run a real pty against real programs. That is the point: the bug
// this module exists to fix (an agent seeing a pipe instead of a terminal,
// deciding it was handed a single non-interactive prompt, and exiting) is
// invisible to any test that fakes the pty away. `/usr/bin/tty` and
// `/bin/echo` are on every POSIX system these tests run on.

const agent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: "test",
  command: "/bin/echo",
  ...overrides,
});

function collect(
  handle: ReturnType<ReturnType<typeof createPtySpawner>>,
): Promise<{ output: string; code: number }> {
  return new Promise((resolve) => {
    let output = "";
    handle.onOutput((chunk) => {
      output += chunk;
    });
    handle.onExit((code) => resolve({ output, code }));
  });
}

describe("createPtySpawner", () => {
  // The whole reason this module exists. `tty` prints the terminal device
  // name and exits 0 when stdin is a terminal; with a pipe it prints "not a
  // tty" and exits non-zero — which is exactly the condition that made
  // Claude Code exit with "Input must be provided either through stdin or
  // as a prompt argument when using --print".
  it("gives the child a real terminal on stdin", async () => {
    const spawn = createPtySpawner();
    const handle = spawn(agent({ command: "/usr/bin/tty" }), process.cwd());
    const { output, code } = await collect(handle);

    expect(code).toBe(0);
    expect(output).toContain("/dev/");
    expect(output).not.toContain("not a tty");
  });

  // The bug: main.ts spawns agents with process.env, and a Finder-launched
  // app's PATH is /usr/bin:/bin:/usr/sbin:/sbin — not where Homebrew or npm
  // put `claude`. Every agent was reported broken at startup and no session
  // could start, in installed builds only. The login shell's PATH is what
  // fixes it, but asking for it costs a shell start, and blocking the window
  // on a heavy .zshrc is its own regression — so the environment is resolved
  // when a child is spawned, long after startup, not when the spawner is
  // built.
  it("reads its environment at spawn time when given a function", async () => {
    let path = "/nowhere";
    const spawn = createPtySpawner(() => ({ ...process.env, PATH: path, MARKER: path }));
    // Resolved after the spawner was built, exactly as a login-shell lookup
    // finishing in the background would be.
    path = "/usr/bin:/bin";

    const handle = spawn(
      agent({ command: "/bin/sh", args: ["-c", "printf %s \"$MARKER\""] }),
      process.cwd(),
    );
    const { output } = await collect(handle);

    expect(output).toContain("/usr/bin:/bin");
  });

  it("runs the child in the project directory", async () => {
    const spawn = createPtySpawner();
    const handle = spawn(agent({ command: "/bin/pwd" }), "/tmp");
    const { output } = await collect(handle);

    // macOS resolves /tmp to /private/tmp; both spellings are the same dir.
    expect(output).toMatch(/\/tmp/);
  });

  it("declares a colour-capable terminal in TERM", async () => {
    const spawn = createPtySpawner();
    const handle = spawn(
      agent({ command: "/bin/sh", args: ["-c", "printf %s \"$TERM\""] }),
      process.cwd(),
    );
    const { output } = await collect(handle);

    expect(output).toContain("xterm-256color");
  });

  // A session Jarvis starts is the user's own top-level session. Inheriting
  // this marker makes an agent run degraded (transcripts off) — and it is
  // inherited exactly when Jarvis is launched from inside a Claude Code
  // session, i.e. throughout development.
  it("strips the inherited Claude Code child-session markers", async () => {
    const spawn = createPtySpawner({
      ...process.env,
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDECODE: "1",
    });
    const handle = spawn(
      agent({
        command: "/bin/sh",
        args: ["-c", 'printf "[%s][%s]" "$CLAUDE_CODE_CHILD_SESSION" "$CLAUDECODE"'],
      }),
      process.cwd(),
    );
    const { output } = await collect(handle);

    expect(output).toContain("[][]");
  });

  // An ambient API key outranks the OAuth credentials the wrapper's
  // CLAUDE_CONFIG_DIR points at, so a session labelled `claude-acme`
  // in the dashboard would silently bill API credits instead of that
  // subscription. brain.ts and capacity.ts already strip it; a session
  // spends far more than either.
  it("strips ANTHROPIC_API_KEY so the account's own credentials decide who pays", async () => {
    const spawn = createPtySpawner({ ...process.env, ANTHROPIC_API_KEY: "sk-should-not-reach-a-session" });
    const handle = spawn(
      agent({ command: "/bin/sh", args: ["-c", 'printf "[%s]" "$ANTHROPIC_API_KEY"'] }),
      process.cwd(),
    );
    const { output } = await collect(handle);

    expect(output).toContain("[]");
  });

  it("passes the configured model through as --model", async () => {
    const spawn = createPtySpawner();
    const handle = spawn(
      agent({ command: "/bin/echo", model: "sonnet" }),
      process.cwd(),
    );
    const { output } = await collect(handle);

    expect(output).toContain("--model sonnet");
  });

  // Config-supplied args are the user's explicit choice and must not be
  // duplicated or overridden by the convenience flag.
  it("leaves an explicitly configured --model alone", async () => {
    const spawn = createPtySpawner();
    const handle = spawn(
      agent({ command: "/bin/echo", model: "sonnet", args: ["--model", "opus"] }),
      process.cwd(),
    );
    const { output } = await collect(handle);

    expect(output).toContain("--model opus");
    expect(output).not.toContain("sonnet");
  });

  it("passes no model flag when the config names no model", async () => {
    const spawn = createPtySpawner();
    const handle = spawn(agent({ command: "/bin/echo", args: ["plain"] }), process.cwd());
    const { output } = await collect(handle);

    expect(output).toContain("plain");
    expect(output).not.toContain("--model");
  });

  it("passes the session id it was spawned with through to the child", async () => {
    const spawn = createPtySpawner();
    const handle = spawn(agent({ command: "/bin/echo" }), process.cwd(), "sid-through");
    const { output } = await collect(handle);

    expect(output).toContain("--session-id sid-through");
  });

  it("starts at the default terminal size and accepts a resize", async () => {
    const spawn = createPtySpawner();
    // `stty size` prints "rows cols" as the terminal reports them.
    const handle = spawn(
      agent({ command: "/bin/sh", args: ["-c", "stty size"] }),
      process.cwd(),
    );
    const { output } = await collect(handle);

    expect(output).toContain(`${DEFAULT_ROWS} ${DEFAULT_COLS}`);
  });

  it("reports a non-zero exit code", async () => {
    const spawn = createPtySpawner();
    const handle = spawn(agent({ command: "/bin/sh", args: ["-c", "exit 3"] }), process.cwd());
    const { code } = await collect(handle);

    expect(code).toBe(3);
  });

  // A killed process must never look like one that finished successfully —
  // the same conflation spawn.ts's exitCodeFor() exists to prevent.
  it("does not report a killed session as a clean exit", async () => {
    const spawn = createPtySpawner();
    const handle = spawn(agent({ command: "/bin/sh", args: ["-c", "sleep 30"] }), process.cwd());
    const exited = collect(handle);
    handle.kill();
    const { code } = await exited;

    expect(code).not.toBe(0);
  });

  it("replays the exit code to a listener that registers after the exit", async () => {
    const spawn = createPtySpawner();
    const handle = spawn(agent({ command: "/bin/sh", args: ["-c", "exit 7"] }), process.cwd());
    await collect(handle);

    const replayed = await new Promise<number>((resolve) => handle.onExit(resolve));
    expect(replayed).toBe(7);
  });

  it("dispatches the exit exactly once", async () => {
    const spawn = createPtySpawner();
    const handle = spawn(agent({ command: "/bin/echo", args: ["done"] }), process.cwd());
    let calls = 0;
    await new Promise<void>((resolve) => {
      handle.onExit(() => {
        calls += 1;
        resolve();
      });
    });
    // Give any duplicate event a chance to arrive.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(1);
  });

  // Keystrokes can be in flight from the renderer at the instant a session
  // ends. Writing to a dead pty throws EIO, which would otherwise take down
  // the main process.
  it("swallows writes and resizes to a session that has already exited", async () => {
    const spawn = createPtySpawner();
    const handle = spawn(agent({ command: "/bin/echo", args: ["bye"] }), process.cwd());
    await collect(handle);

    expect(() => handle.write("too late\r")).not.toThrow();
    expect(() => handle.resize?.(100, 30)).not.toThrow();
    expect(() => handle.kill()).not.toThrow();
  });

  it("sends typed input to the child", async () => {
    const spawn = createPtySpawner();
    const handle = spawn(
      agent({ command: "/bin/sh", args: ["-c", "read line; printf 'got:%s' \"$line\""] }),
      process.cwd(),
    );
    const exited = collect(handle);
    handle.write("hello\r");
    const { output } = await exited;

    expect(output).toContain("got:hello");
  });
});

// Exported and pinned by its own test for the same reason headlampArgs is:
// the flags a spawned agent is launched with are the whole contract with
// the CLI, and asserting them through a real pty proves the pty rather than
// the argument list.
describe("argsFor", () => {
  const claude: AgentConfig = { id: "claude-main", command: "claude-main" };

  // Without this, a Jarvis-spawned session's transcript lands under an id
  // the CLI minted for itself, and the importer records the same
  // conversation twice — once from SessionManager, once from a transcript
  // it cannot tell is the same session.
  it("passes the session id Jarvis minted", () => {
    expect(argsFor(claude, "sid-1")).toEqual(["--session-id", "sid-1"]);
  });

  it("adds nothing when no session id is given", () => {
    expect(argsFor({ ...claude, args: ["--foo"] })).toEqual(["--foo"]);
  });

  // --session-id is not a flag every agent CLI shares a meaning for. The
  // Copilot CLI takes it as "resume the session with this id", so handing it
  // the freshly minted id of a session that does not exist yet asks it to
  // resume nothing. The flag exists only to let the transcript importer
  // recognise a session Jarvis started, and the importer reads anthropic
  // agents only — so the flag goes exactly where the importer looks.
  it("does not pass a session id to a non-anthropic agent", () => {
    const copilot: AgentConfig = { id: "copilot", command: "copilot", vendor: "github" };
    expect(argsFor(copilot, "sid-1")).not.toContain("--session-id");
  });

  it("passes a session id to an agent that declares no vendor", () => {
    // Unset vendor keeps today's behaviour rather than silently opting an
    // agent out of the dedup it would otherwise get.
    expect(argsFor({ id: "x", command: "x" }, "sid-1")).toContain("--session-id");
  });

  // Config-supplied args are the user's explicit choice — the same rule
  // --model already follows.
  it("leaves a configured --session-id alone", () => {
    expect(argsFor({ ...claude, args: ["--session-id", "theirs"] }, "sid-1")).toEqual([
      "--session-id",
      "theirs",
    ]);
  });

  it("keeps the model flag alongside the session id", () => {
    expect(argsFor({ ...claude, model: "opus" }, "sid-1")).toEqual([
      "--model",
      "opus",
      "--session-id",
      "sid-1",
    ]);
  });

  it("appends after the configured args, which come first", () => {
    expect(argsFor({ ...claude, args: ["--dangerously-skip-permissions"] }, "sid-1")).toEqual([
      "--dangerously-skip-permissions",
      "--session-id",
      "sid-1",
    ]);
  });
});
