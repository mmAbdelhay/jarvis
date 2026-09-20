// @vitest-environment jsdom
//
// renderListening/renderNotice are pure DOM manipulation over the
// #voice-state element, so — like defaultSpeechRunner/defaultRecorderDeps —
// they're cheap to exercise directly rather than leaving them
// inspection-only. app.ts registers its `window.jarvis.on*` callbacks as a
// side effect of being imported, so each test re-mocks `window.jarvis`,
// lays down the minimal DOM app.ts's module-top-level code touches
// (#composer/#composer-send so wireComposer doesn't throw, #clock-time in
// its .clock container so startClock has somewhere to write, #voice-state),
// and re-imports the module fresh via vi.resetModules().
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Session, SessionChanges, SessionOutput, SystemMetrics } from "@jarvis/core";
import type { VoiceNotice } from "../src/ipc.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { FakeFitAddon, FakeTerminal } from "./terminal-double.js";

// app.ts pulls in session-view.ts, which hosts a real terminal emulator.
// jsdom has neither a canvas nor real character metrics, so the vendored
// xterm modules are doubled here the same way session-view.test.ts does it.
vi.mock("./vendor/xterm.mjs", () => ({ Terminal: FakeTerminal }));
vi.mock("./vendor/addon-fit.mjs", () => ({ FitAddon: FakeFitAddon }));

type Callbacks = {
  onMetrics?: (metrics: SystemMetrics) => void;
  onTurn?: (turn: { role: string; text: string; language: string; at: number }) => void;
  onSpeaking?: (speaking: boolean) => void;
  onListening?: (listening: boolean) => void;
  onNotice?: (notice: VoiceNotice) => void;
  onSessions?: (sessions: Session[]) => void;
  onChangeCounts?: (changes: SessionChanges[]) => void;
  onSessionOutput?: (output: SessionOutput) => void;
};

async function loadApp(
  getHistory: () => Promise<Session[]> = async () => [],
  gitChanges: (sessionId: string) => Promise<unknown> = async () => ({
    ok: false,
    text: "not stubbed in this test",
    language: "en",
  }),
  getSessionLog: (sessionId: string) => Promise<string> = async () => "",
): Promise<Callbacks> {
  vi.resetModules();
  FakeTerminal.last = undefined;
  document.body.innerHTML = `
    <div class="clock"><span id="clock-time"></span></div>
    <input id="composer" />
    <button id="composer-send"></button>
    <span id="voice-state">placeholder</span>
    <button id="running-pill">
      <span id="running-orbs"></span>
      <span id="running-count"></span>
    </button>
    <button id="mic-button"></button>
    <span id="cpu-value"></span>
    <div id="cpu-bar"></div>
    <span id="mem-value"></span>
    <span id="mem-detail"></span>
    <div id="mem-bar"></div>
    <span id="disk-value"></span>
    <span id="disk-total"></span>
    <div id="disk-bar"></div>
    <span id="uptime-value"></span>
    <span id="temp-value"></span>
    <div id="temp-note" hidden></div>
    <span id="net-down"></span>
    <span id="net-up"></span>
    <span id="topbar-danger-dot" hidden></span>
    <div id="conversation"></div>
    <section id="presence" class="presence presence--idle"></section>
    <div id="presence-state"></div>
    <div id="presence-hint"></div>
    <div id="project-label"></div>
    <div id="project-count"></div>
    <label id="project-filter-label" for="project-filter"></label>
    <input id="project-filter" />
    <div id="project-summary"></div>
    <div id="agent-orbits"></div>
    <div id="project-grid"></div>
    <div id="sessions-summary"></div>
    <button id="dashboard-sessions-refresh" type="button"></button>
    <button id="all-sessions-link" type="button"></button>
    <div id="centre-body"></div>
    <button id="history-button"></button>
    <button id="history-close"></button>
    <div id="history-overlay" hidden></div>
    <span id="history-count"></span>
    <div id="history-list"></div>
    <div class="main"></div>
    <div class="main main--changes" id="view-changes" hidden>
      <div id="changes-project"></div>
      <div id="changes-path"></div>
      <div id="changes-branch"></div>
      <div id="changes-add" dir="ltr"></div>
      <div id="changes-del" dir="ltr"></div>
      <div id="changes-by"></div>
      <div id="changes-stale-notice" hidden></div>
      <div id="changes-error" hidden></div>
      <div id="changes-count"></div>
      <div id="changes-file-list"></div>
      <div id="diff-filename"></div>
      <div id="diff-body"></div>
      <input id="commit-message" type="text" />
      <button id="commit-button" type="button"></button>
    </div>
    <button id="nav-dashboard" class="nav-btn nav-btn--on" type="button"></button>
    <button id="nav-changes" class="nav-btn" type="button"></button>
    <button id="nav-settings" class="nav-btn" type="button"></button>
    <button id="remote-pill" class="pill pill--remote" type="button" hidden>
      <span id="remote-pill-text"></span>
    </button>
    <div id="remote-confirm" hidden>
      <div id="remote-confirm-title"></div>
      <div id="remote-confirm-body"></div>
      <button id="remote-confirm-approve" type="button"></button>
      <button id="remote-confirm-deny" type="button"></button>
    </div>
    <button id="nav-session" class="nav-btn" type="button"></button>
    <div class="main main--session" id="view-session" hidden>
      <div id="session-view-project"></div>
      <div id="session-view-path"></div>
      <div id="session-view-state"></div>
      <div id="session-view-agent"></div>
      <div id="session-voice" hidden></div>
      <button id="session-resume" hidden></button>
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
  `;

  const callbacks: Callbacks = {};
  (window as unknown as { jarvis: Record<string, unknown> }).jarvis = {
    send: vi.fn(async () => {}),
    startVoice: vi.fn(async () => {}),
    stopVoice: vi.fn(async () => {}),
    onMetrics: (cb: (metrics: SystemMetrics) => void) => {
      callbacks.onMetrics = cb;
    },
    onProviders: vi.fn(),
    onWorkspace: vi.fn(),
    // The Dashboard's centre lists these when nothing is running, so the
    // harness has to name some.
    getProjects: vi.fn(async () => ["acme", "storefront"]),
    // What a project row's buttons call.
    openEditor: vi.fn(async () => ({ ok: true, value: "" })),
    openTerminal: vi.fn(async () => ({ ok: true, value: undefined })),
    openApiTab: vi.fn(async () => ({ ok: true, value: undefined })),
    openTab: vi.fn(async () => undefined),
    openDockerTab: vi.fn(async () => ({ ok: true, value: undefined })),
    onSessions: (cb: (sessions: Session[]) => void) => {
      callbacks.onSessions = cb;
    },
    onChangeCounts: (cb: (changes: SessionChanges[]) => void) => {
      callbacks.onChangeCounts = cb;
    },
    onTurn: (cb: (turn: { role: string; text: string; language: string; at: number }) => void) => {
      callbacks.onTurn = cb;
    },
    onSessionOutput: (cb: (output: SessionOutput) => void) => {
      callbacks.onSessionOutput = cb;
    },
    getSessionLog: vi.fn(getSessionLog),
    sendSessionInput: vi.fn(async () => {}),
    resizeSession: vi.fn(async () => {}),
    setVoiceTarget: vi.fn(async () => {}),
    onSpeaking: (cb: (speaking: boolean) => void) => {
      callbacks.onSpeaking = cb;
    },
    onListening: (cb: (listening: boolean) => void) => {
      callbacks.onListening = cb;
    },
    onNotice: (cb: (notice: VoiceNotice) => void) => {
      callbacks.onNotice = cb;
    },
    getHistory: vi.fn(getHistory),
    listSessions: vi.fn(async () => [] as Session[]),
    refreshSessions: vi.fn(async () => ({ jarvis: 0, external: 0, importedTranscripts: 0 })),
    setWorkspaceVisible: vi.fn(async () => {}),
    gitChanges: vi.fn(gitChanges),
    gitDiff: vi.fn(async () => ({ ok: false, text: "not stubbed", language: "en" })),
    gitSetStaged: vi.fn(async () => ({ ok: false, text: "not stubbed", language: "en" })),
    gitCommit: vi.fn(async () => ({ ok: false, text: "not stubbed", language: "en" })),
    remoteStatus: vi.fn(async () => ({
      enabled: false,
      listening: undefined,
      pairing: { kind: "closed" },
      devices: [],
      problem: undefined,
    })),
    openRemotePairing: vi.fn(async () => ({ ok: true, value: undefined })),
    cancelRemotePairing: vi.fn(async () => {}),
    decideRemotePairing: vi.fn(async () => {}),
    revokeRemoteDevice: vi.fn(async () => ({ ok: true, value: undefined })),
    onRemoteStatus: vi.fn(),
  };

  await import("./app.js");
  return callbacks;
}

