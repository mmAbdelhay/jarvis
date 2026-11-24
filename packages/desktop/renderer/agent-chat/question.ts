// The question card: what the agent is waiting on. A numbered menu the screen
// proves is a row of buttons (answered through terminal:agentAnswer, which
// re-reads the screen); the transcript's own record of the question or plan
// is shown read-only beside them. A menu only the terminal can answer, or one
// with several choices, opens the terminal drawer inside the card; it closes
// by itself when the menu is gone and the keys come back to the composer.
// Nothing is typed for the user.
import type { ChatAsking } from "@jarvis/platform";
import type { AgentOf } from "./agent-types.js";
import { type CodeContext, renderCode, renderMarkdown } from "./code.js";
import type { Drawer } from "./drawer.js";
import { el, type Translate } from "./dom.js";

export type QuestionOptions = {
  t: Translate;
  code: CodeContext;
  drawer: Drawer;
  answer(index: number, label: string): Promise<void>;
  focusComposer(): void;
  /** For a pane with no live terminal to show: the Term view. */
  toTerm(): void;
  /** Milliseconds clock and one-shot timer (the card ignores answers just after it appears). */
  now(): number;
  schedule(fn: () => void, ms: number): () => void;
};

/** How long after a question appears or changes its buttons ignore a click. */
export const ANSWER_GUARD_MS = 400;

export type QuestionCard = {
  element: HTMLElement;
  update(view: AgentOf, answering: boolean): void;
  /** Whether a question is showing. */
  shown(): boolean;
};

function details(asking: ChatAsking, t: Translate, title: string): HTMLElement | undefined {
  if (asking.questions === undefined || asking.questions.length === 0) return undefined;
  const box = el("details", "ac-question__details");
  box.open = true;
  box.append(el("summary", undefined, t("agentChatQuestionDetails")));
  for (const question of asking.questions) {
    const block = el("div", "ac-question__item");
    if (question.header !== undefined && question.header !== "") {
      block.append(el("span", "ac-badge", question.header));
    }
    if (question.question !== title) {
      const text = el("strong", undefined, question.question);
      text.dir = "auto";
      block.append(text);
    }
    if (question.multiSelect) block.append(el("span", "ac-badge", t("agentChatQuestionMulti")));
    const list = el("ul", "ac-question__options");
    for (const option of question.options) {
      const item = el("li");
      item.append(el("strong", undefined, option.label));
      if (option.description !== undefined && option.description !== "") {
        const note = el("span", "ac-question__note", ` ${option.description}`);
        note.dir = "auto";
        item.append(note);
      }
      list.append(item);
    }
    block.append(list);
    box.append(block);
  }
  return box;
}

