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
      <button id="session-resume" hidden></button>
      <div id="session-view-agent"></div>
      <button id="session-back" hidden></button>
      <div id="session-detail" hidden></div>
      <div id="session-terminal"></div>
      <div id="session-transcript" hidden></div>
      <div id="session-empty" hidden></div>
      <div id="session-table" hidden>
        <input id="session-search" />
        <select id="session-filter-project"></select>
        <select id="session-filter-agent"></select>
        <div id="session-count"></div>
        <button id="session-refresh" type="button"></button>
        <div id="session-table-status"></div>
        <table><thead><tr><th data-sort="project"></th><th data-sort="lastActivityAt"></th></tr></thead><tbody id="session-table-body"></tbody></table>
      </div>
    </div>
    <button id="nav-dashboard" class="nav-btn nav-btn--on" type="button"></button>
    <button id="nav-changes" class="nav-btn" type="button"></button>
    <button id="nav-session" class="nav-btn" type="button"></button>
  `;
}

type Jarvis = Pick<
  RendererApi,
  | "getSessionLog"
  | "getSessionTranscript"
  | "resumeSession"
  | "getHistory"
  | "listSessions"
  | "refreshSessions"
  | "sendSessionInput"
  | "resizeSession"
  | "setVoiceTarget"
>;

function stubJarvis(overrides: Partial<Jarvis> = {}): Jarvis {
  const api: Jarvis = {
    getSessionLog: vi.fn(async () => ""),
    getSessionTranscript: vi.fn(async () => []),
    resumeSession: vi.fn(async () => ({ ok: true, project: "app", language: "en" as const })),
    getHistory: vi.fn(async () => [] as Session[]),
    listSessions: vi.fn(async () => [] as Session[]),
    refreshSessions: vi.fn(async () => ({ jarvis: 0, external: 0, importedTranscripts: 0 })),
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
    expect(document.getElementById("session-view-agent")?.textContent).toBe("claude-acme · sonnet");
  });

  // The terminal is opened into the pane's own live element rather than
  // straight into #session-terminal — terminal-pane.ts builds the block
  // list, the sticky header and the live terminal inside the host it is
  // given. What matters here is unchanged: the emulator lives inside the
  // view's pane, and it has the keys.
  it("mounts the terminal into the view's own pane", async () => {
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession());

    const host = document.getElementById("session-terminal");
    expect(host?.querySelector(".terminal-pane")).not.toBeNull();
    expect(host?.contains(term().opened as Node)).toBe(true);
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

  // A session started in a terminal has no pty backlog at all — only the
  // transcript the importer recorded. Before this, clicking one opened a
  // blank screen, which is what "clicking a session does nothing" was.
  // A recorded conversation is not terminal output, so it is laid out as
  // one instead of written into xterm.
  it("shows the transcript as a conversation when there is no backlog", async () => {
    stubJarvis({
      getSessionLog: vi.fn(async () => ""),
      getSessionTranscript: vi.fn(async () => [
        { role: "user" as const, text: "fetch all my bugs", tools: [] },
        { role: "assistant" as const, text: "On it.", tools: ["Bash"] },
      ]),
    });
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession());

    const view = document.getElementById("session-transcript");
    expect(view?.hidden).toBe(false);
    expect(document.getElementById("session-terminal")?.hidden).toBe(true);
    expect(view?.querySelectorAll(".transcript-turn")).toHaveLength(2);
    expect(view?.textContent).toContain("fetch all my bugs");
    expect(view?.querySelector(".transcript-tool")?.textContent).toBe("Bash");
  });

  it("tells a user turn from an assistant turn", async () => {
    stubJarvis({
      getSessionLog: vi.fn(async () => ""),
      getSessionTranscript: vi.fn(async () => [
        { role: "user" as const, text: "hi", tools: [] },
        { role: "assistant" as const, text: "hello", tools: [] },
      ]),
    });
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession());

    const turns = document.querySelectorAll(".transcript-turn");
    expect(turns[0]?.className).toContain("transcript-turn--user");
    expect(turns[1]?.className).toContain("transcript-turn--assistant");
  });

  // Transcript text is whatever was typed at an agent; it is displayed,
  // never interpreted.
  it("renders a turn as text, never as markup", async () => {
    stubJarvis({
      getSessionLog: vi.fn(async () => ""),
      getSessionTranscript: vi.fn(async () => [
        { role: "user" as const, text: "<img src=x onerror=alert(1)>", tools: [] },
      ]),
    });
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession());

    expect(document.querySelector("#session-transcript img")).toBeNull();
    expect(document.getElementById("session-transcript")?.textContent).toContain("<img");
  });

  // A live session's output really is terminal output and keeps the emulator.
  it("keeps the terminal for a session with a backlog", async () => {
    stubJarvis({ getSessionLog: vi.fn(async () => "live output\r\n") });
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession());

    expect(document.getElementById("session-transcript")?.hidden).toBe(true);
    expect(term().text).toBe("live output\r\n");
  });

  // The backlog is the live truth for a session Jarvis owns; asking for a
  // transcript it does not have would be a wasted round trip on every open.
  it("does not ask for a transcript when a backlog exists", async () => {
    const getSessionTranscript = vi.fn(async () => []);
    stubJarvis({ getSessionLog: vi.fn(async () => "live output\r\n"), getSessionTranscript });
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession());

    expect(getSessionTranscript).not.toHaveBeenCalled();
    expect(term().text).toBe("live output\r\n");
  });

  // A transcript read that fails must leave the view usable, not throw.
  it("survives a transcript that cannot be read", async () => {
    stubJarvis({
      getSessionLog: vi.fn(async () => ""),
      getSessionTranscript: vi.fn(async () => {
        throw new Error("nope");
      }),
    });
    const { openSession } = await import("./session-view.js");
    await expect(openSession(makeSession())).resolves.toBeUndefined();
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

  // The property, named: the clear is ordered behind the write buffer, so
  // the previous agent's bytes are drawn *and then* wiped, never wiped and
  // then drawn. Terminal.write() defers its parsing to a macrotask and
  // reset() neither drains nor discards what is queued, so a reset called
  // straight from openSession clears an empty screen and the last agent's
  // still-queued output paints over it — the interleaving this route is
  // supposed to prevent, arriving by the back door.
  //
  // The double models the queue (see terminal-double.ts), so the ordering is
  // what decides this test rather than the timing of either write: with the
  // reset synchronous, the first agent's screen survives into the second's.
  it("clears the screen behind the write buffer, not in front of it", async () => {
    const logs: Record<string, string> = { s1: "first agent\r\n", s2: "second agent\r\n" };
    stubJarvis({ getSessionLog: vi.fn(async (id: string) => logs[id] ?? "") });
    const { openSession } = await import("./session-view.js");

    await openSession(makeSession({ id: "s1" }));
    // Deliberately *not* reading term().text here: that would drain the
    // buffer and hand the second open a screen that had already been
    // parsed, which is the one situation in which the bug cannot show.
    await openSession(makeSession({ id: "s2" }));
    // Let the queue drain on its own macrotask, the way it does in a real
    // window with nobody asking questions.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(term().text).toBe("second agent\r\n");
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

  // Almost every session is an agent holding the alternate screen from its
  // first byte to its last, and a pane suppresses blocks for as long as
  // anything does — which is why the Session view looks unchanged. But the
  // machinery is the same machinery: a session that drops back to a shell
  // prompt carrying the integration marks gets the blocks every other
  // terminal gets, rather than a second, lesser terminal.
  it("draws blocks for a session that prints the integration marks", async () => {
    const jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    jarvis["terminalSettings"] = () =>
      Promise.resolve({ blocks: true, inputEditor: false, notifyAfterSeconds: 0, home: "/h" });
    const { openSession, appendSessionOutput } = await import("./session-view.js");
    // The settings arrive on a promise; a pane built before it resolves is
    // deliberately the plain terminal, so the pane under test comes after.
    await new Promise((resolve) => setTimeout(resolve, 0));

    await openSession(makeSession({ id: "s1" }));
    const pane = document.querySelector<HTMLElement>(".terminal-pane");
    expect(pane?.dataset["state"]).toBe("blocks");

    // Two runs between prompts, exactly as they arrive from the pty.
    appendSessionOutput({
      sessionId: "s1",
      chunk:
        `\u001b]133;A\u0007$ \u001b]133;B\u0007pnpm test\r\n` +
        `\u001b]133;C;pnpm test\u0007ok\r\n\u001b]133;D;0\u0007`,
      offset: 0,
    });
    appendSessionOutput({
      sessionId: "s1",
      chunk:
        `\u001b]133;A\u0007$ \u001b]133;B\u0007false\r\n` +
        `\u001b]133;C;false\u0007\u001b]133;D;1\u0007`,
      offset: 0,
    });

    expect(pane?.querySelectorAll(".block")).toHaveLength(2);
  });

  // The pane outlives any one session — it is pointed at whichever agent is
  // open — so the blocks have to be cleared with the screen. No agent
  // produces blocks today (an agent binary is exec'd directly, with no shell
  // stage to print the marks), which is exactly why this needs a test rather
  // than a comment: the day that stops being true, one agent's output must
  // not appear under another agent's terminal.
  it("clears the previous session's blocks when another session is opened", async () => {
    const jarvis = (window as unknown as { jarvis: Record<string, unknown> }).jarvis;
    jarvis["terminalSettings"] = () =>
      Promise.resolve({ blocks: true, inputEditor: false, notifyAfterSeconds: 0, home: "/h" });
    const { openSession, appendSessionOutput } = await import("./session-view.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    await openSession(makeSession({ id: "s1" }));
    appendSessionOutput({
      sessionId: "s1",
      chunk:
        `\u001b]133;A\u0007$ \u001b]133;B\u0007first agent\r\n` +
        `\u001b]133;C;first agent\u0007ok\r\n\u001b]133;D;0\u0007`,
      offset: 0,
    });
    const pane = document.querySelector<HTMLElement>(".terminal-pane");
    expect(pane?.querySelectorAll(".block")).toHaveLength(1);

    await openSession(makeSession({ id: "s2" }));

    expect(pane?.querySelectorAll(".block")).toHaveLength(0);
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
    appendSessionOutput({ sessionId: "s1", chunk: "still streaming\r\n", offset: 0 });

    expect(term().text).toBe("still streaming\r\n");
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  // The same race terminal-pane.ts's own write-gate exists for: a push that
  // arrived while getSessionLog was still in flight is already inside
  // whatever backlog that call is about to return, so writing it live too
  // would draw it twice. See `settledId`'s own comment in session-view.ts.
  describe("the live-output gate", () => {
    it("drops a push that arrives before the backlog fetch resolves", async () => {
      let releaseLog: (value: string) => void = () => {};
      stubJarvis({
        getSessionLog: vi.fn(
          () =>
            new Promise<string>((resolve) => {
              releaseLog = resolve;
            }),
        ),
      });
      const { openSession, appendSessionOutput } = await import("./session-view.js");

      const opening = openSession(makeSession({ id: "s1" }));
      appendSessionOutput({ sessionId: "s1", chunk: "too early\r\n", offset: 0 });
      expect(term().text).toBe("");

      releaseLog("banner\r\n");
      await opening;

      // The backlog only, not the dropped push doubled onto it.
      expect(term().text).toBe("banner\r\n");
    });

    it("writes a push that arrives after the backlog fetch resolves", async () => {
      const { openSession, appendSessionOutput } = await import("./session-view.js");
      await openSession(makeSession({ id: "s1" }));

      appendSessionOutput({ sessionId: "s1", chunk: "on time\r\n", offset: 0 });

      expect(term().text).toBe("on time\r\n");
    });

    // A slower open's backlog is already discarded by the currentId check
    // above (see "discards a backlog that arrives after the user switched
    // sessions") — this is the same race for the gate itself: opening s2
    // must not let s1's late resolution mark s2 as settled and admit a push
    // that arrived for s1 before its own fetch ever came back.
    it("does not let a stale resolution settle the session the user switched to", async () => {
      let releaseFirst: (value: string) => void = () => {};
      stubJarvis({
        getSessionLog: vi.fn((id: string) =>
          id === "s1"
            ? new Promise<string>((resolve) => {
                releaseFirst = resolve;
              })
            : Promise.resolve(""),
        ),
      });
      const { openSession, appendSessionOutput } = await import("./session-view.js");

      const first = openSession(makeSession({ id: "s1" }));
      await openSession(makeSession({ id: "s2" }));

      appendSessionOutput({ sessionId: "s2", chunk: "live for s2\r\n", offset: 0 });
      expect(term().text).toBe("live for s2\r\n");

      releaseFirst("s1's stale banner\r\n");
      await first;

      // Neither the stale backlog nor a push mistakenly admitted under it.
      expect(term().text).toBe("live for s2\r\n");
    });

    // Reopening the same session must close the gate again: settledId is
    // module state, so without a reset it would still equal "s1" from the
    // first open, and a push during the second open's own fetch would pass
    // the (stale) gate and land both live and in the backlog about to be
    // written.
    it("closes the gate again when the same session is reopened", async () => {
      let releaseLog: (value: string) => void = () => {};
      const getSessionLog = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            releaseLog = resolve;
          }),
      );
      stubJarvis({ getSessionLog });
      const { openSession, appendSessionOutput } = await import("./session-view.js");

      // First open resolves normally, settling s1.
      const first = openSession(makeSession({ id: "s1" }));
      releaseLog("");
      await first;

      // Reopen s1: its backlog fetch is pending again.
      const reopening = openSession(makeSession({ id: "s1" }));
      appendSessionOutput({ sessionId: "s1", chunk: "too early again\r\n", offset: 0 });
      expect(term().text).toBe("");

      releaseLog("banner\r\n");
      await reopening;

      // The backlog only, not the dropped push doubled onto it.
      expect(term().text).toBe("banner\r\n");

      appendSessionOutput({ sessionId: "s1", chunk: "on time\r\n", offset: 0 });
      expect(term().text).toBe("banner\r\non time\r\n");
    });
  });
});

describe("appendSessionOutput", () => {
  it("writes chunks for the open session in the order they arrive", async () => {
    const { openSession, appendSessionOutput } = await import("./session-view.js");
    await openSession(makeSession());

    appendSessionOutput({ sessionId: "s1", chunk: "one\r\n", offset: 0 });
    appendSessionOutput({ sessionId: "s1", chunk: "two\r\n", offset: 0 });

    expect(term().text).toBe("one\r\ntwo\r\n");
  });

  // The channel carries every session's output — the main process has no
  // idea which one is on screen — so this filter is what stops two agents'
  // screens from being drawn over each other.
  it("ignores output belonging to a different session", async () => {
    const { openSession, appendSessionOutput } = await import("./session-view.js");
    await openSession(makeSession({ id: "s1" }));

    appendSessionOutput({ sessionId: "s2", chunk: "other agent\r\n", offset: 0 });

    expect(term().text).toBe("");
  });

  it("ignores output when no session is open at all", async () => {
    const { appendSessionOutput } = await import("./session-view.js");
    appendSessionOutput({ sessionId: "s1", chunk: "nobody is watching\r\n", offset: 0 });

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

  // Shift+Enter means "newline, not send" to Claude Code and every other
  // agent UI — but only if the terminal distinguishes it from Enter, which
  // xterm does not on its own: it encodes both as a bare CR.
  it("sends ESC+CR for shift+enter rather than the bare CR xterm would", async () => {
    const jarvis = stubJarvis();
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession({ id: "s1" }));

    const handled = term().pressKey({ key: "Enter", shiftKey: true });

    expect(handled).toBe(false);
    expect(jarvis.sendSessionInput).toHaveBeenCalledWith(
      "s1",
      `${String.fromCharCode(27)}${String.fromCharCode(13)}`,
    );
  });

  it("leaves a plain Enter to xterm's own encoding", async () => {
    const jarvis = stubJarvis();
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession({ id: "s1" }));

    expect(term().pressKey({ key: "Enter" })).toBe(true);
    expect(jarvis.sendSessionInput).not.toHaveBeenCalled();
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

// A phone may resize the session's pty while the laptop's own Session view
// is not looking (ruling 11: last writer wins, both sides re-assert). fit()
// only calls back into hooks.resize on a genuine change of the pane's own
// cell grid, so without an explicit, unconditional re-assertion the laptop
// would go on believing its own last-known size forever.
describe("reassertSessionSize", () => {
  // [bite-proof: send only when fit reports a change; the test fails]
  it("sends the pty's current size when a session opens, even though the pane's size did not change", async () => {
    const jarvis = stubJarvis();
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession({ id: "s1" }));

    // No emitResize() was fired — the emulator's cell grid never changed
    // from its default. The send must still have gone out.
    expect(jarvis.resizeSession).toHaveBeenCalledWith("s1", 80, 24);
  });

  it("sends the current size once when the window regains focus while the Session view is showing", async () => {
    const jarvis = stubJarvis();
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession({ id: "s1" }));
    vi.mocked(jarvis.resizeSession).mockClear();

    window.dispatchEvent(new Event("focus"));

    expect(jarvis.resizeSession).toHaveBeenCalledTimes(1);
    expect(jarvis.resizeSession).toHaveBeenCalledWith("s1", 80, 24);
  });

  it("sends nothing on focus while another view is showing", async () => {
    const jarvis = stubJarvis();
    const { openSession } = await import("./session-view.js");
    const { showView } = await import("./views.js");
    await openSession(makeSession({ id: "s1" }));
    vi.mocked(jarvis.resizeSession).mockClear();

    showView("dashboard");
    window.dispatchEvent(new Event("focus"));

    expect(jarvis.resizeSession).not.toHaveBeenCalled();
  });

  it("sends nothing on focus when no session is open", async () => {
    const jarvis = stubJarvis();
    await import("./session-view.js");

    window.dispatchEvent(new Event("focus"));

    expect(jarvis.resizeSession).not.toHaveBeenCalled();
  });

  it("sends nothing on focus when the pane measures 0x0", async () => {
    const jarvis = stubJarvis();
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession({ id: "s1" }));
    term().cols = 0;
    term().rows = 0;
    vi.mocked(jarvis.resizeSession).mockClear();

    window.dispatchEvent(new Event("focus"));

    expect(jarvis.resizeSession).not.toHaveBeenCalled();
  });

  // Fix round 1, I2: currentView() alone cannot tell a terminal from a
  // table — both keep the route at "session". Pressing Back leaves the
  // pane's last-known, non-zero cols/rows sitting there while the table
  // covers the screen; a focus that trusted currentView() alone would
  // send that stale size and reflow a terminal nobody on the laptop can
  // see.
  it(// [bite-proof: gate on currentView() alone; the test fails]
  "sends nothing on focus while the session table is showing over a previously open session", async () => {
    const jarvis = stubJarvis();
    const { openSession, renderSessionTable } = await import("./session-view.js");
    await openSession(makeSession({ id: "s1" }));
    await renderSessionTable();
    vi.mocked(jarvis.resizeSession).mockClear();

    window.dispatchEvent(new Event("focus"));

    expect(jarvis.resizeSession).not.toHaveBeenCalled();
  });

  // Fix round 1, I1: nav-session's click handler used to call
  // reassertSessionSize() synchronously, alongside — not after —
  // renderSessionTable()'s fire-and-forget promise. Clicked from an
  // already-open session, that ran while the terminal was still the
  // thing on screen (currentView() had not moved and terminalVisible had
  // not yet flipped), so it sent the now-stale size of a terminal about
  // to be replaced by the table.
  it(// [bite-proof: call reassertSessionSize() synchronously instead of
  // chaining it onto renderSessionTable(); the test fails]
  "does not describe the terminal it is about to hide when nav-session is clicked from an open session", async () => {
    let resolveHistory: (value: Session[]) => void = () => {};
    const historyPromise = new Promise<Session[]>((resolve) => {
      resolveHistory = resolve;
    });
    const jarvis = stubJarvis({ getHistory: vi.fn(() => historyPromise) });
    const { openSession, wireSessionView } = await import("./session-view.js");
    wireSessionView();
    await openSession(makeSession({ id: "s1" }));
    vi.mocked(jarvis.resizeSession).mockClear();

    document.getElementById("nav-session")?.dispatchEvent(new Event("click", { bubbles: true }));

    // getHistory has not resolved yet — the terminal is still what is
    // on screen, and the re-assert must not have fired against it.
    expect(jarvis.resizeSession).not.toHaveBeenCalled();

    resolveHistory([]);
    await historyPromise;
    // Let renderSessionTable()'s own continuation, and the .then() the
    // click handler chained onto it, run.
    await Promise.resolve();
    await Promise.resolve();

    // The table is what settled — no terminal to describe.
    expect(jarvis.resizeSession).not.toHaveBeenCalled();
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

describe("resume", () => {
  // A session Jarvis is already running has a live process; resuming it
  // would spawn a second agent against the same conversation.
  it("offers resume only for a session that has ended", async () => {
    stubJarvis();
    const { openSession } = await import("./session-view.js");

    await openSession(makeSession({ state: "done" }));
    expect(document.getElementById("session-resume")?.hidden).toBe(false);

    await openSession(makeSession({ state: "running" }));
    expect(document.getElementById("session-resume")?.hidden).toBe(true);
  });

  it("resumes the session that is on screen", async () => {
    const resumeSession = vi.fn(async () => ({ ok: true, language: "en" as const }));
    stubJarvis({ resumeSession });
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession({ id: "past-1", state: "done" }));

    document.getElementById("session-resume")?.click();
    await Promise.resolve();

    expect(resumeSession).toHaveBeenCalledWith("past-1", expect.anything());
  });

  // A refusal has to be visible: a button that silently does nothing is the
  // bug this whole feature exists to fix.
  it("says why when a resume is refused", async () => {
    stubJarvis({
      resumeSession: vi.fn(async () => ({
        ok: false,
        text: "This session cannot be resumed.",
        language: "en" as const,
      })),
    });
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession({ state: "done" }));

    document.getElementById("session-resume")?.click();
    await Promise.resolve();
    await Promise.resolve();

    // The refusal lands in the sessions view's own status line, which is
    // where both Resume buttons report — a button that silently does nothing
    // is the bug this whole view exists to fix.
    expect(document.getElementById("session-table-status")?.textContent).toContain(
      "cannot be resumed",
    );
  });
});

describe("session table", () => {
  const rows = (): HTMLElement[] =>
    [...document.querySelectorAll("#session-table-body > tr")] as HTMLElement[];

  it("lists every recorded session", async () => {
    stubJarvis({
      getHistory: vi.fn(async () => [
        makeSession({ id: "a", summary: "first" }),
        makeSession({ id: "b", summary: "second" }),
      ]),
    });
    const { renderSessionTable } = await import("./session-view.js");
    await renderSessionTable();

    expect(rows()).toHaveLength(2);
    expect(rows()[0]?.textContent).toContain("first");
  });

  // Re-review 2, item 6: a registry agent (jarvis.yaml) with zero sessions
  // behind it must still appear in the agent filter, not just an agent that
  // has already run something.
  it("lists a registry agent with no sessions in the agent filter", async () => {
    stubJarvis({
      getHistory: vi.fn(async () => [makeSession({ id: "a", agentId: "claude-acme" })]),
    });
    const { renderSessionTable, setKnownAgents } = await import("./session-view.js");
    setKnownAgents(["codex"]);
    await renderSessionTable();

    const options = [
      ...document.querySelectorAll<HTMLOptionElement>("#session-filter-agent option"),
    ].map((o) => o.value);
    expect(options).toContain("codex");
    expect(options).toContain("claude-acme");
  });

  // The whole point of the table: every row can be picked back up.
  it("gives every row a Resume button", async () => {
    stubJarvis({ getHistory: vi.fn(async () => [makeSession({ id: "a", state: "done" })]) });
    const { renderSessionTable } = await import("./session-view.js");
    await renderSessionTable();

    expect(rows()[0]?.querySelector("button")?.textContent).toBe("Resume");
  });

  it("resumes the row's own session, naming the selected project", async () => {
    const resumeSession = vi.fn(async () => ({
      ok: true,
      project: "app",
      language: "en" as const,
    }));
    stubJarvis({
      getHistory: vi.fn(async () => [makeSession({ id: "the-one" })]),
      resumeSession,
    });
    const { renderSessionTable } = await import("./session-view.js");
    await renderSessionTable();

    rows()[0]?.querySelector("button")?.click();
    await Promise.resolve();

    expect(resumeSession).toHaveBeenCalledWith("the-one", expect.anything());
  });

  // A row is untrusted text: a summary is whatever the user typed into an
  // agent, and it reaches this table straight from a transcript.
  it("renders a summary as text, never as markup", async () => {
    stubJarvis({
      getHistory: vi.fn(async () => [makeSession({ summary: "<img src=x onerror=alert(1)>" })]),
    });
    const { renderSessionTable } = await import("./session-view.js");
    await renderSessionTable();

    expect(document.querySelector("#session-table-body img")).toBeNull();
    expect(rows()[0]?.textContent).toContain("<img");
  });

  it("says so rather than showing an empty table when there are none", async () => {
    stubJarvis({ getHistory: vi.fn(async () => []) });
    const { renderSessionTable } = await import("./session-view.js");
    await renderSessionTable();

    expect(document.getElementById("session-table")?.textContent).toMatch(/no sessions/i);
  });

  // Opening a session hides the table; going back brings it out again.
  it("swaps between the table and a session's terminal", async () => {
    stubJarvis({ getHistory: vi.fn(async () => [makeSession()]) });
    const { renderSessionTable, openSession } = await import("./session-view.js");
    await renderSessionTable();
    expect(document.getElementById("session-table")?.hidden).toBe(false);

    await openSession(makeSession());
    expect(document.getElementById("session-table")?.hidden).toBe(true);
    expect(document.getElementById("session-back")?.hidden).toBe(false);

    document.getElementById("session-back")?.click();
    // renderSessionTable() now awaits Promise.allSettled([getHistory(),
    // listSessions()]) rather than one bare await, which costs one more
    // microtask hop than a single `await Promise.resolve()` covers.
    await Promise.resolve();
    await Promise.resolve();
    expect(document.getElementById("session-table")?.hidden).toBe(false);
  });

  // A row process-scan.ts found running outside Jarvis never comes back
  // from getHistory() (session-import.ts's own discipline: nothing there
  // can prove it is still alive) — only from listSessions.
  it("shows an outside-Jarvis chip and no Resume button for an external row, and never navigates into a terminal", async () => {
    const getSessionTranscript = vi.fn(async () => [
      { role: "user" as const, text: "hi", tools: [] },
    ]);
    stubJarvis({
      getHistory: vi.fn(async () => []),
      listSessions: vi.fn(async () => [
        makeSession({ id: "ext-1234", origin: "external", pid: 1234, agentId: "claude" }),
      ]),
      getSessionTranscript,
    });
    const { renderSessionTable } = await import("./session-view.js");
    await renderSessionTable();

    const row = rows()[0];
    expect(row?.querySelector(".session-chip--external")).not.toBeNull();
    expect(row?.querySelector("button")).toBeNull();

    row?.click();
    await Promise.resolve();
    await Promise.resolve();

    // Opens the transcript, never a live terminal — no input channel is
    // touched for a row with no pty behind it.
    expect(getSessionTranscript).toHaveBeenCalledWith("ext-1234");
    expect(document.getElementById("session-terminal")?.hidden).toBe(true);
  });

  it("shows a notice, not a blank terminal, for an external row with no matched transcript", async () => {
    stubJarvis({
      getHistory: vi.fn(async () => []),
      listSessions: vi.fn(async () => [
        makeSession({ id: "ext-1234", origin: "external", pid: 1234 }),
      ]),
      getSessionTranscript: vi.fn(async () => []),
    });
    const { renderSessionTable } = await import("./session-view.js");
    await renderSessionTable();

    rows()[0]?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById("session-transcript")?.hidden).toBe(false);
    expect(document.getElementById("session-transcript")?.textContent).toMatch(/transcript/i);
  });
});

describe("sessions refresh", () => {
  it("calls sessions:refresh exactly once per click and toggles the spinner", async () => {
    let resolveRefresh: (value: {
      jarvis: number;
      external: number;
      importedTranscripts: number;
    }) => void = () => {};
    const refreshSessions = vi.fn(
      () =>
        new Promise<{ jarvis: number; external: number; importedTranscripts: number }>(
          (resolve) => {
            resolveRefresh = resolve;
          },
        ),
    );
    stubJarvis({ refreshSessions });
    const { wireSessionView } = await import("./session-view.js");
    wireSessionView();

    const button = document.getElementById("session-refresh") as HTMLButtonElement;
    button.click();

    expect(refreshSessions).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.classList.contains("icon-btn--spinning")).toBe(true);

    resolveRefresh({ jarvis: 0, external: 0, importedTranscripts: 0 });
    await Promise.resolve();
    await Promise.resolve();

    expect(button.disabled).toBe(false);
    expect(button.classList.contains("icon-btn--spinning")).toBe(false);

    button.click();
    expect(refreshSessions).toHaveBeenCalledTimes(2);
  });
});

describe("session filters", () => {
  const rows = (): HTMLElement[] =>
    [...document.querySelectorAll("#session-table-body > tr")] as HTMLElement[];

  async function load(): Promise<void> {
    stubJarvis({
      getHistory: vi.fn(async () => [
        makeSession({ id: "a", summary: "fetch all my bugs", lastActivityAt: 100 }),
        makeSession({ id: "b", summary: "add a cluster tab", lastActivityAt: 300 }),
      ]),
    });
    const { renderSessionTable, wireSessionView } = await import("./session-view.js");
    wireSessionView();
    await renderSessionTable();
  }

  it("narrows the table as the search box is typed into", async () => {
    await load();
    expect(rows()).toHaveLength(2);

    const search = document.getElementById("session-search") as HTMLInputElement;
    search.value = "cluster";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain("cluster");
  });

  it("counts what is shown against the total once filtered", async () => {
    await load();
    expect(document.getElementById("session-count")?.textContent).toBe("2 sessions");

    const search = document.getElementById("session-search") as HTMLInputElement;
    search.value = "cluster";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    expect(document.getElementById("session-count")?.textContent).toBe("1 of 2");
  });

  // An empty table has two very different causes and the reader deserves to
  // know which one they are looking at.
  it("distinguishes no sessions from no matches", async () => {
    await load();
    const search = document.getElementById("session-search") as HTMLInputElement;
    search.value = "nothing matches this";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    expect(document.getElementById("session-table")?.textContent).toMatch(/no sessions match/i);
  });

  it("reverses the order when the sorted column is clicked again", async () => {
    await load();
    expect(rows()[0]?.textContent).toContain("cluster");

    (
      document.querySelector('#session-table th[data-sort="lastActivityAt"]') as HTMLElement
    ).click();

    expect(rows()[0]?.textContent).toContain("bugs");
  });

  // The header describes an open session; over the table it described
  // nothing and rendered as an empty chip beside the title.
  it("hides the open-session header while the table is showing", async () => {
    await load();
    expect(document.getElementById("session-detail")?.hidden).toBe(true);

    const { openSession } = await import("./session-view.js");
    await openSession(makeSession());
    expect(document.getElementById("session-detail")?.hidden).toBe(false);
  });
});
