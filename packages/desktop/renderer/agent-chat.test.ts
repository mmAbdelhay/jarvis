// @vitest-environment jsdom
//
// The Chat | Term switch and the chat itself. The api, the clock and the
// pane's own view switch are doubled; what is under test is when the switch
// shows, what the chat draws (as text, never markup), and what a send or an
// answer is allowed to do.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentView } from "../src/agent-view.js";
import { MESSAGES, type MessageKey } from "../src/messages.js";
import { createAgentChat, type AgentChatOptions } from "./agent-chat.js";

type AgentOf = Extract<AgentView, { kind: "agent" }>;

const NONE: AgentView = { kind: "none" };

function agentView(overrides: Partial<AgentOf> = {}): AgentOf {
  return {
    kind: "agent",
    vendor: "anthropic",
    sessionId: "s1",
    model: "claude-x",
    mode: "plan",
    turns: [
      { role: "user", text: "fix the build", tools: [] },
      {
        role: "assistant",
        text: "On it. **Done** with `code`.",
        tools: [{ name: "Edit", target: "app.ts", added: 3, removed: 1 }],
      },
    ],
    ...overrides,
  };
}

/** A clock the test steps by hand. */
function clock() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 0;
  return {
    schedule: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return () => void timers.delete(id);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const t = (key: MessageKey): string => (MESSAGES[key] as (l: "en" | "ar") => string)("en");

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    store,
  };
}

function setup(
  overrides: Partial<AgentChatOptions> = {},
  view: AgentView | (() => AgentView) = NONE,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const timers = clock();
  const current = { view };
  const api = {
    terminalAgentView: vi.fn(async () =>
      typeof current.view === "function" ? current.view() : current.view,
    ),
    terminalAgentAnswer: vi.fn(async () => ({ ok: true as const })),
    terminalAgentSend: vi.fn(async (_paneKey: string, _text: string) => ({
      ok: true as const,
    })) as unknown as AgentChatOptions["api"]["terminalAgentSend"],
    plansOpenLink: vi.fn(async () => undefined),
  };
  const setChatView = vi.fn();
  const focusTerm = vi.fn();
  const storage = memoryStorage();
  const chat = createAgentChat({
    paneKey: "t1",
    host,
    api,
    t,
    setChatView,
    focusTerm,
    chatKey: () => true,
    schedule: timers.schedule,
    storage,
    isShown: () => true,
    ...overrides,
  });
  const q = <T extends Element>(selector: string): T => {
    const found = host.querySelector<T>(selector);
    if (found === null) throw new Error(`missing ${selector}`);
    return found;
  };
  return { host, api, chat, timers, setChatView, focusTerm, storage, q, current };
}

function tab(host: HTMLElement, mode: "chat" | "term"): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>(`[role="tab"][data-mode="${mode}"]`);
  if (found === null) throw new Error("no tab");
  return found;
}

const switchShown = (host: HTMLElement): boolean =>
  !host.querySelector<HTMLElement>(".agent-bar")?.hidden;

beforeEach(() => {
  document.body.replaceChildren();
});