function jarvisApi(): {
  startVoice: ReturnType<typeof vi.fn>;
  stopVoice: ReturnType<typeof vi.fn>;
} {
  return (
    window as unknown as {
      jarvis: { startVoice: ReturnType<typeof vi.fn>; stopVoice: ReturnType<typeof vi.fn> };
    }
  ).jarvis;
}

function micButtonEl(): HTMLElement {
  const el = document.getElementById("mic-button");
  if (el === null) throw new Error("Missing #mic-button");
  return el;
}

function voiceStateEl(): HTMLElement {
  const el = document.getElementById("voice-state");
  if (el === null) throw new Error("Missing #voice-state");
  return el;
}

describe("voice-state rendering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a listening indicator while recording", async () => {
    const { onListening } = await loadApp();
    onListening?.(true);

    const el = voiceStateEl();
    expect(el.textContent).toBe("Listening…");
    expect(el.dir).toBe("ltr");
    expect(el.classList.contains("arabic")).toBe(false);
  });

  it("reverts to the idle hint naming both shortcuts when recording stops", async () => {
    const { onListening } = await loadApp();
    onListening?.(true);
    onListening?.(false);

    const text = voiceStateEl().textContent ?? "";
    expect(text).toContain("⌥Space");
    expect(text).toContain("⌥⇧Space");
    expect(text).not.toMatch(/hold/i);
  });

  it("shows a transient notice on silence and then reverts to the idle hint", async () => {
    const { onNotice } = await loadApp();
    onNotice?.({ text: "Didn't catch that", language: "en" });

    expect(voiceStateEl().textContent).toBe("Didn't catch that");

    vi.advanceTimersByTime(10_000);
    expect(voiceStateEl().textContent).toContain("⌥Space");
  });

  it("renders an Arabic notice right-to-left with the arabic class, and clears both on revert", async () => {
    const { onNotice } = await loadApp();
    onNotice?.({ text: "لم يُسمع شيء", language: "ar" });

    const el = voiceStateEl();
    expect(el.textContent).toBe("لم يُسمع شيء");
    expect(el.dir).toBe("rtl");
    expect(el.classList.contains("arabic")).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(el.dir).toBe("ltr");
    expect(el.classList.contains("arabic")).toBe(false);
  });

  it("a listening-state change preempts a pending notice instead of the notice reverting over it later", async () => {
    const { onNotice, onListening } = await loadApp();
    onNotice?.({ text: "Didn't catch that", language: "en" });
    onListening?.(true);

    expect(voiceStateEl().textContent).toBe("Listening…");

    // The superseded notice's own revert timer must not still be pending
    // and overwrite "Listening…" later.
    vi.advanceTimersByTime(10_000);
    expect(voiceStateEl().textContent).toBe("Listening…");
  });
});

// M-b: the mic button must drive the exact same start/stop path as the
// global hotkey, never a second unwired "click to talk" affordance.
describe("mic button", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls startVoice when clicked while idle", async () => {
    await loadApp();
    micButtonEl().click();
    expect(jarvisApi().startVoice).toHaveBeenCalledTimes(1);
    expect(jarvisApi().stopVoice).not.toHaveBeenCalled();
  });

  it("calls stopVoice when clicked while listening", async () => {
    const { onListening } = await loadApp();
    onListening?.(true);
    micButtonEl().click();
    expect(jarvisApi().stopVoice).toHaveBeenCalledTimes(1);
    expect(jarvisApi().startVoice).not.toHaveBeenCalled();
  });

  it("marks the mic button active while listening and clears it when stopped", async () => {
    const { onListening } = await loadApp();
    onListening?.(true);
    expect(micButtonEl().classList.contains("voice-btn--active")).toBe(true);

    onListening?.(false);
    expect(micButtonEl().classList.contains("voice-btn--active")).toBe(false);
  });
});

