// @vitest-environment jsdom
//
// The Chat | Term switch and the chat's frame. The api, the clock and the
// pane's own view switch are doubled; what is under test is when the switch
// shows, what the chat draws (as text, never markup), and what a send or an
// answer is allowed to do. The parts have their own files in agent-chat/.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGES } from "../src/messages.js";
import type { AgentChatOptions } from "./agent-chat.js";
import {
  agentView,
  NONE,
  open,
  reply,
  setup,
  settle,
  t,
  tab,
  tool,
  user,
} from "./agent-chat/fixture.js";

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
    expect(s.api.terminalAgentChat).not.toHaveBeenCalled();
    s.timers.advance(1);
    await settle();
    expect(s.api.terminalAgentChat).toHaveBeenCalledTimes(1);
    s.timers.advance(2000);
    await settle();
    s.timers.advance(5000);
    await settle();
    expect(s.api.terminalAgentChat).toHaveBeenCalledTimes(3);
    expect(switchShown(s.host)).toBe(false);
  });

  it("stops asking at the first agent and shows the switch on Term", async () => {
    const s = setup({}, agentView());
    s.chat.commandStarted();
    s.timers.advance(1000);
    await settle();
    expect(switchShown(s.host)).toBe(true);
    expect(tab(s.host, "term").getAttribute("aria-selected")).toBe("true");
    // Detection has stopped; only the shown agent's own 10 s check looks again.
    s.timers.advance(10000);
    await settle();
    expect(s.api.terminalAgentChat).toHaveBeenCalledTimes(2);
    expect(s.setChatView).not.toHaveBeenCalledWith(true, expect.anything());
  });

  it("asks when the pane regains focus and refreshes on a push, only once an agent is known", async () => {
    const s = setup({}, NONE);
    s.chat.refresh();
    await settle();
    expect(s.api.terminalAgentChat).not.toHaveBeenCalled();
    s.chat.focused();
    await settle();
    expect(s.api.terminalAgentChat).toHaveBeenCalledTimes(1);
    s.current.view = agentView();
    s.chat.focused();
    await settle();
    s.chat.refresh();
    await settle();
    expect(s.api.terminalAgentChat).toHaveBeenCalledTimes(3);
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
    expect(s.api.terminalAgentChat).toHaveBeenCalledTimes(1);
  });

  it("looks for an agent after a reload while a command is running", async () => {
    const s = setup({ isRunning: () => true });
    s.timers.advance(1500);
    s.timers.advance(1000);
    await settle();
    expect(s.api.terminalAgentChat).toHaveBeenCalled();
    const idle = setup({ isRunning: () => false });
    idle.timers.advance(20000);
    await settle();
    expect(idle.api.terminalAgentChat).not.toHaveBeenCalled();
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
    expect(s.api.terminalAgentChat).toHaveBeenCalledTimes(3);
    s.timers.advance(10000);
    await settle();
    expect(s.api.terminalAgentChat).toHaveBeenCalledTimes(4);
    shown = false;
    s.timers.advance(10000);
    await settle();
    expect(s.api.terminalAgentChat).toHaveBeenCalledTimes(4);
    shown = true;
    s.current.view = agentView();
    s.timers.advance(10000);
    await settle();
    expect(s.api.terminalAgentChat).toHaveBeenCalledTimes(5);
    expect(switchShown(s.host)).toBe(true);
    // Detection is over: what is left is the shown agent's own 10 s check.
    s.timers.advance(60000);
    await settle();
    expect(s.api.terminalAgentChat).toHaveBeenCalledTimes(6);
    expect(s.timers.pending()).toBe(1);
    running = false;
  });

  it("looks again when the window gets focus back, only for a pane that runs something", async () => {
    const s = setup({ isRunning: () => true });
    s.current.view = agentView();
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(switchShown(s.host)).toBe(true);
    const idle = setup({ isRunning: () => false });
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(idle.api.terminalAgentChat).not.toHaveBeenCalled();
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
    const calls = s.api.terminalAgentChat.mock.calls.length;
    s.timers.advance(60000);
    await settle();
    expect(s.api.terminalAgentChat.mock.calls.length).toBe(calls);
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
      s.api.terminalAgentChat.mockRejectedValue(new Error("main"));
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

describe("the chat's frame", () => {
  it("shows the agent, title, model and mode, and labels the feed as a log", async () => {
    const s = await open(agentView({ title: "my session", working: "Crunching… 5s" }));
    const bar = s.q<HTMLElement>(".agent-bar").textContent ?? "";
    expect(bar).toContain("my session");
    expect(bar).toContain("Claude Code");
    const composer = s.q<HTMLElement>(".ac-composer").textContent ?? "";
    expect(composer).toContain("Opus 4.5");
    expect(composer).toContain("Plan");
    const feed = s.q<HTMLElement>(".agent-chat__feed");
    expect(feed.getAttribute("role")).toBe("log");
    expect(feed.getAttribute("aria-label")).toBe(t("agentChatFeedLabel"));
    expect(feed.tabIndex).toBe(0);
    expect(s.q<HTMLElement>(".ac-working").textContent).toContain("Crunching… 5s");
  });

  it("names Copilot and Codex, shows no mode button for them, and a localised working line", async () => {
    const s = await open(
      agentView({
        vendor: "openai",
        mode: undefined,
        working: "Working…",
        caps: { ...agentView().caps, mode: false, model: "menu", queue: false },
      }),
    );
    expect(s.q<HTMLElement>(".agent-bar").textContent).toContain("Codex");
    expect(s.q<HTMLElement>(".ac-modebutton").hidden).toBe(true);
    expect(s.q<HTMLElement>(".ac-working").textContent).toContain("Working…");
  });

  it("renders hostile text as text and creates no elements from it", async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script> **<b>x</b>**';
    const s = await open(
      agentView({
        title: "<b>t</b>",
        model: "<i>m</i>",
        page: {
          items: [
            user("u1", hostile),
            reply("a1", hostile),
            tool("t1", "<u>n</u>", { target: "<s>t</s>", output: "<em>out</em>" }),
          ],
        },
      }),
    );
    const chat = s.q<HTMLElement>(".agent-chat");
    expect(chat.querySelector("img, script, u, s, i, em")).toBeNull();
    expect(chat.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(chat.textContent).toContain("<script>alert(2)</script>");
    expect(chat.querySelector(".agent-chat__bubble")?.textContent).toBe(hostile);
    expect(s.q<HTMLElement>(".agent-bar").textContent).toContain("<b>t</b>");
  });

  it("sets dir=auto on each text block", async () => {
    const s = await open(agentView({ page: { items: [reply("a1", "مرحبا\n\n- نقطة")] } }));
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
    const s = await open(agentView({ page: { items: [reply("a1", text)] } }));
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

  it("a read that failed keeps the view and says so, then clears the note", async () => {
    const s = await open();
    const before = [...s.host.querySelectorAll(".ac-column > .ac-row")];
    s.current.view = agentView({ readFailed: true, page: { items: [] } });
    s.chat.refresh();
    await settle();
    expect(s.q(".agent-chat__note").textContent).toBe(t("agentChatReadFailed"));
    expect(switchShown(s.host)).toBe(true);
    expect([...s.host.querySelectorAll(".ac-column > .ac-row")]).toEqual(before);
    s.current.view = agentView();
    s.chat.refresh();
    await settle();
    expect(s.q<HTMLElement>(".agent-chat__note").hidden).toBe(true);
  });

  it("carries the tab toolbar's Reviews and menu in its header row when the tab gives them", async () => {
    const reviews = vi.fn();
    const menu = vi.fn();
    const s = await open(agentView(), { toolbar: { reviews, menu } });
    s.q<HTMLButtonElement>(".ac-bar__reviews").click();
    s.q<HTMLButtonElement>(".ac-bar__menu").click();
    expect(reviews).toHaveBeenCalledTimes(1);
    expect(menu).toHaveBeenCalledTimes(1);
    const none = await open(agentView());
    expect(none.host.querySelector(".ac-bar__reviews")).toBeNull();
  });

  it("shows the file toggle when the tab gives one, and calls it", async () => {
    const toggleFiles = vi.fn();
    const s = await open(agentView(), { toggleFiles });
    s.q<HTMLButtonElement>(".ac-files-toggle").click();
    expect(toggleFiles).toHaveBeenCalledTimes(1);
  });
});

describe("an agent that left while the pane was rebuilt", () => {
  async function inChat(overrides: Partial<AgentChatOptions> = {}) {
    const s = setup(overrides, agentView());
    s.chat.focused();
    await settle();
    tab(s.host, "chat").click();
    return s;
  }

  it("leaves Chat when the command ends, with no push needed", async () => {
    const s = await inChat({ isRunning: () => false });
    s.current.view = NONE;
    s.chat.commandEnded();
    await settle();
    expect(switchShown(s.host)).toBe(false);
    expect(s.q<HTMLElement>(".agent-chat").hidden).toBe(true);
  });

  it("leaves Chat at once when a send answers gone, even if the shell still reads as running", async () => {
    const s = await inChat({ isRunning: () => true });
    s.current.view = NONE;
    (s.api.terminalAgentSend as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "gone",
    });
    const input = s.q<HTMLTextAreaElement>(".agent-chat__input");
    input.value = "hello";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await settle();
    await settle();
    expect(switchShown(s.host)).toBe(false);
    expect(input.value).toBe("hello");
  });

  it("checks every 10 s while it shows an agent, so a lost push cannot strand it", async () => {
    const s = await inChat({ isRunning: () => false });
    const calls = s.api.terminalAgentChat.mock.calls.length;
    s.current.view = NONE;
    s.timers.advance(10_000);
    await settle();
    expect(s.api.terminalAgentChat.mock.calls.length).toBe(calls + 1);
    expect(switchShown(s.host)).toBe(false);
    expect(s.timers.pending()).toBe(0);
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

describe("the messages", () => {
  it("has Arabic text for every chat string that is new", () => {
    for (const key of Object.keys(MESSAGES).filter((name) => name.startsWith("agentChat"))) {
      const fn = MESSAGES[key as keyof typeof MESSAGES] as (l: "en" | "ar") => string;
      expect(fn("ar"), key).not.toBe("");
      if (
        ![
          "agentChatModel",
          "agentChatModelMenu",
          "agentChatStop",
          "agentChatToolFailed",
          "agentChatUploadFailed",
          "agentChatToolRunning",
          "agentChatAgentRunning",
        ].includes(key)
      ) {
        expect(fn("ar"), key).not.toBe(fn("en"));
      }
    }
  });
});
