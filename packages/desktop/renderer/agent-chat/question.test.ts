// @vitest-environment jsdom
//
// The question card and the terminal drawer: screen prompts as buttons, the
// transcript's own record read-only beside them, and the pane's live terminal
// shown inside the card for a menu only the terminal can answer.
import { beforeEach, describe, expect, it } from "vitest";
import { agentView, open, press, setup, settle, t, tab } from "./fixture.js";

beforeEach(() => {
  document.body.replaceChildren();
});

const single = () =>
  agentView({
    prompt: {
      kind: "single",
      question: "Run this command?",
      body: "npm run migrate",
      options: [
        { label: "Yes", highlighted: true },
        { label: "Yes, don't ask again", highlighted: false },
        { label: "No", highlighted: false },
      ],
    },
  });

describe("a pending question", () => {
  it("shows the question, its command and one numbered button per option", async () => {
    const s = await open(single());
    const card = s.q<HTMLElement>(".agent-chat__prompt");
    expect(card.hidden).toBe(false);
    expect(card.textContent).toContain("Run this command?");
    expect(card.textContent).toContain(t("agentChatNeedsAnswer"));
    expect(card.querySelector("pre")?.textContent).toBe("npm run migrate");
    const buttons = [...card.querySelectorAll<HTMLButtonElement>("button[data-index]")];
    expect(buttons.map((b) => b.textContent)).toEqual(["1 Yes", "2 Yes, don't ask again", "3 No"]);
    expect(buttons[0]?.classList.contains("ac-primary")).toBe(true);
    expect(s.q<HTMLTextAreaElement>(".agent-chat__input").disabled).toBe(true);
  });

  it("answers by index and label from the screen's own prompt, then looks again", async () => {
    const s = await open(single());
    const calls = s.api.terminalAgentChat.mock.calls.length;
    s.timers.advance(400);
    s.host.querySelectorAll<HTMLButtonElement>("button[data-index]")[2]?.click();
    await settle();
    expect(s.api.terminalAgentAnswer).toHaveBeenCalledWith("t1", 2, "No");
    expect(s.api.terminalAgentChat.mock.calls.length).toBeGreaterThan(calls);
  });

  it("says so when the question changed or is gone", async () => {
    const s = await open(single());
    s.timers.advance(400);
    s.api.terminalAgentAnswer.mockResolvedValueOnce({ ok: false, reason: "changed" } as never);
    s.host.querySelector<HTMLButtonElement>("button[data-index]")?.click();
    await settle();
    expect(s.q(".agent-chat__note").textContent).toBe(t("agentChatAnswerChanged"));
    s.api.terminalAgentAnswer.mockResolvedValueOnce({ ok: false, reason: "gone" } as never);
    s.host.querySelector<HTMLButtonElement>("button[data-index]")?.click();
    await settle();
    expect(s.q(".agent-chat__note").textContent).toBe(t("agentChatAnswerGone"));
  });

  it("keeps the buttons across a refresh and drops the card when the question goes", async () => {
    const s = await open(single());
    const button = s.q<HTMLButtonElement>("button[data-index]");
    s.chat.refresh();
    await settle();
    expect(s.q("button[data-index]")).toBe(button);
    s.current.view = agentView();
    s.chat.refresh();
    await settle();
    expect(s.q<HTMLElement>(".agent-chat__prompt").hidden).toBe(true);
    expect(s.q<HTMLTextAreaElement>(".agent-chat__input").disabled).toBe(false);
  });

  it("shows the transcript's own questions read-only: every question, option descriptions", async () => {
    const s = await open(
      agentView({
        ...single(),
        asking: {
          id: "q1",
          tool: "AskUserQuestion",
          questions: [
            {
              question: "Which tests?",
              header: "Tests",
              multiSelect: false,
              options: [
                { label: "Unit", description: "Fast checks" },
                { label: "E2E", description: "Slow checks" },
              ],
            },
            { question: "Which branch?", multiSelect: true, options: [{ label: "main" }] },
          ],
        },
      }),
    );
    const details = s.q<HTMLElement>(".ac-question__details");
    expect(details.textContent).toContain("Which tests?");
    expect(details.textContent).toContain("Which branch?");
    expect(details.textContent).toContain("Fast checks");
    expect(details.textContent).toContain(t("agentChatQuestionMulti"));
    // Read-only: no button inside, so nothing here can answer.
    expect(details.querySelector("button, input")).toBeNull();
  });

  it("renders a plan as markdown and offers the screen's own approval buttons", async () => {
    const s = await open(
      agentView({
        prompt: {
          kind: "single",
          question: "Start on this plan?",
          options: [
            { label: "Start", highlighted: true },
            { label: "Keep planning", highlighted: false },
          ],
        },
        asking: {
          id: "p",
          tool: "ExitPlanMode",
          plan: "1. Move the discount\n2. **Add** tests\n\n`npm test`",
        },
      }),
    );
    const plan = s.q<HTMLElement>(".ac-question__plan");
    expect(plan.querySelectorAll("[role='listitem']")).toHaveLength(2);
    expect(plan.querySelector("strong")?.textContent).toBe("Add");
    expect(plan.querySelector("code")?.textContent).toBe("npm test");
    expect([...s.host.querySelectorAll("button[data-index]")].map((b) => b.textContent)).toEqual([
      "1 Start",
      "2 Keep planning",
    ]);
  });
});

