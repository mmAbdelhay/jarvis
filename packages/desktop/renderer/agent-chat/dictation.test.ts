// @vitest-environment jsdom
//
// Dictation in the composer: the mic button, the recording bar, the keys, and
// where the finished text lands. It never sends, never writes to the agent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentView, open, press, settle, t, tab, typeInto, type Setup } from "./fixture.js";
import { forgetAgentDraft } from "./composer.js";

beforeEach(() => {
  forgetAgentDraft("t1");
  document.body.replaceChildren();
});

const input = (s: Setup) => s.q<HTMLTextAreaElement>(".agent-chat__input");
const mic = (s: Setup) => s.q<HTMLButtonElement>(".ac-mic");
const bar = (s: Setup) => s.q<HTMLElement>(".ac-dictation");
const live = (s: Setup) => s.q<HTMLElement>(".ac-dictation__live");
const sendButton = (s: Setup) => s.q<HTMLButtonElement>(".agent-chat__send");
const sendMock = (s: Setup) => s.api.terminalAgentSend as unknown as ReturnType<typeof vi.fn>;
const start = (s: Setup) => s.api.terminalDictateStart as unknown as ReturnType<typeof vi.fn>;
const keep = (s: Setup) => s.api.terminalDictateKeep as unknown as ReturnType<typeof vi.fn>;
const finish = (s: Setup) => s.api.terminalDictateFinish as unknown as ReturnType<typeof vi.fn>;
const cancel = (s: Setup) => s.api.terminalDictateCancel as unknown as ReturnType<typeof vi.fn>;
const button = (s: Setup, name: "done" | "cancel") =>
  s.q<HTMLButtonElement>(`.ac-dictation__${name}`);

async function recording(overrides: { text?: string } = {}): Promise<Setup> {
  const s = await open();
  if (overrides.text !== undefined) typeInto(s, overrides.text);
  mic(s).click();
  await settle();
  return s;
}

describe("the mic button", () => {
  it("sits after attach, unpressed, labelled with its shortcut", async () => {
    const s = await open();
    const buttons = [...s.host.querySelectorAll(".ac-toolbar > button")];
    const attachAt = buttons.findIndex((b) => b.classList.contains("ac-attach"));
    expect(buttons[attachAt + 1]).toBe(mic(s));
    expect(mic(s).getAttribute("aria-pressed")).toBe("false");
    expect(mic(s).getAttribute("aria-label")).toBe(t("agentChatDictate"));
    expect(mic(s).title).toContain(t("agentChatDictate"));
    expect(mic(s).title).toMatch(/⌘⇧M|Ctrl\+Shift\+M/);
  });

  it("starts for this pane and shows the recording bar", async () => {
    const s = await open();
    mic(s).click();
    await settle();
    expect(start(s)).toHaveBeenCalledWith("t1");
    expect(mic(s).getAttribute("aria-pressed")).toBe("true");
    expect(mic(s).getAttribute("aria-label")).toBe(t("agentChatDictateFinish"));
    expect(bar(s).hidden).toBe(false);
    // Text as well as colour: the word and the time.
    expect(bar(s).textContent).toContain(t("agentChatDictateRecording"));
    expect(bar(s).textContent).toContain("0:00");
    expect(button(s, "done").textContent).toBe(t("agentChatDictateDone"));
    expect(button(s, "cancel").textContent).toBe(t("agentChatDictateCancel"));
    expect(live(s).textContent).toBe(t("agentChatDictateStarted"));
  });

  it("the second click finishes", async () => {
    const s = await recording();
    mic(s).click();
    await settle();
    expect(finish(s)).toHaveBeenCalledWith("d1");
  });

  it("is off while a question holds the composer", async () => {
    const s = await open(
      agentView({
        prompt: {
          kind: "single",
          question: "Run it?",
          options: [{ label: "Yes", highlighted: true }],
        },
      }),
    );
    expect(mic(s).disabled).toBe(true);
  });
});

