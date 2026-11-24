// @vitest-environment jsdom
//
// Search in the chat: matches, count, next and previous, older pages loaded on
// demand with a stop, and the <mark> fallback where the Highlight API is absent.
import { beforeEach, describe, expect, it } from "vitest";
import { agentView, open, press, reply, settle, t, user, type Setup } from "./fixture.js";

beforeEach(() => {
  document.body.replaceChildren();
});

const field = (s: Setup) => s.q<HTMLInputElement>(".ac-search__input");
function search(s: Setup, text: string): void {
  field(s).value = text;
  field(s).dispatchEvent(new Event("input", { bubbles: true }));
}

describe("search in the chat", () => {
  async function ready(
    items = [
      user("u1", "coupon total"),
      reply("a1", "The coupon is applied after tax; coupon again."),
    ],
  ) {
    const s = await open(agentView({ page: { items } }));
    s.q<HTMLButtonElement>('button[aria-label="Search this chat"]').click();
    return s;
  }

  it("opens from its button with the focus in the field, and marks every match with a count", async () => {
    const s = await ready();
    expect(s.q<HTMLElement>(".ac-search").hidden).toBe(false);
    expect(document.activeElement).toBe(field(s));
    search(s, "coupon");
    expect(s.host.querySelectorAll("mark.ac-hit")).toHaveLength(3);
    expect(s.q(".ac-search__count").textContent).toBe("1 of 3");
    expect(s.host.querySelectorAll("mark.ac-hit--current")).toHaveLength(1);
  });

  it("moves to the next and previous match, wrapping, with Enter and Shift+Enter", async () => {
    const s = await ready();
    search(s, "coupon");
    press(field(s), "Enter");
    expect(s.q(".ac-search__count").textContent).toBe("2 of 3");
    press(field(s), "Enter", { shiftKey: true });
    press(field(s), "Enter", { shiftKey: true });
    expect(s.q(".ac-search__count").textContent).toBe("3 of 3");
    s.q<HTMLButtonElement>('button[aria-label="Next match"]').click();
    expect(s.q(".ac-search__count").textContent).toBe("1 of 3");
  });

  it("says when nothing matches, and leaves the text as it was when closed", async () => {
    const s = await ready();
    search(s, "zzz");
    expect(s.q(".ac-search__count").textContent).toBe(t("agentChatSearchNone"));
    search(s, "coupon");
    const before = s.q(".agent-chat__row--text").textContent;
    press(field(s), "Escape");
    expect(s.q<HTMLElement>(".ac-search").hidden).toBe(true);
    expect(s.host.querySelector("mark")).toBeNull();
    expect(s.q(".agent-chat__row--text").textContent).toBe(before);
    expect(document.activeElement).toBe(s.q(".agent-chat__input"));
  });

  it("keeps matching after the feed redraws", async () => {
    const s = await ready();
    search(s, "coupon");
    s.current.view = agentView({
      page: {
        items: [
          user("u1", "coupon total"),
          reply("a1", "The coupon is applied after tax; coupon again."),
          reply("a2", "one more coupon"),
        ],
      },
    });
    s.chat.refresh();
    await settle();
    expect(s.host.querySelectorAll("mark.ac-hit")).toHaveLength(4);
  });

  it("loads older pages while it searches, shows a stop, and stops when asked", async () => {
    const s = await open(agentView({ page: { items: [reply("a1", "no hit here")], older: "c1" } }));
    s.q<HTMLButtonElement>('button[aria-label="Search this chat"]').click();
    let pages = 0;
    const releases: (() => void)[] = [];
    s.api.terminalAgentChat.mockImplementation((_pane, request) => {
      if (request?.before === undefined)
        return Promise.resolve(
          agentView({ page: { items: [reply("a1", "no hit here")], older: "c1" } }),
        );
      pages++;
      return new Promise((resolve) => {
        releases.push(() =>
          resolve(
            agentView({
              page: {
                items: [reply(`o${pages}`, pages === 1 ? "an old needle" : "other")],
                ...(pages < 5 ? { older: `c${pages + 1}` } : {}),
              },
            }),
          ),
        );
      });
    });
    search(s, "needle");
    await settle();
    expect(s.q(".ac-search__progress").textContent).toBe(t("agentChatSearchLoading"));
    const stop = s.q<HTMLButtonElement>(".ac-search .ac-link-button");
    expect(stop.hidden).toBe(false);
    releases.shift()?.();
    await settle();
    expect(s.host.querySelectorAll("mark.ac-hit")).toHaveLength(1);
    stop.click();
    expect(s.q(".ac-search__progress").textContent).toBe(t("agentChatSearchStopped"));
    releases.shift()?.();
    await settle();
    expect(pages).toBe(2);
  });

  it("uses the Highlight API when the browser has it, without touching the DOM", async () => {
    const registry = new Map<string, unknown>();
    class FakeHighlight {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    (globalThis as unknown as { Highlight: unknown }).Highlight = FakeHighlight;
    (globalThis as unknown as { CSS: unknown }).CSS = { highlights: registry };
    try {
      const s = await ready();
      search(s, "coupon");
      expect(s.host.querySelector("mark")).toBeNull();
      expect((registry.get("ac-search") as FakeHighlight).ranges).toHaveLength(3);
      expect((registry.get("ac-search-current") as FakeHighlight).ranges).toHaveLength(1);
      press(field(s), "Escape");
      expect(registry.has("ac-search")).toBe(false);
    } finally {
      delete (globalThis as unknown as { Highlight?: unknown }).Highlight;
      delete (globalThis as unknown as { CSS?: unknown }).CSS;
    }
  });

  it("opens with Cmd+F or Ctrl+F from inside the chat", async () => {
    const s = await open();
    const event = press(s.q(".agent-chat__input"), "f", { metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(s.q<HTMLElement>(".ac-search").hidden).toBe(false);
  });
});