// initRemoteStatus is wired at startup exactly like initSettings — inside
// its own try/catch, so a harness missing its markup (most of the tests
// above) never breaks the rest of wireNav(). This harness lays the markup
// down instead, to prove the wiring itself actually happens.
describe("remote status wiring", () => {
  it("pulls remoteStatus() and subscribes onRemoteStatus at startup", async () => {
    await loadApp();
    const api = window.jarvis as unknown as {
      remoteStatus: ReturnType<typeof vi.fn>;
      onRemoteStatus: ReturnType<typeof vi.fn>;
    };
    expect(api.remoteStatus).toHaveBeenCalledTimes(1);
    expect(api.onRemoteStatus).toHaveBeenCalledTimes(1);
  });

  it("clicking the remote pill clicks the Settings nav button", async () => {
    await loadApp();
    // Let the initial remoteStatus() promise settle before asserting.
    await Promise.resolve();
    await Promise.resolve();

    // Stubbed rather than left real: the real nav-settings listener drives
    // openSettings(), which needs the whole Settings route's markup this
    // harness does not lay down — out of scope for what this test checks,
    // which is only that the pill forwards its click.
    const navSettings = document.getElementById("nav-settings") as HTMLButtonElement;
    navSettings.click = vi.fn();
    (document.getElementById("remote-pill") as HTMLButtonElement).click();
    expect(navSettings.click).toHaveBeenCalledTimes(1);
  });
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    project: "acme",
    projectPath: "/p/acme",
    agentId: "claude-main",
    state: "running",
    summary: "",
    startedAt: 1000,
    lastActivityAt: 1000,
    ...overrides,
  };
}

// Critical: the overlay must actually hide/show — see
// history-overlay-css.test.ts for the CSS-cascade half of this fix (an
// author `display: flex` on
// `.history-overlay` itself would out-cascade the UA `[hidden]{display:
// none}` rule regardless of what the click handlers below do to the
// attribute). This describe block proves the *other* half: that
// wireHistoryPanel's click handlers actually flip `overlay.hidden`, the
// one mechanism the CSS fix depends on. jsdom's own `getComputedStyle`
// does not reproduce the cascade-origin bug the CSS fix addresses (it
// special-cases `hidden` outside the normal cascade), so this test
// intentionally does not assert computed `display` — only the `hidden`
// property, which is the actual mechanism `wireHistoryPanel` controls.
describe("history panel", () => {
  function overlayEl(): HTMLElement & { hidden: boolean } {
    const el = document.getElementById("history-overlay");
    if (el === null) throw new Error("Missing #history-overlay");
    return el as HTMLElement & { hidden: boolean };
  }

  it("is hidden before the history button is ever clicked", async () => {
    await loadApp();
    expect(overlayEl().hidden).toBe(true);
  });

  it("un-hides on click and loads history", async () => {
    const getHistory = vi.fn(async () => [makeSession({ id: "past", project: "acme" })]);
    await loadApp(getHistory);

    document.getElementById("history-button")?.click();
    expect(overlayEl().hidden).toBe(false);
    expect(getHistory).toHaveBeenCalledTimes(1);

    // Flush the getHistory() promise's .then().
    await Promise.resolve();
    await Promise.resolve();

    const list = document.getElementById("history-list");
    expect(list?.querySelector(".session__project")?.textContent).toBe("acme");
  });

  it("re-hides on the close button", async () => {
    await loadApp(async () => []);
    document.getElementById("history-button")?.click();
    expect(overlayEl().hidden).toBe(false);

    document.getElementById("history-close")?.click();
    expect(overlayEl().hidden).toBe(true);
  });

  it("hides the native browser while History is open and restores it on close", async () => {
    await loadApp(async () => []);
    const { showView } = await import("./views.js");
    const visible = window.jarvis.setWorkspaceVisible as ReturnType<typeof vi.fn>;
    showView("workspace");
    visible.mockClear();

    document.getElementById("history-button")?.click();
    expect(visible).toHaveBeenLastCalledWith(false);
    document.getElementById("history-close")?.click();
    expect(visible).toHaveBeenLastCalledWith(true);
  });

  it("stays open on a click inside the panel, and closes only on a click on the scrim itself", async () => {
    await loadApp(async () => []);
    document.getElementById("history-button")?.click();
    expect(overlayEl().hidden).toBe(false);

    const child = document.createElement("div");
    overlayEl().append(child);
    child.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(overlayEl().hidden).toBe(false);

    // A click whose target is the overlay element itself (the scrim, not
    // a descendant) closes it.
    overlayEl().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(overlayEl().hidden).toBe(true);
  });

  // I1: buildSessionRow's click handler (shared with the live Sessions
  // panel) calls openChanges(), which renders the Changes view — but
  // nothing closed this full-screen overlay first, so the view rendered
  // underneath the scrim and the click appeared to do nothing.
  // I1: whichever view a row opens, it renders *underneath* this
  // full-screen overlay unless the overlay is closed first — the click
  // then looks like it did nothing. A row now opens the Session
  // transcript rather than the Changes view, so this checks the same
  // scrim invariant against the new destination.
  it("closes on clicking a history row, so the view underneath is not hidden by the scrim", async () => {
    const getSessionLog = vi.fn(async () => "resumed output\n");
    await loadApp(
      async () => [makeSession({ id: "past", endedAt: 5000 })],
      undefined,
      getSessionLog,
    );

    document.getElementById("history-button")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(overlayEl().hidden).toBe(false);

    const row = document.querySelector<HTMLElement>("#history-list .session");
    expect(row).not.toBeNull();
    row?.click();

    expect(overlayEl().hidden).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(getSessionLog).toHaveBeenCalledWith("past");
    expect(document.getElementById("view-session")?.hidden).toBe(false);
    expect(FakeTerminal.last?.text).toBe("resumed output\n");
  });

  // What this pins is the CALL SITE's wiring — that the badge is built by
  // sessionsCount() at the app's configured primary language — not the
  // strings themselves, which messages.test.ts already covers in both
  // languages (including MSA's counted-noun forms). Asserting through
  // MESSAGES rather than a hardcoded literal is what keeps it that way:
  // PRIMARY_LANGUAGE flipped to English at the user's request, and a test
  // that hardcoded the Arabic output would have failed for the wiring
  // being right.
  it("builds the singular badge through sessionsCount at PRIMARY_LANGUAGE", async () => {
    await loadApp(async () => [makeSession()]);
    document.getElementById("history-button")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById("history-count")?.textContent).toBe(
      MESSAGES.sessionsCount(1, PRIMARY_LANGUAGE),
    );
  });

  it("builds the zero badge through sessionsCount at PRIMARY_LANGUAGE", async () => {
    await loadApp(async () => []);
    document.getElementById("history-button")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.getElementById("history-count")?.textContent).toBe(
      MESSAGES.sessionsCount(0, PRIMARY_LANGUAGE),
    );
  });
});

