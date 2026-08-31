// @vitest-environment jsdom
//
// The Session view's own module. It hosts a real terminal emulator, which
// renders to a canvas and measures real character cells — neither of which
// jsdom has — so the vendored xterm modules are mocked with the doubles in
// terminal-double.ts. What is under test is Jarvis's half: which bytes reach
// the terminal, which keystrokes go back to the pty, whose output is
// filtered out, and where speech is routed. xterm's own rendering is not
// ours to test.
//
// Each test re-imports the module fresh: it holds module-level state (the
// terminal instance, which session is open, the voice target).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@jarvis/core";
import type { RendererApi } from "../src/ipc.js";
import { FakeFitAddon, FakeTerminal } from "./terminal-double.js";

vi.mock("./vendor/xterm.mjs", () => ({ Terminal: FakeTerminal }));
vi.mock("./vendor/addon-fit.mjs", () => ({ FitAddon: FakeFitAddon }));

function layoutDom(): void {
  document.body.innerHTML = `
    <div class="main" id="view-dashboard"></div>
    <div class="main main--changes" id="view-changes" hidden></div>
    <div class="main main--session" id="view-session" hidden>
      <div id="session-view-project"></div>
      <div id="session-view-path"></div>
      <div id="session-voice" hidden></div>
      <div id="session-view-state"></div>
      <div id="session-view-agent"></div>
      <div id="session-terminal"></div>
      <div id="session-empty" hidden></div>
    </div>
    <button id="nav-dashboard" class="nav-btn nav-btn--on" type="button"></button>
    <button id="nav-changes" class="nav-btn" type="button"></button>
    <button id="nav-session" class="nav-btn" type="button"></button>
  `;
}

type Jarvis = Pick<
  RendererApi,
  "getSessionLog" | "sendSessionInput" | "resizeSession" | "setVoiceTarget"
>;

function stubJarvis(overrides: Partial<Jarvis> = {}): Jarvis {
  const api: Jarvis = {
    getSessionLog: vi.fn(async () => ""),
    sendSessionInput: vi.fn(async () => {}),
    resizeSession: vi.fn(async () => {}),
    setVoiceTarget: vi.fn(async () => {}),
    ...overrides,
  };
  (window as unknown as { jarvis: Jarvis }).jarvis = api;
  return api;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    project: "acme",
    projectPath: "~/projects/acme",
    agentId: "claude-acme",
    model: "sonnet",
    state: "running",
    summary: "",
    startedAt: 1000,
    lastActivityAt: 2000,
    ...overrides,
  };
}

function term(): FakeTerminal {
  const instance = FakeTerminal.last;
  if (instance === undefined) throw new Error("No terminal was created");
  return instance;
}

beforeEach(() => {
  vi.resetModules();
  FakeTerminal.last = undefined;
  layoutDom();
  stubJarvis();
});