describe("while recording", () => {
  it("counts the time and keeps the lease every five seconds", async () => {
    const s = await recording();
    s.timers.advance(1000);
    expect(bar(s).textContent).toContain("0:01");
    expect(keep(s)).not.toHaveBeenCalled();
    for (let i = 0; i < 4; i++) s.timers.advance(1000);
    expect(keep(s)).toHaveBeenCalledTimes(1);
    expect(keep(s)).toHaveBeenCalledWith("d1");
    for (let i = 0; i < 60; i++) s.timers.advance(1000);
    expect(bar(s).textContent).toContain("1:05");
    expect(keep(s).mock.calls.length).toBe(13);
    // The live region said it once, not per second.
    expect(live(s).textContent).toBe(t("agentChatDictateStarted"));
  });

  it("lets the person keep typing, and disables Send", async () => {
    const s = await recording();
    expect(input(s).disabled).toBe(false);
    expect(sendButton(s).disabled).toBe(true);
    typeInto(s, "while talking");
    expect(input(s).value).toBe("while talking");
    expect(sendMock(s)).not.toHaveBeenCalled();
  });

  it("Enter is Done, never send", async () => {
    const s = await recording({ text: "draft" });
    const event = press(input(s), "Enter");
    expect(event.defaultPrevented).toBe(true);
    await settle();
    expect(finish(s)).toHaveBeenCalledTimes(1);
    expect(sendMock(s)).not.toHaveBeenCalled();
  });

  it("Escape cancels and does not reach the agent or the pane", async () => {
    const s = await recording();
    const seen = vi.fn();
    s.host.addEventListener("keydown", seen);
    const event = press(input(s), "Escape");
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(seen).not.toHaveBeenCalled();
    expect(cancel(s)).toHaveBeenCalledWith("d1");
    expect(s.api.terminalAgentStop).not.toHaveBeenCalled();
    expect(bar(s).hidden).toBe(true);
    expect(mic(s).getAttribute("aria-pressed")).toBe("false");
  });

  it("Escape with no dictation is left to the others", async () => {
    const s = await open();
    const seen = vi.fn();
    s.host.addEventListener("keydown", seen);
    press(input(s), "Escape");
    expect(seen).toHaveBeenCalled();
  });

  it("the Cancel button cancels", async () => {
    const s = await recording();
    button(s, "cancel").click();
    await settle();
    expect(cancel(s)).toHaveBeenCalledWith("d1");
    expect(finish(s)).not.toHaveBeenCalled();
    expect(bar(s).hidden).toBe(true);
  });

  it("stops keeping the lease once cancelled", async () => {
    const s = await recording();
    button(s, "cancel").click();
    await settle();
    for (let i = 0; i < 10; i++) s.timers.advance(1000);
    expect(keep(s)).not.toHaveBeenCalled();
  });

  it("the shortcut toggles it from anywhere in the chat", async () => {
    const s = await open();
    press(s.q(".agent-chat"), "m", { metaKey: true, shiftKey: true });
    await settle();
    expect(start(s)).toHaveBeenCalledTimes(1);
    press(s.q(".agent-chat"), "M", { metaKey: true, shiftKey: true });
    await settle();
    expect(finish(s)).toHaveBeenCalledTimes(1);
  });

  it("a keep that fails says so and frees the button", async () => {
    const s = await recording();
    keep(s).mockResolvedValueOnce({ ok: false, reason: "failed" });
    for (let i = 0; i < 5; i++) s.timers.advance(1000);
    await settle();
    expect(s.q(".agent-chat__note").textContent).toBe(t("agentChatDictateFailed"));
    expect(bar(s).hidden).toBe(true);
    expect(mic(s).getAttribute("aria-pressed")).toBe("false");
  });

  it("finishes by itself when the core says the clip hit its cap", async () => {
    const s = await recording();
    keep(s).mockResolvedValueOnce({ ok: true, capped: true });
    for (let i = 0; i < 5; i++) s.timers.advance(1000);
    await settle();
    expect(finish(s)).toHaveBeenCalledWith("d1");
  });
});