// Spec shortfall: buildSessionRow applied dir/`.arabic` to session__summary
// but not session__project — closed for both the live Sessions panel
// (exercised here via onSessions) and the History panel (which reuses the
// same buildSessionRow).
describe("Arabic project names", () => {
  it("renders an Arabic project name right-to-left with the arabic class in the live Sessions panel", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([makeSession({ project: "متجر أكمي" })]);

    const project = document.querySelector("#centre-body .session__project");
    expect(project).not.toBeNull();
    expect(project?.textContent).toBe("متجر أكمي");
    expect((project as HTMLElement).dir).toBe("rtl");
    expect(project?.classList.contains("arabic")).toBe(true);
  });

  it("renders an English project name left-to-right with no arabic class", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([makeSession({ project: "acme" })]);

    const project = document.querySelector("#centre-body .session__project");
    expect((project as HTMLElement).dir).toBe("ltr");
    expect(project?.classList.contains("arabic")).toBe(false);
  });
});

function makeChanges(overrides: Partial<SessionChanges> = {}): SessionChanges {
  return {
    sessionId: "s1",
    project: "acme",
    repoPath: "/p/acme",
    branch: "main",
    detached: false,
    files: 7,
    insertions: 128,
    deletions: 34,
    ...overrides,
  };
}

describe("session change-count badges", () => {
  it("puts insertion and deletion counts on the session row that owns them", async () => {
    const { onSessions, onChangeCounts } = await loadApp();

    onSessions?.([makeSession({ id: "s1", project: "acme" })]);
    onChangeCounts?.([makeChanges({ sessionId: "s1" })]);

    const row = document.querySelector(".session");
    expect(row?.textContent).toContain("+128");
    // U+2212 minus sign, matching the artboard's "−34" — not an ASCII hyphen.
    expect(row?.textContent).toContain("−34");
  });

  it("shows no counts for a session with no known changes", async () => {
    const { onSessions, onChangeCounts } = await loadApp();
    onSessions?.([makeSession({ id: "s2", project: "storefront" })]);
    onChangeCounts?.([]);

    expect(document.querySelector(".session__diff")).toBeNull();
  });

  it("renders no badge for a session that has no entry in the counts snapshot at all", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([makeSession({ id: "s3" })]);

    expect(document.querySelector(".session__diff")).toBeNull();
  });

  it("does not render a +0 −0 badge for a session whose changes are all zero", async () => {
    const { onSessions, onChangeCounts } = await loadApp();
    onSessions?.([makeSession({ id: "s1" })]);
    onChangeCounts?.([makeChanges({ sessionId: "s1", files: 0, insertions: 0, deletions: 0 })]);

    expect(document.querySelector(".session__diff")).toBeNull();
  });

  it("renders a badge when only one side is non-zero (insertions only)", async () => {
    const { onSessions, onChangeCounts } = await loadApp();
    onSessions?.([makeSession({ id: "s1" })]);
    onChangeCounts?.([makeChanges({ sessionId: "s1", insertions: 8, deletions: 0 })]);

    const row = document.querySelector(".session");
    expect(row?.textContent).toContain("+8");
    expect(row?.textContent).toContain("−0");
  });

  // The tracker refreshes on its own interval, independent of session
  // updates, so counts can land on either channel first. Both must
  // eventually paint the same row.
  it("renders the badge once the session row appears, even if counts arrived first", async () => {
    const { onSessions, onChangeCounts } = await loadApp();

    onChangeCounts?.([makeChanges({ sessionId: "s1" })]);
    expect(document.querySelector(".session__diff")).toBeNull();

    onSessions?.([makeSession({ id: "s1" })]);
    expect(document.querySelector(".session__diff")).not.toBeNull();
  });

  it("keeps showing a session's counts across a re-render triggered by the other channel", async () => {
    const { onSessions, onChangeCounts } = await loadApp();

    onSessions?.([makeSession({ id: "s1", state: "running" })]);
    onChangeCounts?.([makeChanges({ sessionId: "s1" })]);
    expect(document.querySelector(".session__diff")).not.toBeNull();

    // A session state change re-renders the row from `latestSessions` alone;
    // the counts map must not be forgotten.
    onSessions?.([makeSession({ id: "s1", state: "waiting" })]);
    const row = document.querySelector(".session");
    expect(row?.textContent).toContain("+128");
  });

  it("drops the badge once a session that ended is no longer in either snapshot", async () => {
    const { onSessions, onChangeCounts } = await loadApp();

    onSessions?.([makeSession({ id: "s1" })]);
    onChangeCounts?.([makeChanges({ sessionId: "s1" })]);
    expect(document.querySelector(".session__diff")).not.toBeNull();

    // The session ends: SessionManager drops it from the live list, and the
    // tracker's next refresh (it only walks live sessions) stops including
    // it in the snapshot it broadcasts.
    onSessions?.([]);
    onChangeCounts?.([]);
    expect(document.querySelector(".session__diff")).toBeNull();
  });

  it("renders very large counts without breaking the row's layout classes", async () => {
    const { onSessions, onChangeCounts } = await loadApp();
    onSessions?.([makeSession({ id: "s1" })]);
    onChangeCounts?.([makeChanges({ sessionId: "s1", insertions: 128_734, deletions: 40_921 })]);

    const row = document.querySelector(".session");
    expect(row?.textContent).toContain("+128734");
    expect(row?.textContent).toContain("−40921");
    expect(document.querySelectorAll(".session__diff").length).toBe(1);
  });

  // buildSessionRow is shared by the live panel and the History panel
  // (Arabic project names test above pins the same sharing for dir/.arabic).
  // A past session keeps the same id it had while live, so if the counts
  // snapshot has not yet dropped that id, `latestChanges` can still hold a
  // live-looking entry for it. Ruling P21: a finished session must never
  // show a live change count — that would be a lie about it, since counts
  // are only ever fed by the live "git:counts" stream. Gated on
  // `endedAt === undefined`, so a history row renders no badge at all,
  // regardless of what the stale snapshot still holds.
  it("never shows a live change count on a past session, even with a stale entry still in the snapshot", async () => {
    const past = makeSession({ id: "s1", project: "acme", endedAt: 5000 });
    const { onChangeCounts } = await loadApp(async () => [past]);
    onChangeCounts?.([makeChanges({ sessionId: "s1" })]);

    document.getElementById("history-button")?.click();
    await Promise.resolve();
    await Promise.resolve();

    const row = document.querySelector("#history-list .session");
    expect(row?.querySelector(".session__diff")).toBeNull();
    expect(row?.textContent).not.toContain("+128");
  });
});