describe("openSession", () => {
  it("shows the view and names the session in its header", async () => {
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession());

    expect(document.getElementById("view-session")?.hidden).toBe(false);
    expect(document.getElementById("view-changes")?.hidden).toBe(true);
    expect(document.getElementById("view-dashboard")?.hidden).toBe(true);
    expect(document.getElementById("nav-session")?.className).toContain("nav-btn--on");
    expect(document.getElementById("session-view-project")?.textContent).toBe("acme");
    expect(document.getElementById("session-view-path")?.textContent).toBe("~/projects/acme");
    expect(document.getElementById("session-view-state")?.textContent).toBe("running");
    expect(document.getElementById("session-view-agent")?.textContent).toBe(
      "claude-acme · sonnet",
    );
  });

  it("mounts the terminal into the view's own pane", async () => {
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession());

    expect(term().opened).toBe(document.getElementById("session-terminal"));
    expect(term().focused).toBeGreaterThan(0);
  });

  // The backlog is why a session opened a minute into its run shows what it
  // already drew instead of an empty screen.
  it("writes the backlog the session already produced", async () => {
    stubJarvis({ getSessionLog: vi.fn(async () => "welcome banner\r\n") });
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession());

    expect(term().text).toBe("welcome banner\r\n");
  });

  // The bytes are a terminal's screen, not text: escape sequences must
  // reach the emulator exactly as the agent wrote them, or the UI they draw
  // comes out mangled.
  it("writes escape sequences through untouched", async () => {
    const banner = `${String.fromCharCode(27)}[1;36m✻ Welcome${String.fromCharCode(27)}[0m\r\n`;
    stubJarvis({ getSessionLog: vi.fn(async () => banner) });
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession());

    expect(term().text).toBe(banner);
  });

  it("clears the screen rather than interleaving when switching sessions", async () => {
    const logs: Record<string, string> = { s1: "first agent\r\n", s2: "second agent\r\n" };
    stubJarvis({ getSessionLog: vi.fn(async (id: string) => logs[id] ?? "") });
    const { openSession } = await import("./session-view.js");

    await openSession(makeSession({ id: "s1" }));
    await openSession(makeSession({ id: "s2" }));

    expect(term().text).toBe("second agent\r\n");
    expect(term().resets).toBe(2);
  });

  // A slow open must not dump its backlog into whatever session the user
  // clicked next.
  it("discards a backlog that arrives after the user switched sessions", async () => {
    let releaseFirst: (value: string) => void = () => {};
    stubJarvis({
      getSessionLog: vi.fn((id: string) =>
        id === "s1"
          ? new Promise<string>((resolve) => {
              releaseFirst = resolve;
            })
          : Promise.resolve("second agent\r\n"),
      ),
    });
    const { openSession } = await import("./session-view.js");

    const first = openSession(makeSession({ id: "s1" }));
    await openSession(makeSession({ id: "s2" }));
    releaseFirst("first agent\r\n");
    await first;

    expect(term().text).toBe("second agent\r\n");
  });

  it("keeps the terminal live when the backlog read fails", async () => {
    stubJarvis({
      getSessionLog: vi.fn(async () => {
        throw new Error("ipc exploded");
      }),
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { openSession, appendSessionOutput } = await import("./session-view.js");

    await openSession(makeSession());
    appendSessionOutput({ sessionId: "s1", chunk: "still streaming\r\n" });

    expect(term().text).toBe("still streaming\r\n");
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("appendSessionOutput", () => {
  it("writes chunks for the open session in the order they arrive", async () => {
    const { openSession, appendSessionOutput } = await import("./session-view.js");
    await openSession(makeSession());

    appendSessionOutput({ sessionId: "s1", chunk: "one\r\n" });
    appendSessionOutput({ sessionId: "s1", chunk: "two\r\n" });

    expect(term().text).toBe("one\r\ntwo\r\n");
  });

  // The channel carries every session's output — the main process has no
  // idea which one is on screen — so this filter is what stops two agents'
  // screens from being drawn over each other.
  it("ignores output belonging to a different session", async () => {
    const { openSession, appendSessionOutput } = await import("./session-view.js");
    await openSession(makeSession({ id: "s1" }));

    appendSessionOutput({ sessionId: "s2", chunk: "other agent\r\n" });

    expect(term().text).toBe("");
  });

  it("ignores output when no session is open at all", async () => {
    const { appendSessionOutput } = await import("./session-view.js");
    appendSessionOutput({ sessionId: "s1", chunk: "nobody is watching\r\n" });

    expect(FakeTerminal.last).toBeUndefined();
  });
});

describe("keyboard input", () => {
  it("forwards every keystroke to the open session's pty", async () => {
    const jarvis = stubJarvis();
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession({ id: "s1" }));

    term().emitData("h");
    term().emitData("i");

    expect(jarvis.sendSessionInput).toHaveBeenCalledWith("s1", "h");
    expect(jarvis.sendSessionInput).toHaveBeenCalledWith("s1", "i");
  });

  // Control bytes are the difference between a terminal and a text box:
  // Ctrl-C, arrow keys and Escape all arrive this way and must not be
  // filtered, trimmed or re-encoded.
  it("forwards control bytes unchanged", async () => {
    const jarvis = stubJarvis();
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession({ id: "s1" }));

    const ctrlC = String.fromCharCode(3);
    const arrowUp = `${String.fromCharCode(27)}[A`;
    term().emitData(ctrlC);
    term().emitData(arrowUp);

    expect(jarvis.sendSessionInput).toHaveBeenCalledWith("s1", ctrlC);
    expect(jarvis.sendSessionInput).toHaveBeenCalledWith("s1", arrowUp);
  });

  it("tells the pty its new size when the emulator re-fits", async () => {
    const jarvis = stubJarvis();
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession({ id: "s1" }));

    term().emitResize(120, 40);

    expect(jarvis.resizeSession).toHaveBeenCalledWith("s1", 120, 40);
  });
});

describe("voice routing", () => {
  // While a session's terminal is open, speaking means talking to THAT
  // agent. The main process holds the microphone and cannot see which view
  // is on screen, so the renderer has to name the target.
  it("claims the microphone for the session it opens", async () => {
    const jarvis = stubJarvis();
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession({ id: "s1" }));

    expect(jarvis.setVoiceTarget).toHaveBeenCalledWith("s1");
  });

  it("hands the microphone back to the brain when the view is left", async () => {
    const jarvis = stubJarvis();
    const { openSession, releaseVoice } = await import("./session-view.js");
    await openSession(makeSession({ id: "s1" }));
    releaseVoice();

    expect(jarvis.setVoiceTarget).toHaveBeenLastCalledWith(undefined);
  });

  it("says where speech will land while a session is open", async () => {
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession({ id: "s1" }));

    const badge = document.getElementById("session-voice");
    expect(badge?.hidden).toBe(false);
    expect(badge?.textContent).not.toBe("");
  });

  it("marks the indicator while speech is actually being captured", async () => {
    const { openSession, renderVoiceTarget } = await import("./session-view.js");
    await openSession(makeSession({ id: "s1" }));

    renderVoiceTarget(true, true);
    expect(document.getElementById("session-voice")?.className).toContain(
      "session-voice--listening",
    );

    renderVoiceTarget(true, false);
    expect(document.getElementById("session-voice")?.className).not.toContain(
      "session-voice--listening",
    );
  });
});