describe("detecting an agent", () => {
  it("shows no switch until an agent is found, asking at 1s, 3s and 8s after a command starts", async () => {
    const s = setup();
    expect(switchShown(s.host)).toBe(false);
    s.chat.commandStarted();
    s.timers.advance(999);
    expect(s.api.terminalAgentView).not.toHaveBeenCalled();
    s.timers.advance(1);
    await settle();
    expect(s.api.terminalAgentView).toHaveBeenCalledTimes(1);
    s.timers.advance(2000);
    await settle();
    s.timers.advance(5000);
    await settle();
    expect(s.api.terminalAgentView).toHaveBeenCalledTimes(3);
    expect(switchShown(s.host)).toBe(false);
  });

  it("stops asking at the first agent and shows the switch on Term", async () => {
    const s = setup({}, agentView());
    s.chat.commandStarted();
    s.timers.advance(1000);
    await settle();
    expect(switchShown(s.host)).toBe(true);
    expect(tab(s.host, "term").getAttribute("aria-selected")).toBe("true");
    s.timers.advance(10000);
    await settle();
    expect(s.api.terminalAgentView).toHaveBeenCalledTimes(1);
    expect(s.setChatView).not.toHaveBeenCalledWith(true, expect.anything());
  });

  it("asks when the pane regains focus and refreshes on a push, only once an agent is known", async () => {
    const s = setup({}, NONE);
    s.chat.refresh();
    await settle();
    expect(s.api.terminalAgentView).not.toHaveBeenCalled();
    s.chat.focused();
    await settle();
    expect(s.api.terminalAgentView).toHaveBeenCalledTimes(1);
    s.current.view = agentView();
    s.chat.focused();
    await settle();
    s.chat.refresh();
    await settle();
    expect(s.api.terminalAgentView).toHaveBeenCalledTimes(3);
  });

  it("does not refresh a pane that is not showing", async () => {
    let shown = true;
    const s = setup({ isShown: () => shown }, agentView());
    s.chat.focused();
    await settle();
    shown = false;
    s.chat.refresh();
    s.chat.focused();
    await settle();
    expect(s.api.terminalAgentView).toHaveBeenCalledTimes(1);
  });

  it("looks for an agent after a reload while a command is running", async () => {
    const s = setup({ isRunning: () => true });
    s.timers.advance(1500);
    s.timers.advance(1000);
    await settle();
    expect(s.api.terminalAgentView).toHaveBeenCalled();
    const idle = setup({ isRunning: () => false });
    idle.timers.advance(20000);
    await settle();
    expect(idle.api.terminalAgentView).not.toHaveBeenCalled();
  });

  it("a none reply hides the switch and returns to Term", async () => {
    const s = setup({}, agentView());
    s.chat.focused();
    await settle();
    tab(s.host, "chat").click();
    expect(s.setChatView).toHaveBeenLastCalledWith(true, expect.any(Function));
    s.current.view = NONE;
    s.chat.refresh();
    await settle();
    expect(switchShown(s.host)).toBe(false);
    expect(s.setChatView).toHaveBeenLastCalledWith(false, undefined);
    expect(s.q<HTMLElement>(".agent-chat").hidden).toBe(true);
  });

  it("keeps looking every 10s while the command runs, the pane shows and the document is visible", async () => {
    let running = true;
    let shown = true;
    const s = setup({ isRunning: () => running, isShown: () => shown });
    s.timers.advance(1500); // the reload check starts the looks afresh
    for (const ms of [1000, 2000, 5000]) {
      s.timers.advance(ms);
      await settle();
    }
    expect(s.api.terminalAgentView).toHaveBeenCalledTimes(3);
    s.timers.advance(10000);
    await settle();
    expect(s.api.terminalAgentView).toHaveBeenCalledTimes(4);
    shown = false;
    s.timers.advance(10000);
    await settle();
    expect(s.api.terminalAgentView).toHaveBeenCalledTimes(4);
    shown = true;
    s.current.view = agentView();
    s.timers.advance(10000);
    await settle();
    expect(s.api.terminalAgentView).toHaveBeenCalledTimes(5);
    expect(switchShown(s.host)).toBe(true);
    s.timers.advance(60000);
    await settle();
    expect(s.api.terminalAgentView).toHaveBeenCalledTimes(5);
    expect(s.timers.pending()).toBe(0);
    running = false;
  });

  it("stops looking when the command ends or the pane is disposed", async () => {
    let running = true;
    const s = setup({ isRunning: () => running });
    s.chat.commandStarted();
    s.timers.advance(8000);
    await settle();
    running = false;
    s.timers.advance(10000);
    await settle();
    const calls = s.api.terminalAgentView.mock.calls.length;
    s.timers.advance(60000);
    await settle();
    expect(s.api.terminalAgentView.mock.calls.length).toBe(calls);
    const other = setup({ isRunning: () => true });
    other.chat.commandStarted();
    other.timers.advance(8000);
    other.chat.dispose();
    expect(other.timers.pending()).toBe(0);
  });

  describe("an agent that goes missing from a reply", () => {
    async function inChat(overrides: Partial<AgentChatOptions> = {}) {
      const s = setup(overrides, agentView());
      s.chat.focused();
      await settle();
      tab(s.host, "chat").click();
      return s;
    }

    it("keeps Chat and the draft on one none while the command runs, drops to Term on a second", async () => {
      const s = await inChat({ isRunning: () => true });
      s.q<HTMLTextAreaElement>(".agent-chat__input").value = "my draft";
      s.current.view = NONE;
      s.chat.refresh();
      await settle();
      expect(switchShown(s.host)).toBe(true);
      expect(s.q<HTMLElement>(".agent-chat").hidden).toBe(false);
      s.timers.advance(1999);
      await settle();
      expect(switchShown(s.host)).toBe(true);
      s.timers.advance(1);
      await settle();
      expect(switchShown(s.host)).toBe(false);
      expect(s.q<HTMLElement>(".agent-chat").hidden).toBe(true);
      expect(s.q<HTMLTextAreaElement>(".agent-chat__input").value).toBe("my draft");
    });

    it("stays in Chat when the re-ask finds the agent again", async () => {
      const s = await inChat({ isRunning: () => true });
      s.current.view = NONE;
      s.chat.refresh();
      await settle();
      s.current.view = agentView();
      s.timers.advance(2000);
      await settle();
      s.current.view = NONE;
      s.chat.refresh();
      await settle();
      expect(switchShown(s.host)).toBe(true);
      s.timers.advance(2000);
      await settle();
      expect(switchShown(s.host)).toBe(false);
    });

    it("treats a failed read like a none", async () => {
      const s = await inChat({ isRunning: () => true });
      s.api.terminalAgentView.mockRejectedValue(new Error("main"));
      s.chat.refresh();
      await settle();
      expect(switchShown(s.host)).toBe(true);
      s.timers.advance(2000);
      await settle();
      expect(switchShown(s.host)).toBe(false);
    });
  });

  it("ignores a reply that arrives after dispose", async () => {
    const s = setup({}, agentView());
    s.chat.focused();
    s.chat.dispose();
    await settle();
    expect(s.host.querySelector(".agent-bar")).toBeNull();
  });
});