// C2(b): a past session's badge comes only from its own *recorded* counts
// (SessionStore.updateGit, frozen at end), never the live tracker snapshot
// — which the test above already pins is ignored for a past session. These
// pin the recorded-count consumer itself, and the "recorded zero" vs
// "never recorded" distinction the review calls out by name (P21).
describe("history row recorded change-count badge", () => {
  it("shows a past session's own recorded counts, not a live snapshot's", async () => {
    const past = makeSession({
      id: "s1",
      endedAt: 5000,
      branch: "feat/checkout-retry",
      insertions: 12,
      deletions: 3,
      changedFiles: 2,
    });
    const { onChangeCounts } = await loadApp(async () => [past]);
    // A live entry for the same id, e.g. from a different session that
    // later reused the same repo — must never leak into the past row.
    onChangeCounts?.([makeChanges({ sessionId: "s1", insertions: 999, deletions: 999 })]);

    document.getElementById("history-button")?.click();
    await Promise.resolve();
    await Promise.resolve();

    const row = document.querySelector("#history-list .session");
    expect(row?.textContent).toContain("+12");
    expect(row?.textContent).toContain("−3");
    expect(row?.textContent).not.toContain("999");
  });

  it("renders a visible '+0 −0' badge for a session that recorded genuinely zero changes", async () => {
    const past = makeSession({
      id: "s1",
      endedAt: 5000,
      branch: "main",
      insertions: 0,
      deletions: 0,
      changedFiles: 0,
    });
    await loadApp(async () => [past]);

    document.getElementById("history-button")?.click();
    await Promise.resolve();
    await Promise.resolve();

    const row = document.querySelector("#history-list .session");
    const badge = row?.querySelector(".session__diff");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("+0 −0");
  });

  it("renders no badge at all for a session nothing was ever recorded for, distinct from a recorded zero", async () => {
    const past = makeSession({ id: "s1", endedAt: 5000, branch: "" });
    await loadApp(async () => [past]);

    document.getElementById("history-button")?.click();
    await Promise.resolve();
    await Promise.resolve();

    const row = document.querySelector("#history-list .session");
    expect(row?.querySelector(".session__diff")).toBeNull();
  });
});

// The user's report that started this: "when i start a session it's not
// opening it so i can see it". Starting a session is an explicit request to
// watch it work, so its transcript opens by itself — but only for a
// genuinely new session, never on a state change or a git-count update,
// which would yank the view away mid-read.
describe("opening a session", () => {
  it("opens the transcript of a newly started session", async () => {
    const getSessionLog = vi.fn(async () => "booting…\n");
    const { onSessions } = await loadApp(undefined, undefined, getSessionLog);

    // First update after launch: nothing to auto-open yet.
    onSessions?.([]);
    await Promise.resolve();
    onSessions?.([makeSession({ id: "fresh" })]);
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById("view-session")?.hidden).toBe(false);
    expect(getSessionLog).toHaveBeenCalledWith("fresh");
    expect(FakeTerminal.last?.text).toBe("booting…\n");
  });

  // The bug this fixes: since sessions:refresh + process discovery and the
  // transcript backfill, the very first sessions:update after launch already
  // carries rows — the process scan's and the backfill's, not anything the
  // user just started. Auto-opening the newest of them landed the app on the
  // Session view instead of the Dashboard at startup.
  it("does not auto-open anything from the first sessions:update after launch", async () => {
    const getSessionLog = vi.fn(async () => "");
    const { onSessions } = await loadApp(undefined, undefined, getSessionLog);

    onSessions?.([makeSession({ id: "already-running", startedAt: 1000 })]);
    await Promise.resolve();
    await Promise.resolve();

    expect(getSessionLog).not.toHaveBeenCalled();
    expect(document.getElementById("view-session")?.hidden).not.toBe(false);
  });

  // Rows found by the process scan (`origin: "external"`, ids `ext-<pid>`)
  // were discovered, not started by the user — they must never steal the
  // view even when they are genuinely new after the first update.
  it("does not auto-open an externally-discovered session", async () => {
    const getSessionLog = vi.fn(async () => "");
    const { onSessions } = await loadApp(undefined, undefined, getSessionLog);

    onSessions?.([]);
    await Promise.resolve();
    onSessions?.([makeSession({ id: "ext-123", origin: "external" })]);
    await Promise.resolve();
    await Promise.resolve();

    expect(getSessionLog).not.toHaveBeenCalled();
  });

  it("does not reopen the view when an already-known session merely changes state", async () => {
    const getSessionLog = vi.fn(async () => "");
    const { onSessions } = await loadApp(undefined, undefined, getSessionLog);

    // First update after launch: nothing to auto-open yet.
    onSessions?.([]);
    await Promise.resolve();
    onSessions?.([makeSession({ id: "s1", state: "starting" })]);
    await Promise.resolve();
    await Promise.resolve();
    expect(getSessionLog).toHaveBeenCalledTimes(1);

    onSessions?.([makeSession({ id: "s1", state: "running" })]);
    await Promise.resolve();

    expect(getSessionLog).toHaveBeenCalledTimes(1);
    // The header still tracks the session it is showing.
    expect(document.getElementById("session-view-state")?.textContent).toBe("running");
  });

  it("opens the most recently started one when several appear at once", async () => {
    const getSessionLog = vi.fn(async () => "");
    const { onSessions } = await loadApp(undefined, undefined, getSessionLog);

    // First update after launch: nothing to auto-open yet.
    onSessions?.([]);
    await Promise.resolve();
    onSessions?.([
      makeSession({ id: "older", startedAt: 1000 }),
      makeSession({ id: "newer", startedAt: 2000 }),
    ]);
    await Promise.resolve();

    expect(getSessionLog).toHaveBeenCalledTimes(1);
    expect(getSessionLog).toHaveBeenCalledWith("newer");
  });

  it("opens a session's transcript when its row is clicked", async () => {
    const getSessionLog = vi.fn(async () => "row click\n");
    const { onSessions, onChangeCounts } = await loadApp(undefined, undefined, getSessionLog);

    onSessions?.([makeSession({ id: "s1" })]);
    await Promise.resolve();
    await Promise.resolve();
    getSessionLog.mockClear();
    onChangeCounts?.([]);

    document.querySelector<HTMLElement>("#centre-body .session")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(getSessionLog).toHaveBeenCalledWith("s1");
    expect(document.getElementById("view-session")?.hidden).toBe(false);
  });

  // The row opens the transcript, so the diff badge is what keeps the
  // Changes view one click away. Without stopPropagation the row's own
  // handler fires straight after and replaces the diff with the transcript.
  it("opens the Changes view from the diff badge, not the transcript", async () => {
    const gitChanges = vi.fn(async () => ({
      ok: true,
      value: {
        session: {
          id: "s1",
          project: "acme",
          projectPath: "/p",
          agentId: "claude-main",
          lastActivityAt: 1000,
          endedAt: undefined,
        },
        changes: {
          repoPath: "/p",
          branch: "main",
          detached: false,
          files: [],
          insertions: 3,
          deletions: 1,
        },
      },
    }));
    const { onSessions, onChangeCounts } = await loadApp(undefined, gitChanges);

    onSessions?.([makeSession({ id: "s1" })]);
    onChangeCounts?.([
      {
        sessionId: "s1",
        project: "acme",
        repoPath: "/p",
        branch: "main",
        detached: false,
        files: 1,
        insertions: 3,
        deletions: 1,
      },
    ]);
    await Promise.resolve();
    await Promise.resolve();

    const badge = document.querySelector<HTMLElement>("#centre-body .session__diff");
    expect(badge).not.toBeNull();
    badge?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(gitChanges).toHaveBeenCalledWith("s1");
    expect(document.getElementById("view-changes")?.hidden).toBe(false);
    expect(document.getElementById("view-session")?.hidden).toBe(true);
  });

  it("streams later output into the open transcript", async () => {
    const { onSessions, onSessionOutput } = await loadApp(undefined, undefined, async () => "");

    // First update after launch: nothing to auto-open yet.
    onSessions?.([]);
    await Promise.resolve();
    onSessions?.([makeSession({ id: "s1" })]);
    await Promise.resolve();
    await Promise.resolve();
    onSessionOutput?.({ sessionId: "s1", chunk: "live line\n", offset: 0 });

    expect(FakeTerminal.last?.text).toBe("live line\n");
  });
});

