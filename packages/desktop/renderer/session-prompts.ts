import type { PendingPrompt } from "@jarvis/core";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { detectLanguage } from "./format.js";

// What each live session is sitting at, if anything, for the Dashboard's
// session rows: the agent's own question and its own options, each a
// button. Read from main (session:prompt) on a short poll while the
// Dashboard is on screen; answered through session:answer, which reads
// the prompt again and refuses if it is no longer the one shown here.

const prompts = new Map<string, PendingPrompt>();
/** A refusal to show under a row until its prompt next changes. */
const notes = new Map<string, string>();

function same(a: PendingPrompt | undefined, b: PendingPrompt | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Asks main for each session's prompt and keeps the answers. Calls
 * `changed` once if any session's prompt appeared, changed or went away.
 * Sessions not in `ids` are forgotten — an ended session's log can still
 * end at a prompt nobody will ever answer.
 */
export async function refreshPrompts(ids: readonly string[], changed: () => void): Promise<void> {
  let any = false;
  for (const id of [...prompts.keys()]) {
    if (!ids.includes(id)) {
      prompts.delete(id);
      notes.delete(id);
      any = true;
    }
  }
  await Promise.all(
    ids.map(async (id) => {
      let next: PendingPrompt | undefined;
      try {
        next = (await window.jarvis.sessionPrompt(id)) ?? undefined;
      } catch {
        next = undefined;
      }
      if (same(prompts.get(id), next)) return;
      any = true;
      notes.delete(id);
      if (next === undefined) prompts.delete(id);
      else prompts.set(id, next);
    }),
  );
  if (any) changed();
}

/** The block under a session row: the question and one button per option.
 *  Undefined when the session is at no readable prompt. */
export function promptBlock(sessionId: string, changed: () => void): HTMLElement | undefined {
  const prompt = prompts.get(sessionId);
  if (prompt === undefined) return undefined;
  const block = document.createElement("div");
  block.className = "session__prompt";
  // Clicks here answer the agent; they must not also open the transcript
  // the row itself opens.
  block.addEventListener("click", (event) => event.stopPropagation());

  const question = document.createElement("div");
  question.className = "session__prompt-question";
  question.dir = detectLanguage(prompt.question) === "ar" ? "rtl" : "ltr";
  question.textContent = prompt.question;
  block.append(question);

  const options = document.createElement("div");
  options.className = "session__prompt-options";
  prompt.options.forEach((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session__prompt-option";
    button.dir = "auto";
    button.textContent = option.label;
    button.addEventListener("click", () => {
      for (const other of options.querySelectorAll("button")) other.disabled = true;
      void window.jarvis
        .answerSession(sessionId, index, option.label)
        .then((result) => {
          if (result.ok) {
            // Gone from here at once; the next poll confirms it.
            prompts.delete(sessionId);
          } else {
            notes.set(sessionId, MESSAGES.promptChanged(PRIMARY_LANGUAGE));
          }
          changed();
        })
        .catch(() => {
          notes.set(sessionId, MESSAGES.promptChanged(PRIMARY_LANGUAGE));
          changed();
        });
    });
    options.append(button);
  });
  block.append(options);

  const note = notes.get(sessionId);
  if (note !== undefined) {
    const line = document.createElement("div");
    line.className = "session__prompt-note";
    line.textContent = note;
    block.append(line);
  }
  return block;
}