describe("the switch", () => {
  it("is a tablist, defaults to Term, and moves with the arrow keys", async () => {
    const s = setup({}, agentView());
    s.chat.focused();
    await settle();
    const list = s.q<HTMLElement>('[role="tablist"]');
    expect(list.getAttribute("aria-label")).toBe("Agent view");
    expect(tab(s.host, "term").tabIndex).toBe(0);
    expect(tab(s.host, "chat").tabIndex).toBe(-1);
    tab(s.host, "term").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    expect(tab(s.host, "chat").getAttribute("aria-selected")).toBe("true");
    expect(tab(s.host, "chat").tabIndex).toBe(0);
    expect(document.activeElement).toBe(tab(s.host, "chat"));
    expect(s.q<HTMLElement>(".agent-chat").hidden).toBe(false);
    tab(s.host, "chat").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(tab(s.host, "term").getAttribute("aria-selected")).toBe("true");
    expect(s.q<HTMLElement>(".agent-chat").hidden).toBe(true);
  });

  it("remembers the last chosen mode and applies it when an agent is next detected", async () => {
    const first = setup({}, agentView());
    first.chat.focused();
    await settle();
    tab(first.host, "chat").click();
    expect(first.storage.store.get("jarvis.agentChatMode")).toBe("chat");

    const second = setup({ storage: first.storage }, agentView());
    second.chat.focused();
    await settle();
    expect(tab(second.host, "chat").getAttribute("aria-selected")).toBe("true");
    expect(second.setChatView).toHaveBeenCalledWith(true, expect.any(Function));

    tab(second.host, "term").click();
    expect(first.storage.store.get("jarvis.agentChatMode")).toBe("term");
  });

  it("still works when storage throws", async () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const s = setup({ storage: broken }, agentView());
    s.chat.focused();
    await settle();
    tab(s.host, "chat").click();
    expect(tab(s.host, "chat").getAttribute("aria-selected")).toBe("true");
  });
});

