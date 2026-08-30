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
import type { Session } from "@jarvis/core";
import type { VoiceNotice } from "../src/ipc.js";

type Callbacks = {
  onListening?: (listening: boolean) => void;
  onNotice?: (notice: VoiceNotice) => void;
  onSessions?: (sessions: Session[]) => void;
};

async function loadApp(getHistory: () => Promise<Session[]> = async () => []): Promise<Callbacks> {
  vi.resetModules();
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
  `;

  const callbacks: Callbacks = {};
  (window as unknown as { jarvis: Record<string, unknown> }).jarvis = {
    send: vi.fn(async () => {}),
    startVoice: vi.fn(async () => {}),
    stopVoice: vi.fn(async () => {}),
    onMetrics: vi.fn(),
    onSessions: (cb: (sessions: Session[]) => void) => {
      callbacks.onSessions = cb;
    },
    onTurn: vi.fn(),
    onListening: (cb: (listening: boolean) => void) => {
      callbacks.onListening = cb;
    },
    onNotice: (cb: (notice: VoiceNotice) => void) => {
      callbacks.onNotice = cb;
    },
    getHistory: vi.fn(getHistory),
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

  it("shows '1 session' not '1 sessions' for a single past session, and pluralises the badge through the bilingual MESSAGES table", async () => {
    await loadApp(async () => [makeSession()]);
    document.getElementById("history-button")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById("history-count")?.textContent).toBe("1 session");
  });

  it("shows the plural form for zero or more than one past session", async () => {
    await loadApp(async () => []);
    document.getElementById("history-button")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.getElementById("history-count")?.textContent).toBe("0 sessions");
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
