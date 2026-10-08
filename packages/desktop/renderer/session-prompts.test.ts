// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RendererApi } from "../src/ipc.js";

const menu = {
  question: "Do you want to proceed?",
  options: [
    { label: "Yes", keys: "\r" },
    { label: "No", keys: "\x1b[B\r" },
  ],
};

async function load(api: Partial<RendererApi>) {
  vi.resetModules();
  window.jarvis = api as RendererApi;
  return import("./session-prompts.js");
}

describe("the Dashboard's prompt block", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the agent's question and one button per option once a prompt is read", async () => {
    const { refreshPrompts, promptBlock } = await load({ sessionPrompt: vi.fn(async () => menu) });
    const changed = vi.fn();
    await refreshPrompts(["s1"], changed);
    expect(changed).toHaveBeenCalledTimes(1);

    const block = promptBlock("s1", vi.fn());
    expect(block?.querySelector(".session__prompt-question")?.textContent).toBe(
      "Do you want to proceed?",
    );
    expect([...(block?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
      "Yes",
      "No",
    ]);
  });

  it("does not redraw when nothing changed, and forgets sessions no longer live", async () => {
    const { refreshPrompts, promptBlock } = await load({ sessionPrompt: vi.fn(async () => menu) });
    const changed = vi.fn();
    await refreshPrompts(["s1"], changed);
    await refreshPrompts(["s1"], changed);
    expect(changed).toHaveBeenCalledTimes(1);

    await refreshPrompts([], changed);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(promptBlock("s1", vi.fn())).toBeUndefined();
  });

  it("answers by index and label, and says so when the prompt had changed", async () => {
    const answerSession = vi.fn(async () => ({ ok: false as const, reason: "changed" as const }));
    const { refreshPrompts, promptBlock } = await load({
      sessionPrompt: vi.fn(async () => menu),
      answerSession,
    });
    await refreshPrompts(["s1"], vi.fn());
    const redraw = vi.fn();
    promptBlock("s1", redraw)?.querySelectorAll("button")[1]?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(answerSession).toHaveBeenCalledWith("s1", 1, "No");
    expect(redraw).toHaveBeenCalled();
    expect(promptBlock("s1", vi.fn())?.querySelector(".session__prompt-note")).not.toBeNull();
  });

  it("keeps a click on the block from also opening the session", async () => {
    const { refreshPrompts, promptBlock } = await load({ sessionPrompt: vi.fn(async () => menu) });
    await refreshPrompts(["s1"], vi.fn());
    const row = document.createElement("div");
    const opened = vi.fn();
    row.addEventListener("click", opened);
    const block = promptBlock("s1", vi.fn());
    if (block === undefined) throw new Error("no block");
    row.append(block);
    block.click();
    expect(opened).not.toHaveBeenCalled();
  });
});