describe("updateSessionHeader", () => {
  it("follows the open session's state as it changes", async () => {
    const { openSession, updateSessionHeader } = await import("./session-view.js");
    await openSession(makeSession({ state: "running" }));

    updateSessionHeader([makeSession({ state: "dead" })]);

    expect(document.getElementById("session-view-state")?.textContent).toBe("dead");
  });

  it("ignores an update that does not include the open session", async () => {
    const { openSession, updateSessionHeader } = await import("./session-view.js");
    await openSession(makeSession({ id: "s1", state: "running" }));

    updateSessionHeader([makeSession({ id: "s2", state: "dead" })]);

    expect(document.getElementById("session-view-state")?.textContent).toBe("running");
  });
});

describe("empty state", () => {
  it("explains itself before any session has been opened", async () => {
    const { renderEmptyState } = await import("./session-view.js");
    renderEmptyState();

    const empty = document.getElementById("session-empty");
    expect(empty?.hidden).toBe(false);
    expect(empty?.textContent).not.toBe("");
  });

  it("gets out of the way once a session is showing", async () => {
    const { openSession, renderEmptyState } = await import("./session-view.js");
    renderEmptyState();
    await openSession(makeSession());

    expect(document.getElementById("session-empty")?.hidden).toBe(true);
  });

  it("does not throw against a DOM without the session markup", async () => {
    document.body.innerHTML = "";
    const { wireSessionView, renderEmptyState } = await import("./session-view.js");
    expect(() => wireSessionView()).not.toThrow();
    expect(() => renderEmptyState()).not.toThrow();
  });
});