/** Lets the getProjects promise and its render settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

// board 0 removed CPU/RAM/DISK/network from the topbar entirely — the
// Dashboard SYSTEM card (#disk-value, #disk-bar, #net-down, #net-up) is now
// the only place they render, and the topbar carries only a danger dot, lit
// when the machine is genuinely in trouble. See app.ts's renderMetrics.
describe("the Dashboard SYSTEM card and the topbar's danger dot", () => {
  const metrics = (over: Partial<SystemMetrics> = {}): SystemMetrics => ({
    cpuPercent: 10,
    memoryUsedBytes: 1,
    memoryTotalBytes: 10,
    diskUsedBytes: 1,
    diskTotalBytes: 10,
    networkDownMbps: 0,
    networkUpMbps: 0,
    uptimeSeconds: 0,
    ...over,
  });

  it("marks a disk at or above 95% critical and lights the topbar dot", async () => {
    const { onMetrics } = await loadApp();

    onMetrics?.(metrics({ diskUsedBytes: 95, diskTotalBytes: 100 }));

    expect(document.getElementById("disk-value")?.className).toContain("crit");
    expect(document.getElementById("disk-bar")?.className).toContain("fill--crit");
    const dot = document.getElementById("topbar-danger-dot");
    expect(dot?.hidden).toBe(false);
    expect(dot?.title).toContain("disk");
  });

  // Review of 186389a (Important 1): the sensor note must show when there is
  // no reading and fold away once one arrives — never stay hidden for good.
  it("shows the no-sensor note without a temperature and hides it with one", async () => {
    const { onMetrics } = await loadApp();

    onMetrics?.(metrics({ cpuTemperatureC: undefined }));
    const note = document.getElementById("temp-note");
    expect(note?.hidden).toBe(false);
    expect(note?.textContent).toContain("temperature sensor");
    expect(document.getElementById("temp-value")?.textContent).toBe("");

    onMetrics?.(metrics({ cpuTemperatureC: 52 }));
    expect(note?.hidden).toBe(true);
    expect(document.getElementById("temp-value")?.textContent).toBe("52°");
  });

  it("warns from 85% until critical, without lighting the danger dot", async () => {
    const { onMetrics } = await loadApp();

    onMetrics?.(metrics({ diskUsedBytes: 85, diskTotalBytes: 100 }));

    const disk = document.getElementById("disk-value");
    expect(disk?.className).toContain("warn");
    expect(disk?.className).not.toContain("crit");
    expect(document.getElementById("topbar-danger-dot")?.hidden).toBe(true);
  });

  it("says nothing about a machine that is fine", async () => {
    const { onMetrics } = await loadApp();

    onMetrics?.(metrics({ diskUsedBytes: 12, diskTotalBytes: 100 }));

    const disk = document.getElementById("disk-value");
    expect(disk?.textContent).toBe("12%");
    expect(disk?.className).toBe("");
    expect(document.getElementById("topbar-danger-dot")?.hidden).toBe(true);
  });

  it("names CPU when it is the reading that is critical", async () => {
    const { onMetrics } = await loadApp();

    onMetrics?.(metrics({ cpuPercent: 96 }));

    const dot = document.getElementById("topbar-danger-dot");
    expect(dot?.hidden).toBe(false);
    expect(dot?.title).toContain("CPU");
    expect(dot?.title).not.toContain("disk");
  });

  it("always renders network throughput on the SYSTEM card", async () => {
    const { onMetrics } = await loadApp();

    onMetrics?.(metrics({ networkDownMbps: 0.3, networkUpMbps: 1.2 }));

    expect(document.getElementById("net-down")?.textContent).toBe("↓0.3");
    expect(document.getElementById("net-up")?.textContent).toBe("↑1.2");
  });
});

describe("the header clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T18:12:34"));
  });

  afterEach(() => vi.useRealTimers());

  it("renders HH:MM only and moves the full date to the clock title", async () => {
    await loadApp();
    expect(document.getElementById("clock-time")?.textContent).toBe("18:12");
    expect(document.querySelector<HTMLElement>(".clock")?.title).toContain("19 Sept 2026");
    expect(document.getElementById("clock-date")).toBeNull();
  });
});

describe("topbar no-wrap contract", () => {
  it("keeps every direct topbar child on one line", () => {
    const css = readFileSync("packages/desktop/renderer/styles.css", "utf8");
    expect(css).toMatch(/\.topbar\s*>\s*\*\s*\{[^}]*white-space:\s*nowrap/s);
  });
});

describe("the Dashboard's centre", () => {
  // Idle is the state this screen is in most of the time, and it used to be
  // the state it handled worst — an empty middle beneath a decorative orb.
  it("lists the configured projects when nothing is running", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([]);
    await settle();

    expect([...document.querySelectorAll(".node__name")].map((n) => n.textContent)).toEqual([
      "acme",
      "storefront",
    ]);
  });

  // Board 0's second pass keeps both regions on screen always — the old
  // "sessions replace projects the moment one is running" toggle is gone.
  it("keeps both the sessions list and the projects grid on screen once something is running", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([]);
    await settle();

    onSessions?.([makeSession({ id: "s1", project: "acme" })]);

    expect(document.querySelectorAll("#centre-body .session")).toHaveLength(1);
    expect(document.querySelectorAll(".node")).toHaveLength(2);
  });

  it("sorts the projects grid running, then waiting, then idle, each alphabetically", async () => {
    const { onSessions } = await loadApp();
    // "storefront" alone would already sort before "acme"; making it the one
    // that is live proves the sort is by status first, not a fallback to name.
    onSessions?.([makeSession({ id: "s1", project: "storefront", state: "running" })]);
    await settle();

    expect([...document.querySelectorAll(".node__name")].map((n) => n.textContent)).toEqual([
      "storefront",
      "acme",
    ]);
  });

  it("gives a live node the live class and an idle one the idle class", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([makeSession({ id: "s1", project: "acme", state: "running" })]);
    await settle();

    const nodes = [...document.querySelectorAll<HTMLElement>(".node")];
    const acme = nodes.find((n) => n.querySelector(".node__name")?.textContent === "acme");
    const storefront = nodes.find(
      (n) => n.querySelector(".node__name")?.textContent === "storefront",
    );
    expect(acme?.className).toContain("live");
    expect(storefront?.className).toContain("idle");
  });

  it("gives a waiting session's project the waiting class", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([makeSession({ id: "s1", project: "acme", state: "waiting" })]);
    await settle();

    const acme = [...document.querySelectorAll<HTMLElement>(".node")].find(
      (n) => n.querySelector(".node__name")?.textContent === "acme",
    );
    expect(acme?.className).toContain("waiting");
  });

  it("hides a project from the grid once the filter no longer matches its name", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([]);
    await settle();

    const filter = document.getElementById("project-filter") as HTMLInputElement;
    filter.value = "store";
    filter.dispatchEvent(new Event("input", { bubbles: true }));

    expect([...document.querySelectorAll(".node__name")].map((n) => n.textContent)).toEqual([
      "storefront",
    ]);
  });

  it("opens a project's editor, terminal, browser or Docker tab and goes there", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([]);
    await settle();

    // Round 4: the buttons carry no text of their own any more (that used
    // to overflow the card as unbounded label text) — found by aria-label
    // instead, the same string their title carries.
    const actionButton = (label: string): HTMLElement | undefined =>
      [...document.querySelectorAll<HTMLElement>(".node__action")].find(
        (button) => button.getAttribute("aria-label") === label,
      );

    actionButton(MESSAGES.dashboardActionEditor(PRIMARY_LANGUAGE))?.click();
    actionButton(MESSAGES.dashboardActionTerminal(PRIMARY_LANGUAGE))?.click();
    actionButton(MESSAGES.dashboardActionBrowser(PRIMARY_LANGUAGE))?.click();
    actionButton(MESSAGES.dashboardActionDocker(PRIMARY_LANGUAGE))?.click();

    expect(window.jarvis.openEditor).toHaveBeenCalledWith("acme");
    expect(window.jarvis.openTerminal).toHaveBeenCalledWith("acme");
    expect(window.jarvis.openTab).toHaveBeenCalledWith("acme", expect.any(String));
    expect(window.jarvis.openDockerTab).toHaveBeenCalledWith("acme");
    // The route change itself is views.ts's job and is tested there; this
    // harness lays down only the routes it exercises.
  });

  it("renders a project node's action buttons as icon-only, four per node", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([]);
    await settle();

    const nodes = [...document.querySelectorAll<HTMLElement>(".node")];
    expect(nodes.length).toBeGreaterThan(0);

    for (const node of nodes) {
      const buttons = [...node.querySelectorAll<HTMLElement>(".node__action")];
      expect(buttons).toHaveLength(4);
      for (const button of buttons) {
        expect(button.textContent).toBe("");
        expect(button.getAttribute("aria-label")).not.toBe(null);
        expect(button.getAttribute("aria-label")).not.toBe("");
        expect(button.title).toBe(button.getAttribute("aria-label"));
        expect(button.querySelector("svg")).not.toBeNull();
      }
    }
  });

  // The core stage's orb is real information now (the registry's agents,
  // orbiting) rather than the decoration an earlier pass removed — so it is
  // expected to be on screen, unlike the old ".orb"/".brand-title" this test
  // used to pin the absence of.
  it("draws the core stage's brain, not the old plain orb classes", async () => {
    await loadApp();

    expect(document.querySelector(".orb")).toBeNull();
    expect(document.querySelector(".brand-title")).toBeNull();
    expect(document.getElementById("presence")?.className).toContain("brain-core");
  });
});

describe("the Dashboard SESSIONS card's refresh button", () => {
  it("calls sessions:refresh once per click and spins while in flight", async () => {
    await loadApp();
    const refreshSessions = (
      window as unknown as { jarvis: { refreshSessions: ReturnType<typeof vi.fn> } }
    ).jarvis.refreshSessions;
    let resolveRefresh: (value: {
      jarvis: number;
      external: number;
      importedTranscripts: number;
    }) => void = () => {};
    refreshSessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    const button = document.getElementById("dashboard-sessions-refresh") as HTMLButtonElement;
    button.click();

    expect(refreshSessions).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.classList.contains("icon-btn--spinning")).toBe(true);

    resolveRefresh({ jarvis: 0, external: 0, importedTranscripts: 0 });
    await settle();

    expect(button.disabled).toBe(false);
    expect(button.classList.contains("icon-btn--spinning")).toBe(false);

    button.click();
    expect(refreshSessions).toHaveBeenCalledTimes(2);
  });
});

describe("the core stage's orbiting agents", () => {
  // Production reaches setKnownAgentIds() through wireNav()'s own
  // getSettings().then(...) — unreachable in this harness without mounting
  // the whole Settings route (initSettings() throws on this harness's
  // absent #settings-tools, which the outer try/catch swallows before that
  // call ever fires). setKnownAgentIds is the seam both call sites share;
  // exercising it directly proves the same thing production's read does.
  it("draws one chip per registered agent, matching the registry", async () => {
    await loadApp();
    const { setKnownAgentIds } = await import("./app.js");

    setKnownAgentIds(["claude", "codex"]);

    const chips = [...document.querySelectorAll("#agent-orbits .satellite")];
    expect(chips).toHaveLength(2);
    expect(chips.map((chip) => chip.textContent)).toEqual([
      expect.stringContaining("claude"),
      expect.stringContaining("codex"),
    ]);
  });

  it("redraws to match a shorter registry", async () => {
    await loadApp();
    const { setKnownAgentIds } = await import("./app.js");

    setKnownAgentIds(["claude", "codex"]);
    setKnownAgentIds(["claude"]);

    expect(document.querySelectorAll("#agent-orbits .satellite")).toHaveLength(1);
  });
});

describe("the agent's presence", () => {
  const presence = () => document.getElementById("presence")?.className ?? "";
  const state = () => document.getElementById("presence-state")?.textContent ?? "";

  it("is idle when nothing is happening", async () => {
    await loadApp();

    expect(presence()).toContain("presence--idle");
    expect(state()).toBe("Idle");
  });

  it("listens when the microphone opens", async () => {
    const { onListening } = await loadApp();

    onListening?.(true);

    expect(presence()).toContain("presence--listening");
    expect(state()).toBe("Listening…");
  });

  it("speaks while an utterance is being said", async () => {
    const { onSpeaking } = await loadApp();

    onSpeaking?.(true);
    expect(presence()).toContain("presence--speaking");

    onSpeaking?.(false);
    expect(presence()).toContain("presence--idle");
  });

  // Two can be true at once — the microphone opens again while the last
  // reply is still being spoken — so the most specific one wins.
  it("prefers speaking over listening", async () => {
    const { onListening, onSpeaking } = await loadApp();

    onListening?.(true);
    onSpeaking?.(true);

    expect(presence()).toContain("presence--speaking");
  });

  it("thinks between a question being sent and an answer arriving", async () => {
    const { onTurn } = await loadApp();
    const input = document.getElementById("composer") as HTMLInputElement;
    input.value = "what is the state of the build?";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(presence()).toContain("presence--thinking");

    onTurn?.({ role: "assistant", text: "Green.", language: "en", at: Date.now() });

    expect(presence()).toContain("presence--idle");
  });

  // The user's own turn is the question, not the answer to it.
  it("keeps thinking when the echoed user turn arrives", async () => {
    const { onTurn } = await loadApp();
    const input = document.getElementById("composer") as HTMLInputElement;
    input.value = "hello";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    onTurn?.({ role: "user", text: "hello", language: "en", at: Date.now() });

    expect(presence()).toContain("presence--thinking");
  });
});

describe("the running-sessions indicator", () => {
  const pill = (): HTMLElement => {
    const element = document.getElementById("running-pill");
    if (element === null) throw new Error("no #running-pill");
    return element;
  };

  // Hiding it at zero made "nothing is running" look like "there is no
  // indicator". It stays, dimmed, and says so.
  it("stays on screen, dimmed, when nothing is running", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([]);

    expect(pill().hidden).toBe(false);
    expect(pill().classList.contains("pill--idle")).toBe(true);
    expect(document.getElementById("running-count")?.textContent).toBe("0 running");
    expect(document.getElementById("running-orbs")?.childElementCount).toBe(0);
  });

  it("stops being dimmed once something is live", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([]);
    onSessions?.([makeSession({ state: "running" })]);

    expect(pill().classList.contains("pill--idle")).toBe(false);
  });

  it("counts what is actually live", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([
      makeSession({ id: "s1", state: "running" }),
      makeSession({ id: "s2", state: "waiting" }),
      makeSession({ id: "s3", state: "starting" }),
      makeSession({ id: "s4", state: "done" }),
      makeSession({ id: "s5", state: "dead" }),
    ]);

    expect(pill().hidden).toBe(false);
    expect(document.getElementById("running-count")?.textContent).toBe("3 running");
  });

  it("says it in the singular for one", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([makeSession({ state: "running" })]);

    expect(document.getElementById("running-count")?.textContent).toBe("1 running");
  });

  // One orb per session, so two sessions read as two at a glance rather
  // than as a number to stop and parse. Past three the orbs stop being
  // countable and a remainder is the honest way to say so.
  it("draws an orb per session, up to three", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([makeSession({ id: "s1" }), makeSession({ id: "s2" })]);
    expect(document.getElementById("running-orbs")?.childElementCount).toBe(2);

    onSessions?.([
      makeSession({ id: "s1" }),
      makeSession({ id: "s2" }),
      makeSession({ id: "s3" }),
      makeSession({ id: "s4" }),
      makeSession({ id: "s5" }),
    ]);
    expect(document.getElementById("running-orbs")?.childElementCount).toBe(3);
    expect(document.getElementById("running-count")?.textContent).toBe("5 running");
  });

  // What each orb stands for, for anyone who wants the detail without
  // leaving the dashboard.
  it("names the live sessions in its tooltip", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([
      makeSession({ id: "s1", project: "acme", agentId: "claude-main" }),
      makeSession({ id: "s2", project: "storefront", agentId: "copilot", state: "waiting" }),
    ]);

    expect(pill().title).toBe("acme · claude-main\nstorefront · copilot");
  });

  it("goes to the Session view when clicked", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([makeSession({ state: "running" })]);
    pill().click();
    // The click handler's own renderSessionTable() is fire-and-forget, so
    // its showTable() only lands once the mocked getHistory/listSessions
    // promises it awaits have settled.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById("view-session")?.hidden).toBe(false);
  });

  // Fix round 1, I1: the pill's click handler used to call
  // reassertSessionSize() synchronously, alongside — not after —
  // renderSessionTable()'s own fire-and-forget promise.
  // renderSessionTable() only actually shows the table, and flips
  // session-view.ts's terminalVisible to false, once its `getHistory`
  // await settles; called first, the old code would still see whatever
  // terminal was open a moment ago and send its about-to-be-stale size.
  it(// [bite-proof: call reassertSessionSize() synchronously instead of
  // chaining it onto renderSessionTable(); the test fails]
  "does not describe the terminal it is about to hide when clicked from an open session", async () => {
    let resolveHistory: (value: Session[]) => void = () => {};
    const historyPromise = new Promise<Session[]>((resolve) => {
      resolveHistory = resolve;
    });
    await loadApp(() => historyPromise);
    const { openSession } = await import("./session-view.js");
    await openSession(makeSession({ id: "s1" }));

    const jarvis = (window as unknown as { jarvis: { resizeSession: ReturnType<typeof vi.fn> } })
      .jarvis;
    jarvis.resizeSession.mockClear();

    pill().click();

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