describe("transcribing and the text", () => {
  it("shows the wait with Cancel, then puts the text in the box without sending", async () => {
    const s = await recording();
    let release: (value: unknown) => void = () => undefined;
    finish(s).mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    button(s, "done").click();
    await settle();
    expect(bar(s).textContent).toContain(t("agentChatDictateWriting"));
    expect(button(s, "cancel")).toBeTruthy();
    expect(s.host.querySelector(".ac-dictation__done")).toBeNull();
    expect(live(s).textContent).toBe(t("agentChatDictateWriting"));
    expect(sendButton(s).disabled).toBe(true);
    // Enter does not send while it is writing.
    expect(press(input(s), "Enter").defaultPrevented).toBe(true);
    release({ ok: true, text: "run the tests", language: "en" });
    await settle();
    expect(input(s).value).toBe("run the tests");
    expect(sendMock(s)).not.toHaveBeenCalled();
    expect(bar(s).hidden).toBe(true);
    expect(sendButton(s).disabled).toBe(false);
    expect(live(s).textContent).toBe(t("agentChatDictateInserted"));
    expect(document.activeElement).toBe(input(s));
  });

  it("inserts at the caret with a space on each side where needed", async () => {
    const s = await recording({ text: "fix the bug now" });
    input(s).setSelectionRange(7, 7); // after "fix the"
    button(s, "done").click();
    await settle();
    expect(input(s).value).toBe("fix the hello world bug now");
  });

  it("replaces a selection", async () => {
    const s = await recording({ text: "say XXX please" });
    input(s).setSelectionRange(4, 7);
    button(s, "done").click();
    await settle();
    expect(input(s).value).toBe("say hello world please");
  });

  it("adds no space where there is already one, or at the ends", async () => {
    const s = await recording({ text: "one " });
    button(s, "done").click();
    await settle();
    expect(input(s).value).toBe("one hello world");
  });

  it("keeps the draft saved and the input events of a typed change", async () => {
    const s = await recording();
    const seen = vi.fn();
    input(s).addEventListener("input", seen);
    button(s, "done").click();
    await settle();
    expect(seen).toHaveBeenCalled();
    // A draft survives a rebuilt pane.
    s.chat.dispose();
    const again = await open();
    expect(input(again).value).toBe("hello world");
  });

  it("never opens the / or @ menu for dictated text", async () => {
    const s = await recording();
    finish(s).mockResolvedValueOnce({ ok: true, text: "/compact @src", language: "en" });
    button(s, "done").click();
    await settle();
    s.timers.advance(500);
    await settle();
    expect(input(s).value).toBe("/compact @src");
    expect(s.api.terminalAgentCommands).not.toHaveBeenCalled();
    expect(s.api.terminalAgentFiles).not.toHaveBeenCalled();
    expect(input(s).getAttribute("aria-expanded")).toBe("false");
  });

  it("grows the box", async () => {
    const s = await recording();
    Object.defineProperty(input(s), "scrollHeight", { configurable: true, value: 120 });
    button(s, "done").click();
    await settle();
    expect(input(s).style.height).toBe("120px");
  });

  it("a locked composer still gets the words in its draft", async () => {
    const s = await recording({ text: "before" });
    s.current.view = agentView({
      prompt: {
        kind: "single",
        question: "Run it?",
        options: [{ label: "Yes", highlighted: true }],
      },
    });
    s.chat.refresh();
    await settle();
    expect(input(s).disabled).toBe(true);
    button(s, "done").click();
    await settle();
    expect(input(s).value).toBe("before hello world");
  });
});

describe("cancelling and leaving", () => {
  it("cancel while writing drops the text", async () => {
    const s = await recording({ text: "keep" });
    let release: (value: unknown) => void = () => undefined;
    finish(s).mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    button(s, "done").click();
    await settle();
    button(s, "cancel").click();
    await settle();
    expect(cancel(s)).toHaveBeenCalledWith("d1");
    release({ ok: true, text: "late words", language: "en" });
    await settle();
    expect(input(s).value).toBe("keep");
    expect(bar(s).hidden).toBe(true);
  });

  it("a start answered after cancel is cancelled at once", async () => {
    const s = await open();
    let release: (value: unknown) => void = () => undefined;
    start(s).mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    mic(s).click();
    await settle();
    press(input(s), "Escape");
    release({ ok: true, id: "late" });
    await settle();
    expect(cancel(s)).toHaveBeenCalledWith("late");
    expect(bar(s).hidden).toBe(true);
    expect(keep(s)).not.toHaveBeenCalled();
  });

  it("a pane that is destroyed cancels the recording", async () => {
    const s = await recording();
    s.chat.dispose();
    await settle();
    expect(cancel(s)).toHaveBeenCalledWith("d1");
  });

  it("text that arrives after the pane was destroyed lands in that pane's draft", async () => {
    const s = await recording({ text: "so far" });
    let release: (value: unknown) => void = () => undefined;
    finish(s).mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    button(s, "done").click();
    await settle();
    s.chat.dispose();
    release({ ok: true, text: "and then", language: "en" });
    await settle();
    expect(cancel(s)).not.toHaveBeenCalled();
    const again = await open();
    expect(input(again).value).toBe("so far and then");
  });

  it("the agent leaving cancels", async () => {
    const s = await recording();
    s.current.view = { kind: "none" };
    s.chat.refresh();
    await settle();
    expect(cancel(s)).toHaveBeenCalledWith("d1");
  });

  it("pagehide cancels", async () => {
    const s = await recording();
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(cancel(s)).toHaveBeenCalledWith("d1");
    expect(bar(s).hidden).toBe(true);
  });
});

