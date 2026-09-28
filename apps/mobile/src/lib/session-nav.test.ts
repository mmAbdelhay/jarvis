import { describe, expect, it, vi } from "vitest";
import {
  openSession,
  sessionPresence,
  sessionTarget,
  sessionsSplit,
  firstChildSide,
  splitLayout,
  WIDE_REDIRECT_METHOD,
  wideRedirectFor,
} from "./session-nav";

describe("sessionTarget", () => {
  it("pushes the session screen on a phone", () => {
    expect(sessionTarget("phone", "a")).toEqual({
      action: "push",
      href: "/session/[id]",
      params: { id: "a" },
    });
  });

  it("selects in place on a wide screen", () => {
    expect(sessionTarget("wide", "a")).toEqual({ action: "setParams", params: { id: "a" } });
  });

  it("goes to the sessions split from another wide screen", () => {
    expect(sessionTarget("wide", "a", "elsewhere")).toEqual({
      action: "navigate",
      href: "/sessions",
      params: { id: "a" },
    });
    expect(sessionTarget("phone", "a", "elsewhere").action).toBe("push");
  });
});

describe("openSession", () => {
  it("runs each target through the matching router call", () => {
    const router = { push: vi.fn(), setParams: vi.fn(), navigate: vi.fn() };
    openSession(router, sessionTarget("phone", "a"));
    openSession(router, sessionTarget("wide", "b"));
    openSession(router, sessionTarget("wide", "c", "elsewhere"));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/session/[id]", params: { id: "a" } });
    expect(router.setParams).toHaveBeenCalledWith({ id: "b" });
    expect(router.navigate).toHaveBeenCalledWith({ pathname: "/sessions", params: { id: "c" } });
  });
});

describe("wideRedirectFor", () => {
  it("sends a wide screen to the split with that id", () => {
    expect(wideRedirectFor("wide", "a")).toBe("/sessions?id=a");
  });

  it("sends an invalid id on wide to the split with nothing selected", () => {
    expect(wideRedirectFor("wide", undefined)).toBe("/sessions");
    expect(wideRedirectFor("phone", undefined)).toBeUndefined();
  });

  it("leaves a phone on the session screen", () => {
    expect(wideRedirectFor("phone", "a")).toBeUndefined();
  });
});

describe("sessionsSplit (Review Focus 1)", () => {
  it("keys the detail by id alone, so a layout switch keeps one subscription", () => {
    const wide = sessionsSplit("wide", "a");
    const phone = sessionsSplit("phone", "a");
    expect(wide.detailKey).toBe("a");
    expect(phone.detailKey).toBe(wide.detailKey);
    expect(sessionsSplit("wide", "a").detailKey).toBe(sessionsSplit("wide", "a").detailKey);
  });

  it("shows list and detail side by side on wide, the detail alone on a phone", () => {
    expect(sessionsSplit("wide", "a")).toEqual({
      showList: true,
      detailKey: "a",
      showEmpty: false,
      showBack: false,
    });
    expect(sessionsSplit("phone", "a")).toEqual({
      showList: false,
      detailKey: "a",
      showEmpty: false,
      showBack: true,
    });
  });

  it("falls back to the empty pane on wide when the list no longer has the session", () => {
    expect(sessionsSplit("wide", "a", "missing")).toEqual({
      showList: true,
      detailKey: undefined,
      showEmpty: true,
      showBack: false,
    });
    // Still loading, or offline: keep the selection.
    expect(sessionsSplit("wide", "a", "unknown").detailKey).toBe("a");
    expect(sessionsSplit("wide", "a", "found").detailKey).toBe("a");
    // A phone keeps its detail, which shows its own not-found text.
    expect(sessionsSplit("phone", "a", "missing").detailKey).toBe("a");
  });

  it("shows an empty pane on wide with no selection, and the plain list on a phone", () => {
    expect(sessionsSplit("wide", undefined)).toEqual({
      showList: true,
      detailKey: undefined,
      showEmpty: true,
      showBack: false,
    });
    expect(sessionsSplit("phone", undefined)).toEqual({
      showList: true,
      detailKey: undefined,
      showEmpty: false,
      showBack: false,
    });
  });
});

describe("sessionPresence", () => {
  const base = { listed: true, loading: false, failed: false, found: false };
  it("is missing only after a clean list without the session", () => {
    expect(sessionPresence(base)).toBe("missing");
    expect(sessionPresence({ ...base, found: true })).toBe("found");
  });

  it("is unknown before the first list, while loading, or after a failed list", () => {
    expect(sessionPresence({ ...base, listed: false })).toBe("unknown");
    expect(sessionPresence({ ...base, loading: true })).toBe("unknown");
    expect(sessionPresence({ ...base, failed: true })).toBe("unknown");
  });
});

describe("splitLayout (Review Focus 5)", () => {
  const listSide = (language: "ar" | "en", platformRtl: boolean) =>
    firstChildSide(splitLayout({ language, platformRtl }).direction);

  it("puts the list on the right in Arabic on native, where _layout forced RTL", () => {
    expect(listSide("ar", true)).toBe("right");
  });

  it("puts the list on the right in Arabic on web, where forceRTL is ignored", () => {
    expect(listSide("ar", false)).toBe("right");
  });

  it("puts the list on the left in English on both", () => {
    expect(listSide("en", false)).toBe("left");
    // English chosen but the RTL force not yet undone (it needs a restart).
    expect(listSide("en", true)).toBe("left");
  });

  it("keeps each pane in the platform's own direction, like the phone screens", () => {
    expect(splitLayout({ language: "ar", platformRtl: true }).paneDirection).toBe("rtl");
    expect(splitLayout({ language: "ar", platformRtl: false }).paneDirection).toBe("ltr");
  });
});

// A local model of the root stack, with expo-router's documented semantics:
// `replace` swaps the top route for a new one; `dismissTo` pops back to an
// existing route of that name, or replaces the top route when none exists.
type Route = { key: string; name: string };
let nextKey = 0;
function apply(stack: Route[], method: "replace" | "dismissTo", name: string): Route[] {
  const fresh = { key: `k${nextKey++}`, name };
  if (method === "dismissTo") {
    const at = stack.map((r) => r.name).lastIndexOf(name);
    if (at !== -1) return stack.slice(0, at + 1);
  }
  return [...stack.slice(0, -1), fresh];
}
const names = (stack: Route[]) => stack.map((r) => r.name);

describe("the wide redirect's history (Review Focus 3)", () => {
  const redirect = (stack: Route[]) => apply(stack, WIDE_REDIRECT_METHOD, "(tabs)");

  it("is a dismissTo, never a push", () => {
    expect(WIDE_REDIRECT_METHOD).toBe("dismissTo");
  });

  it("replaces a deep-linked session screen, leaving nothing to go back to", () => {
    const next = redirect([{ key: "s", name: "session/[id]" }]);
    expect(names(next)).toEqual(["(tabs)"]);
  });

  it("returns to the existing tabs after a phone push, with no second tabs entry", () => {
    const tabs = { key: "t", name: "(tabs)" };
    const next = redirect([tabs, { key: "s", name: "session/[id]" }]);
    expect(next).toEqual([tabs]);
    // What `replace` would have done instead: a second tabs navigator.
    expect(names(apply([tabs, { key: "s", name: "session/[id]" }], "replace", "(tabs)"))).toEqual([
      "(tabs)",
      "(tabs)",
    ]);
  });
});