describe("the terminal drawer", () => {
  it("opens by itself for a menu only the terminal can answer, over the card's slot, without moving the terminal", async () => {
    const s = await open(agentView({ needsTerm: true }));
    const live = s.q<HTMLElement>(".terminal-live");
    const parent = live.parentElement;
    expect(s.host.dataset["drawer"]).toBe("on");
    expect(live.style.getPropertyValue("--drawer-w")).not.toBe("");
    expect(live.parentElement).toBe(parent);
    expect(s.q<HTMLElement>(".ac-drawer-slot").hidden).toBe(false);
    expect(document.activeElement).not.toBe(s.xterm);
    expect(s.q<HTMLTextAreaElement>(".agent-chat__input").disabled).toBe(true);
    expect(s.host.querySelector<HTMLElement>(".ac-terminal-button")?.textContent).toBe(
      t("agentChatHideTerminal"),
    );
  });

  it("opens for a multi-choice menu, and never types into the terminal on its own", async () => {
    const s = await open(
      agentView({
        prompt: {
          kind: "multi",
          question: "Which tests?",
          options: [
            { label: "Unit", highlighted: true },
            { label: "E2E", highlighted: false },
          ],
        },
      }),
    );
    expect(s.host.dataset["drawer"]).toBe("on");
    expect(s.host.querySelector("button[data-index]")).toBeNull();
    expect(s.api.terminalAgentAnswer).not.toHaveBeenCalled();
    expect(s.api.terminalAgentSend).not.toHaveBeenCalled();
    expect(s.q(".ac-question__hint").textContent).toBe(t("agentChatQuestionInTerm"));
  });

  it("is closed and reopened by its button, and stays closed across a refresh", async () => {
    const s = await open(agentView({ needsTerm: true }));
    const button = s.q<HTMLButtonElement>(".ac-terminal-button");
    button.click();
    expect(s.host.dataset["drawer"]).toBeUndefined();
    expect(button.textContent).toBe(t("agentChatShowTerminal"));
    s.chat.refresh();
    await settle();
    expect(s.host.dataset["drawer"]).toBeUndefined();
    button.click();
    expect(s.host.dataset["drawer"]).toBe("on");
  });

  it("closes by itself when the menu is gone, and the keys return to the composer", async () => {
    const s = await open(agentView({ needsTerm: true }));
    expect(document.activeElement).not.toBe(s.xterm);
    s.q<HTMLButtonElement>(".ac-answer-term").click();
    expect(document.activeElement).toBe(s.xterm);
    s.current.view = agentView();
    s.chat.refresh();
    await settle();
    expect(s.host.dataset["drawer"]).toBeUndefined();
    expect(s.q<HTMLElement>(".agent-chat__prompt").hidden).toBe(true);
    expect(document.activeElement).toBe(s.q(".agent-chat__input"));
    expect(s.q<HTMLElement>(".terminal-live").style.getPropertyValue("--drawer-w")).toBe("");
  });

  it("leaves Escape to the agent: nothing in the chat handles a key typed in the terminal", async () => {
    const s = await open(agentView({ needsTerm: true }));
    const escaped = press(s.xterm, "Escape");
    expect(escaped.defaultPrevented).toBe(false);
    expect(s.host.dataset["drawer"]).toBe("on");
  });

  it("closes when the chat goes back to Term", async () => {
    const s = await open(agentView({ needsTerm: true }));
    tab(s.host, "term").click();
    expect(s.host.dataset["drawer"]).toBeUndefined();
  });

  it("falls back to a Switch to Term button when the pane has no live terminal", async () => {
    const s = setup({}, agentView({ needsTerm: true }));
    s.q<HTMLElement>(".terminal-live").remove();
    s.chat.focused();
    await settle();
    tab(s.host, "chat").click();
    expect(s.host.dataset["drawer"]).toBeUndefined();
    expect(s.q<HTMLElement>(".ac-terminal-button").hidden).toBe(true);
    const toTerm = s.q<HTMLButtonElement>(".ac-to-term");
    expect(toTerm.hidden).toBe(false);
    toTerm.click();
    expect(tab(s.host, "term").getAttribute("aria-selected")).toBe("true");
    expect(s.focusTerm).toHaveBeenCalled();
  });

  it("never takes the keys from the composer when it opens, and the locked composer hands them to the card, not an option", async () => {
    const s = await open();
    const input = s.q<HTMLTextAreaElement>(".agent-chat__input");
    input.focus();
    s.current.view = single();
    s.chat.refresh();
    await settle();
    expect(document.activeElement).toBe(s.q(".agent-chat__prompt"));
    expect(document.activeElement?.tagName).not.toBe("BUTTON");
    s.current.view = agentView({ needsTerm: true, sessionId: "s1" });
    s.chat.refresh();
    await settle();
    expect(document.activeElement).not.toBe(s.xterm);
  });

  it("ignores an answer in the first 400 ms after a question appears or changes, and says so", async () => {
    const s = await open(single());
    const button = s.q<HTMLButtonElement>("button[data-index]");
    button.click();
    await settle();
    expect(s.api.terminalAgentAnswer).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    expect(s.q(".ac-sr-only").textContent).toBe(t("agentChatQuestionWait"));
    s.timers.advance(400);
    button.click();
    await settle();
    expect(s.api.terminalAgentAnswer).toHaveBeenCalledTimes(1);
    // A changed question starts the guard again.
    const next = single();
    next.prompt = {
      kind: "single",
      question: "Another?",
      options: [{ label: "Ok", highlighted: true }],
    };
    s.current.view = next;
    s.chat.refresh();
    await settle();
    s.q<HTMLButtonElement>("button[data-index]").click();
    await settle();
    expect(s.api.terminalAgentAnswer).toHaveBeenCalledTimes(1);
  });

  it("does not repeat the question text inside its details", async () => {
    const s = await open(
      agentView({
        ...single(),
        asking: {
          id: "q",
          tool: "AskUserQuestion",
          questions: [
            { question: "Run this command?", multiSelect: false, options: [{ label: "Yes" }] },
          ],
        },
      }),
    );
    expect(
      (s.q(".agent-chat__prompt").textContent?.match(/Run this command\?/g) ?? []).length,
    ).toBe(1);
  });
});