describe("refusals", () => {
  it.each([
    [{ ok: false, reason: "busy" }, "agentChatDictateBusy"],
    [{ ok: false, reason: "failed" }, "agentChatDictateFailed"],
  ] as const)("a start answered %j says why and leaves the draft", async (answer, key) => {
    const s = await open();
    typeInto(s, "mine");
    start(s).mockResolvedValueOnce(answer);
    mic(s).click();
    await settle();
    expect(s.q(".agent-chat__note").textContent).toBe(t(key));
    expect(input(s).value).toBe("mine");
    expect(bar(s).hidden).toBe(true);
    expect(mic(s).getAttribute("aria-pressed")).toBe("false");
  });

  it("a start that throws says it failed", async () => {
    const s = await open();
    start(s).mockRejectedValueOnce(new Error("ipc"));
    mic(s).click();
    await settle();
    expect(s.q(".agent-chat__note").textContent).toBe(t("agentChatDictateFailed"));
  });

  it.each([
    [{ ok: false, reason: "silence" }, "agentChatDictateSilence"],
    [{ ok: false, reason: "failed" }, "agentChatDictateFailed"],
  ] as const)("a finish answered %j says why and leaves the draft", async (answer, key) => {
    const s = await recording({ text: "mine" });
    finish(s).mockResolvedValueOnce(answer);
    button(s, "done").click();
    await settle();
    expect(s.q(".agent-chat__note").textContent).toBe(t(key));
    expect(input(s).value).toBe("mine");
    expect(bar(s).hidden).toBe(true);
  });

  it("a finish that is gone says it failed, so the words are not lost without a word", async () => {
    const s = await recording();
    finish(s).mockResolvedValueOnce({ ok: false, reason: "gone" });
    button(s, "done").click();
    await settle();
    expect(s.q(".agent-chat__note").textContent).toBe(t("agentChatDictateFailed"));
    expect(bar(s).hidden).toBe(true);
  });

  it("a finish answered after the person cancelled says nothing", async () => {
    const s = await recording();
    let release: (value: unknown) => void = () => undefined;
    finish(s).mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    button(s, "done").click();
    await settle();
    button(s, "cancel").click();
    release({ ok: false, reason: "gone" });
    await settle();
    expect(s.q<HTMLElement>(".agent-chat__note").hidden).toBe(true);
  });

  it.each([
    [{ ok: false, reason: "no-recorder" }, "agentChatDictateNoRecorder"],
    [{ ok: false, reason: "no-whisper" }, "agentChatDictateNoWhisper"],
  ] as const)("a finish answered %j names the missing tool", async (answer, key) => {
    const s = await recording({ text: "mine" });
    finish(s).mockResolvedValueOnce(answer);
    button(s, "done").click();
    await settle();
    expect(s.q(".agent-chat__note").textContent).toBe(t(key));
    expect(input(s).value).toBe("mine");
  });

  it("mentions the real path to setup", () => {
    expect(t("agentChatDictateNoRecorder")).toContain("Settings > Tools");
    expect(t("agentChatDictateNoWhisper")).toContain("Settings > Tools");
    expect(t("agentChatDictateFailed")).toContain("microphone");
  });
});

describe("a pane that is no longer shown", () => {
  const hiddenSetup = async () => {
    const state = { shown: true };
    const s = await open(agentView(), { isShown: () => state.shown });
    mic(s).click();
    await settle();
    return { s, state };
  };

  it("finishes the recording when its tab or route is hidden, words into the draft", async () => {
    const { s, state } = await hiddenSetup();
    state.shown = false;
    s.timers.advance(1000);
    await settle();
    expect(finish(s)).toHaveBeenCalledWith("d1");
    expect(input(s).value).toBe("hello world");
    expect(sendMock(s)).not.toHaveBeenCalled();
  });

  it("finishes at once when the chat is switched to the terminal", async () => {
    const { s } = await hiddenSetup();
    tab(s.host, "term").click();
    await settle();
    expect(finish(s)).toHaveBeenCalledWith("d1");
    expect(input(s).value).toBe("hello world");
  });

  it("does not finish for a minimised window", async () => {
    const { s } = await hiddenSetup();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      for (let i = 0; i < 3; i++) s.timers.advance(1000);
      await settle();
      expect(finish(s)).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });
});

describe("a destroyed composer", () => {
  it("drops the shortcut listener with the pane", async () => {
    const s = await open();
    const panel = s.q(".agent-chat");
    s.chat.dispose();
    press(panel, "m", { metaKey: true, shiftKey: true });
    await settle();
    expect(start(s)).not.toHaveBeenCalled();
  });

  it("is not touched by words that arrive afterwards", async () => {
    const s = await recording({ text: "so far" });
    let release: (value: unknown) => void = () => undefined;
    finish(s).mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    button(s, "done").click();
    await settle();
    const liveNode = live(s);
    const noteNode = s.q<HTMLElement>(".agent-chat__note");
    const box = input(s);
    s.chat.dispose();
    const before = [liveNode.textContent, noteNode.textContent, box.value];
    release({ ok: true, text: "later", language: "en" });
    await settle();
    expect([liveNode.textContent, noteNode.textContent, box.value]).toEqual(before);
  });

  it("leaves the words in the draft for a composer built later when none is live", async () => {
    const s = await recording({ text: "keep" });
    let release: (value: unknown) => void = () => undefined;
    finish(s).mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    button(s, "done").click();
    await settle();
    s.chat.dispose();
    release({ ok: true, text: "this", language: "en" });
    await settle();
    document.body.replaceChildren();
    expect(input(await open()).value).toBe("keep this");
  });
});