describe("the chat", () => {
  async function open(view: AgentView = agentView(), overrides: Partial<AgentChatOptions> = {}) {
    const s = setup(overrides, view);
    s.chat.focused();
    await settle();
    tab(s.host, "chat").click();
    return s;
  }

  it("draws the header, the feed oldest to newest, tool rows and the working line", async () => {
    const s = await open(agentView({ title: "my session", working: "Crunching… 5s" }));
    const head = s.q<HTMLElement>(".agent-chat__head").textContent ?? "";
    expect(head).toContain("Claude Code");
    expect(head).toContain("claude-x");
    expect(head).toContain("Plan");
    expect(head).toContain("my session");
    const rows = [...s.host.querySelectorAll(".agent-chat__feed > *")].map((row) => row.className);
    expect(rows[0]).toContain("agent-chat__row--user");
    expect(rows[1]).toContain("agent-chat__row--tool");
    expect(rows[2]).toContain("agent-chat__row--text");
    expect(rows.at(-1)).toContain("agent-chat__row--working");
    const tool = s.q<HTMLElement>(".agent-chat__row--tool").textContent ?? "";
    expect(tool).toContain("Edit");
    expect(tool).toContain("app.ts");
    expect(tool).toContain("+3");
    expect(tool).toContain("−1");
    expect(s.q<HTMLElement>(".agent-chat__row--working").textContent).toContain("Crunching… 5s");
    expect(s.q("strong").textContent).toBe("Done");
    expect(s.q("p code").textContent).toBe("code");
  });

  it("names Copilot and Codex, shows no mode for them, and a localised working line", async () => {
    const s = await open(agentView({ vendor: "openai", mode: undefined, working: "Working…" }));
    const head = s.q<HTMLElement>(".agent-chat__head").textContent ?? "";
    expect(head).toContain("Codex");
    expect(head).not.toContain("Plan");
    expect(s.q<HTMLElement>(".agent-chat__row--working").textContent).toBe("Working…");
    expect(s.q<HTMLElement>(".agent-chat__head [data-field='mode']").hidden).toBe(true);
  });

  it("renders hostile text as text and creates no elements from it", async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script> **<b>x</b>**';
    const s = await open(
      agentView({
        title: "<b>t</b>",
        model: "<i>m</i>",
        turns: [
          { role: "user", text: hostile, tools: [] },
          { role: "assistant", text: hostile, tools: [{ name: "<u>n</u>", target: "<s>t</s>" }] },
        ],
      }),
    );
    const chat = s.q<HTMLElement>(".agent-chat");
    expect(chat.querySelector("img, script, u, s, i")).toBeNull();
    expect(chat.querySelectorAll("b")).toHaveLength(0);
    expect(chat.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(chat.textContent).toContain("<script>alert(2)</script>");
    expect(chat.querySelector(".agent-chat__bubble")?.textContent).toBe(hostile);
  });

  it("sets dir=auto on each text block", async () => {
    const s = await open(
      agentView({ turns: [{ role: "assistant", text: "مرحبا\n\n- نقطة", tools: [] }] }),
    );
    for (const block of s.host.querySelectorAll(
      ".agent-chat__row--text p, .agent-chat__row--text [role='listitem']",
    )) {
      expect(block.getAttribute("dir")).toBe("auto");
    }
    expect(s.host.querySelectorAll(".agent-chat__row--text p").length).toBeGreaterThan(0);
  });

  it("opens only https links, through the safe external path, showing the real host", async () => {
    const text = [
      "[docs](https://claude.ai/docs)",
      "[bad](javascript:alert(1)) [plain](http://example.com) http://x.test",
      "[file](file:///etc/passwd) javascript:alert(3)",
    ].join("\n");
    const s = await open(agentView({ turns: [{ role: "assistant", text, tools: [] }] }));
    const anchors = [...s.host.querySelectorAll<HTMLAnchorElement>("a")];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.textContent).toBe("docs");
    expect(s.q(".agent-chat__host").textContent).toContain("claude.ai");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchors[0]?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(s.api.plansOpenLink).toHaveBeenCalledWith("https://claude.ai/docs");
    expect(s.host.textContent).toContain("javascript:alert(1)");
    expect(s.host.textContent).toContain("http://example.com");
  });

  it("does not rebuild unchanged rows on a refresh, and appends only the new one", async () => {
    const s = await open();
    const before = [...s.host.querySelectorAll(".agent-chat__feed > *")];
    s.current.view = agentView({
      turns: [...agentView().turns, { role: "assistant", text: "More.", tools: [] }],
    });
    s.chat.refresh();
    await settle();
    const after = [...s.host.querySelectorAll(".agent-chat__feed > *")];
    expect(after.length).toBe(before.length + 1);
    for (const row of before) expect(after).toContain(row);
  });

  it("replaces only a row whose content changed", async () => {
    const s = await open();
    const before = [...s.host.querySelectorAll(".agent-chat__feed > *")];
    s.current.view = agentView({
      turns: [
        agentView().turns[0],
        {
          role: "assistant",
          text: "Changed.",
          tools: [{ name: "Edit", target: "app.ts", added: 3, removed: 1 }],
        },
      ] as AgentOf["turns"],
    });
    s.chat.refresh();
    await settle();
    const after = [...s.host.querySelectorAll(".agent-chat__feed > *")];
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect(after[2]?.textContent).toContain("Changed.");
  });

  it("keeps the feed at the bottom only when it was already there", async () => {
    const s = await open();
    const feed = s.q<HTMLElement>(".agent-chat__feed");
    const geometry = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    for (const key of Object.keys(geometry) as (keyof typeof geometry)[]) {
      Object.defineProperty(feed, key, {
        configurable: true,
        get: () => geometry[key],
        set: (value: number) => {
          geometry[key] = value;
        },
      });
    }
    s.current.view = agentView({
      turns: [...agentView().turns, { role: "user", text: "next", tools: [] }],
    });
    s.chat.refresh();
    await settle();
    expect(feed.scrollTop).toBe(1000);

    geometry.scrollTop = 100; // the user scrolled up to read
    s.current.view = agentView({
      turns: [...agentView().turns, { role: "user", text: "later", tools: [] }],
    });
    s.chat.refresh();
    await settle();
    expect(feed.scrollTop).toBe(100);
  });

  describe("a pending question", () => {
    const asking = () =>
      agentView({
        prompt: {
          question: "Do you want to proceed?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      });

    it("shows a card with one button per option and disables the composer", async () => {
      const s = await open(asking());
      const card = s.q<HTMLElement>(".agent-chat__prompt");
      expect(card.hidden).toBe(false);
      expect(card.textContent).toContain("Do you want to proceed?");
      const buttons = [...card.querySelectorAll("button")];
      expect(buttons.map((b) => b.textContent)).toEqual(["Yes", "No"]);
      expect(s.q<HTMLTextAreaElement>(".agent-chat__input").disabled).toBe(true);
      expect(s.q<HTMLButtonElement>(".agent-chat__send").disabled).toBe(true);
    });

    it("answers by index and label, then looks again", async () => {
      const s = await open(asking());
      const calls = s.api.terminalAgentView.mock.calls.length;
      s.host.querySelectorAll<HTMLButtonElement>(".agent-chat__prompt button")[1]?.click();
      await settle();
      expect(s.api.terminalAgentAnswer).toHaveBeenCalledWith("t1", 1, "No");
      expect(s.api.terminalAgentView.mock.calls.length).toBeGreaterThan(calls);
    });

    it("says so when the question changed or is gone", async () => {
      const s = await open(asking());
      s.api.terminalAgentAnswer.mockResolvedValueOnce({ ok: false, reason: "changed" } as never);
      s.host.querySelector<HTMLButtonElement>(".agent-chat__prompt button")?.click();
      await settle();
      expect(s.q(".agent-chat__note").textContent).toBe(t("agentChatAnswerChanged"));
      s.api.terminalAgentAnswer.mockResolvedValueOnce({ ok: false, reason: "gone" } as never);
      s.host.querySelector<HTMLButtonElement>(".agent-chat__prompt button")?.click();
      await settle();
      expect(s.q(".agent-chat__note").textContent).toBe(t("agentChatAnswerGone"));
    });

    it("keeps the card's buttons across a refresh and drops the card when the question goes", async () => {
      const s = await open(asking());
      const button = s.q<HTMLButtonElement>(".agent-chat__prompt button");
      s.chat.refresh();
      await settle();
      expect(s.q(".agent-chat__prompt button")).toBe(button);
      s.current.view = agentView();
      s.chat.refresh();
      await settle();
      expect(s.q<HTMLElement>(".agent-chat__prompt").hidden).toBe(true);
      expect(s.q<HTMLTextAreaElement>(".agent-chat__input").disabled).toBe(false);
    });
  });

  describe("a menu only the terminal can answer", () => {
    it("shows a card with a button to Term and locks the composer", async () => {
      const s = await open(agentView({ needsTerm: true }));
      const card = s.q<HTMLElement>(".agent-chat__prompt");
      expect(card.hidden).toBe(false);
      expect(card.textContent).toContain("The agent is asking something. Answer it in Term.");
      expect(s.q<HTMLTextAreaElement>(".agent-chat__input").disabled).toBe(true);
      card.querySelector<HTMLButtonElement>("button")?.click();
      expect(tab(s.host, "term").getAttribute("aria-selected")).toBe("true");
      expect(s.q<HTMLElement>(".agent-chat").hidden).toBe(true);
      expect(s.focusTerm).toHaveBeenCalled();
    });

    it("goes away when the menu does", async () => {
      const s = await open(agentView({ needsTerm: true }));
      s.current.view = agentView();
      s.chat.refresh();
      await settle();
      expect(s.q<HTMLElement>(".agent-chat__prompt").hidden).toBe(true);
      expect(s.q<HTMLTextAreaElement>(".agent-chat__input").disabled).toBe(false);
    });

    it("has Arabic text", () => {
      expect((MESSAGES.agentChatNeedsTerm as (l: "en" | "ar") => string)("ar")).not.toBe(
        (MESSAGES.agentChatNeedsTerm as (l: "en" | "ar") => string)("en"),
      );
    });
  });

  describe("the composer", () => {
    const type = (s: Awaited<ReturnType<typeof open>>, text: string) => {
      s.q<HTMLTextAreaElement>(".agent-chat__input").value = text;
    };
    const enter = (s: Awaited<ReturnType<typeof open>>, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      s.q(".agent-chat__input").dispatchEvent(event);
      return event;
    };

    it("sends on Enter, clears the box and looks again", async () => {
      const s = await open();
      type(s, "run the tests");
      const event = enter(s);
      expect(event.defaultPrevented).toBe(true);
      await settle();
      expect(s.api.terminalAgentSend).toHaveBeenCalledWith("t1", "run the tests");
      expect(s.q<HTMLTextAreaElement>(".agent-chat__input").value).toBe("");
    });

    it("leaves Shift+Enter and IME composition alone", async () => {
      const s = await open();
      type(s, "line one");
      const shifted = enter(s, { shiftKey: true });
      expect(shifted.defaultPrevented).toBe(false);
      enter(s, { isComposing: true });
      await settle();
      expect(s.api.terminalAgentSend).not.toHaveBeenCalled();
    });

    it("does not send an empty message", async () => {
      const s = await open();
      type(s, "   ");
      enter(s);
      await settle();
      expect(s.api.terminalAgentSend).not.toHaveBeenCalled();
    });

    it("keeps the text and says why when a send is refused", async () => {
      const s = await open();
      const send = s.api.terminalAgentSend as unknown as ReturnType<typeof vi.fn>;
      for (const [reason, key] of [
        ["prompt", "agentChatSendPrompt"],
        ["gone", "agentChatSendGone"],
        ["invalid", "agentChatSendInvalid"],
      ] as const) {
        send.mockResolvedValueOnce({ ok: false, reason });
        type(s, "keep me");
        enter(s);
        await settle();
        expect(s.q<HTMLTextAreaElement>(".agent-chat__input").value).toBe("keep me");
        expect(s.q(".agent-chat__note").textContent).toBe(t(key as MessageKey));
      }
      send.mockRejectedValueOnce(new Error("ipc"));
      enter(s);
      await settle();
      expect(s.q<HTMLTextAreaElement>(".agent-chat__input").value).toBe("keep me");
      expect(s.q(".agent-chat__note").textContent).toBe(t("agentChatSendFailed"));
    });

    it("is disabled while sending, and sends once", async () => {
      const s = await open();
      let release: (value: { ok: true }) => void = () => {};
      (s.api.terminalAgentSend as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () => new Promise((resolve) => (release = resolve)),
      );
      type(s, "once");
      enter(s);
      expect(s.q<HTMLButtonElement>(".agent-chat__send").disabled).toBe(true);
      enter(s);
      release({ ok: true });
      await settle();
      expect(s.api.terminalAgentSend).toHaveBeenCalledTimes(1);
      expect(s.q<HTMLButtonElement>(".agent-chat__send").disabled).toBe(false);
    });

    it("sends from the Send button too", async () => {
      const s = await open();
      type(s, "via button");
      s.q<HTMLButtonElement>(".agent-chat__send").click();
      await settle();
      expect(s.api.terminalAgentSend).toHaveBeenCalledWith("t1", "via button");
    });

    it("hands keys to the pane first, so the palette and splits keep working", async () => {
      const chatKey = vi.fn((event: KeyboardEvent) => event.key !== "p");
      const s = await open(agentView(), { chatKey });
      const claimed = new KeyboardEvent("keydown", {
        key: "p",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      s.q(".agent-chat__input").dispatchEvent(claimed);
      expect(chatKey).toHaveBeenCalled();
      expect(claimed.defaultPrevented).toBe(false);
      type(s, "x");
      const enterKey = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      s.q(".agent-chat__input").dispatchEvent(enterKey);
      await settle();
      expect(s.api.terminalAgentSend).toHaveBeenCalledTimes(1);
    });

    it("never writes a key to anything but agentSend and agentAnswer", async () => {
      const s = await open();
      s.q(".agent-chat__input").dispatchEvent(
        new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }),
      );
      s.q(".agent-chat__input").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      );
      await settle();
      expect(s.api.terminalAgentSend).not.toHaveBeenCalled();
      expect(s.api.terminalAgentAnswer).not.toHaveBeenCalled();
    });
  });
});

describe("going back to Term", () => {
  it("hands the keys back to the terminal only when the chat had them", async () => {
    const s = setup({}, agentView());
    s.chat.focused();
    await settle();
    tab(s.host, "chat").click();
    s.q<HTMLTextAreaElement>(".agent-chat__input").focus();
    tab(s.host, "term").click();
    expect(s.setChatView).toHaveBeenLastCalledWith(false, undefined);
    expect(s.focusTerm).toHaveBeenCalledTimes(1);
  });
});
