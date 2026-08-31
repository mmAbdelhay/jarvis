// @vitest-environment jsdom
//
// renderListening/renderNotice are pure DOM manipulation over the
// #voice-state element, so — like defaultSpeechRunner/defaultRecorderDeps —
// they're cheap to exercise directly rather than leaving them
// inspection-only. app.ts registers its `window.jarvis.on*` callbacks as a
// side effect of being imported, so each test re-mocks `window.jarvis`,
// lays down the minimal DOM app.ts's module-top-level code touches
// (#composer/#composer-send so wireComposer doesn't throw, #clock-time/
// #clock-date so startClock has somewhere to write, #voice-state itself),
// and re-imports the module fresh via vi.resetModules().
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, SessionChanges, SessionOutput } from "@jarvis/core";
import type { VoiceNotice } from "../src/ipc.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { FakeFitAddon, FakeTerminal } from "./terminal-double.js";

// app.ts pulls in session-view.ts, which hosts a real terminal emulator.
// jsdom has neither a canvas nor real character metrics, so the vendored
// xterm modules are doubled here the same way session-view.test.ts does it.
vi.mock("./vendor/xterm.mjs", () => ({ Terminal: FakeTerminal }));
vi.mock("./vendor/addon-fit.mjs", () => ({ FitAddon: FakeFitAddon }));

type Callbacks = {
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
    <span id="clock-time"></span>
    <span id="clock-date"></span>
    <input id="composer" />
    <button id="composer-send"></button>
    <span id="voice-state">placeholder</span>
    <button id="mic-button"></button>
    <span id="session-count"></span>
    <div id="sessions"></div>
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
    <button id="nav-session" class="nav-btn" type="button"></button>
    <div class="main main--session" id="view-session" hidden>
      <div id="session-view-project"></div>
      <div id="session-view-path"></div>
      <div id="session-view-state"></div>
      <div id="session-view-agent"></div>
      <div id="session-voice" hidden></div>
      <div id="session-terminal"></div>
      <div id="session-empty" hidden></div>
    </div>
  `;

  const callbacks: Callbacks = {};
  (window as unknown as { jarvis: Record<string, unknown> }).jarvis = {
    send: vi.fn(async () => {}),
    startVoice: vi.fn(async () => {}),
    stopVoice: vi.fn(async () => {}),
    onMetrics: vi.fn(),
    onProviders: vi.fn(),
    onWorkspace: vi.fn(),
    getProjects: vi.fn(async () => []),
    onSessions: (cb: (sessions: Session[]) => void) => {
      callbacks.onSessions = cb;
    },
    onChangeCounts: (cb: (changes: SessionChanges[]) => void) => {
      callbacks.onChangeCounts = cb;
    },
    onTurn: vi.fn(),
    onSessionOutput: (cb: (output: SessionOutput) => void) => {
      callbacks.onSessionOutput = cb;
    },
    getSessionLog: vi.fn(getSessionLog),
    sendSessionInput: vi.fn(async () => {}),
    resizeSession: vi.fn(async () => {}),
    setVoiceTarget: vi.fn(async () => {}),
    onListening: (cb: (listening: boolean) => void) => {
      callbacks.onListening = cb;
    },
    onNotice: (cb: (notice: VoiceNotice) => void) => {
      callbacks.onNotice = cb;
    },
    getHistory: vi.fn(getHistory),
    gitChanges: vi.fn(gitChanges),
    gitDiff: vi.fn(async () => ({ ok: false, text: "not stubbed", language: "en" })),
    gitSetStaged: vi.fn(async () => ({ ok: false, text: "not stubbed", language: "en" })),
    gitCommit: vi.fn(async () => ({ ok: false, text: "not stubbed", language: "en" })),
  };

  await import("./app.js");
  return callbacks;
}

function jarvisApi(): { startVoice: ReturnType<typeof vi.fn>; stopVoice: ReturnType<typeof vi.fn> } {
  return (window as unknown as { jarvis: { startVoice: ReturnType<typeof vi.fn>; stopVoice: ReturnType<typeof vi.fn> } })
    .jarvis;
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

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    project: "acme",
    projectPath: "/p/acme",
    agentId: "claude-mm",
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
    onSessions?.([makeSession({ project: "سعودي سيل" })]);

    const project = document.querySelector("#sessions .session__project");
    expect(project).not.toBeNull();
    expect(project?.textContent).toBe("سعودي سيل");
    expect((project as HTMLElement).dir).toBe("rtl");
    expect(project?.classList.contains("arabic")).toBe(true);
  });

  it("renders an English project name left-to-right with no arabic class", async () => {
    const { onSessions } = await loadApp();
    onSessions?.([makeSession({ project: "acme" })]);

    const project = document.querySelector("#sessions .session__project");
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

    onSessions?.([makeSession({ id: "fresh" })]);
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById("view-session")?.hidden).toBe(false);
    expect(getSessionLog).toHaveBeenCalledWith("fresh");
    expect(FakeTerminal.last?.text).toBe("booting…\n");
  });

  it("does not reopen the view when an already-known session merely changes state", async () => {
    const getSessionLog = vi.fn(async () => "");
    const { onSessions } = await loadApp(undefined, undefined, getSessionLog);

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

    document.querySelector<HTMLElement>("#sessions .session")?.click();
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
        session: { id: "s1", project: "acme", projectPath: "/p", agentId: "claude-mm", lastActivityAt: 1000, endedAt: undefined },
        changes: { repoPath: "/p", branch: "main", detached: false, files: [], insertions: 3, deletions: 1 },
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

    const badge = document.querySelector<HTMLElement>("#sessions .session__diff");
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

    onSessions?.([makeSession({ id: "s1" })]);
    await Promise.resolve();
    await Promise.resolve();
    onSessionOutput?.({ sessionId: "s1", chunk: "live line\n" });

    expect(FakeTerminal.last?.text).toBe("live line\n");
  });
});