export function createQuestion(options: QuestionOptions): QuestionCard {
  const { t, drawer } = options;
  const element = el("div", "agent-chat__prompt ac-question");
  element.hidden = true;
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", t("agentChatQuestionLabel"));
  // Where the keys land when the composer locks under the typist: a card that
  // acts on nothing, never an option.
  element.tabIndex = -1;
  const announce = el("span", "ac-sr-only");
  announce.setAttribute("role", "status");
  let shownAt = 0;
  let cancelAnnounce: (() => void) | undefined;
  let sig = "";
  let dismissed = false;
  let manual = false;
  let last: AgentOf | undefined;
  let lastAnswering = false;
  let wasOpen = false;

  function wantsDrawer(view: AgentOf): boolean {
    const forced = view.needsTerm === true || view.prompt?.kind === "multi";
    return (forced && !dismissed) || manual;
  }

  function build(view: AgentOf, answering: boolean): void {
    element.replaceChildren();
    const prompt = view.prompt;
    const head = el("div", "ac-question__head");
    const titleText =
      prompt?.question ?? view.asking?.questions?.[0]?.question ?? t("agentChatNeedsTerm");
    const title = el("strong", "agent-chat__question ac-question__title", titleText);
    title.dir = "auto";
    head.append(title, el("span", "ac-question__flag", t("agentChatNeedsAnswer")));
    element.append(head);

    if (view.asking?.plan !== undefined && view.asking.plan !== "") {
      const plan = el("div", "ac-question__plan");
      for (const block of renderMarkdown(view.asking.plan, options.code)) plan.append(block);
      element.append(plan);
    } else if (prompt?.body !== undefined && prompt.body !== "") {
      const command = renderCode(prompt.body);
      command.classList.add("ac-question__command");
      element.append(command);
    }
    if (view.asking !== undefined) {
      const more = details(view.asking, t, titleText);
      if (more !== undefined) element.append(more);
    }

    const choices = el("div", "agent-chat__options");
    if (prompt?.kind === "single") {
      prompt.options.forEach((option, index) => {
        const button = el("button", "agent-chat__option", `${index + 1} ${option.label}`);
        button.type = "button";
        button.dir = "auto";
        button.dataset["index"] = String(index);
        if (option.highlighted) button.classList.add("ac-primary");
        button.disabled = answering;
        button.addEventListener("click", () => {
          // An Enter or Space meant for something else a moment ago: not an answer.
          if (options.now() - shownAt < ANSWER_GUARD_MS) {
            announce.textContent = t("agentChatQuestionWait");
            cancelAnnounce?.();
            cancelAnnounce = options.schedule(() => {
              announce.textContent = "";
            }, 2000);
            return;
          }
          void options.answer(index, option.label);
        });
        choices.append(button);
      });
    }
    const hint =
      view.needsTerm === true || prompt?.kind === "multi"
        ? t("agentChatQuestionInTerm")
        : undefined;
    if (hint !== undefined) element.append(el("p", "ac-question__hint", hint));

    const terminalButton = el("button", "ac-link-button ac-terminal-button");
    terminalButton.type = "button";
    terminalButton.addEventListener("click", () => {
      const open = drawer.isOpen();
      if (open) {
        dismissed = true;
        manual = false;
      } else {
        dismissed = false;
        manual = true;
      }
      if (last !== undefined) sync(last);
    });
    choices.append(terminalButton);
    const answerTerm = el(
      "button",
      "ac-link-button ac-answer-term",
      t("agentChatAnswerInTerminal"),
    );
    answerTerm.type = "button";
    answerTerm.hidden = true;
    answerTerm.addEventListener("click", () => drawer.focusTerm());
    choices.append(answerTerm);
    const toTerm = el("button", "agent-chat__option ac-to-term", t("agentChatNeedsTermButton"));
    toTerm.type = "button";
    toTerm.hidden = true;
    toTerm.addEventListener("click", () => options.toTerm());
    choices.append(toTerm);
    element.append(choices, announce);
    const slot = el("div", "ac-drawer-slot");
    slot.hidden = true;
    element.append(slot);
  }

  function sync(view: AgentOf): void {
    const slot = element.querySelector<HTMLElement>(".ac-drawer-slot");
    const button = element.querySelector<HTMLButtonElement>(".ac-terminal-button");
    const toTerm = element.querySelector<HTMLButtonElement>(".ac-to-term");
    const answerTerm = element.querySelector<HTMLButtonElement>(".ac-answer-term");
    if (slot === null || button === null || toTerm === null || answerTerm === null) return;
    const want = wantsDrawer(view);
    if (want) {
      slot.hidden = false;
      if (!drawer.isOpen()) {
        // Never takes the keys by itself: someone typing would answer the menu.
        if (!drawer.open(slot)) slot.hidden = true;
      } else drawer.place();
      wasOpen = drawer.isOpen();
    } else {
      slot.hidden = true;
      if (drawer.isOpen()) {
        const hadKeys = drawer.hasFocus();
        drawer.close();
        if (hadKeys) options.focusComposer();
      }
      wasOpen = false;
    }
    // No live terminal to show here: the only way to answer is the Term view.
    toTerm.hidden = !(want && !drawer.isOpen());
    answerTerm.hidden = !drawer.isOpen();
    button.hidden = !drawer.available();
    button.textContent =
      want && drawer.isOpen() ? t("agentChatHideTerminal") : t("agentChatShowTerminal");
    button.setAttribute("aria-expanded", String(want && drawer.isOpen()));
  }

  return {
    element,
    shown: () => !element.hidden,
    update(view, answering) {
      last = view;
      const prompt = view.prompt;
      if (prompt === undefined && view.needsTerm !== true) {
        const hadDrawer = drawer.isOpen() || wasOpen;
        if (drawer.isOpen()) {
          const hadKeys = drawer.hasFocus();
          drawer.close();
          if (hadKeys) options.focusComposer();
        }
        if (hadDrawer) wasOpen = false;
        element.hidden = true;
        element.replaceChildren();
        sig = "";
        dismissed = false;
        manual = false;
        return;
      }
      if (element.hidden) shownAt = options.now();
      element.hidden = false;
      const next = JSON.stringify([
        prompt?.kind,
        prompt?.question,
        prompt?.options.map((option) => option.label),
        view.needsTerm === true,
        view.asking?.id,
      ]);
      if (next !== sig || lastAnswering !== answering) {
        const changed = next !== sig;
        if (changed) {
          shownAt = options.now();
          dismissed = false;
          manual = false;
        }
        sig = next;
        lastAnswering = answering;
        // The slot must be rebuilt only when the question changed: the open
        // drawer is laid over it.
        if (changed || element.childElementCount === 0) {
          if (drawer.isOpen()) drawer.close();
          build(view, answering);
        } else {
          for (const button of element.querySelectorAll<HTMLButtonElement>(
            ".agent-chat__option[data-index]",
          )) {
            button.disabled = answering;
          }
        }
      }
      sync(view);
    },
  };
}
