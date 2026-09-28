import { describe, expect, it, vi } from "vitest";
// The real stack router expo-router runs (an internal module, but the only
// honest way to show what `dismissTo` does to the history in node).
import { StackRouter } from "expo-router/build/react-navigation/routers/StackRouter";
import {
  openSession,
  sessionTarget,
  sessionsSplit,
  splitDirection,
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

describe("splitDirection (Review Focus 5)", () => {
  it("puts the list first in English and on the right in Arabic", () => {
    expect(splitDirection("en")).toEqual({ flexDirection: "row", divider: "right" });
    expect(splitDirection("ar")).toEqual({ flexDirection: "row-reverse", divider: "left" });
  });
});

describe("the wide redirect's history (Review Focus 3)", () => {
  const router = StackRouter({});
  const routeNames = ["(tabs)", "session/[id]"];
  const options = { routeNames, routeParamList: {}, routeGetIdList: {} };
  // What `router.dismissTo("/sessions?id=a")` dispatches on the root stack.
  const redirect = {
    type: "POP_TO" as const,
    payload: { name: "(tabs)", params: { screen: "sessions", params: { id: "a" } } },
  };

  it("is a dismissTo, never a push", () => {
    expect(WIDE_REDIRECT_METHOD).toBe("dismissTo");
  });

  it("replaces a deep-linked session screen, leaving nothing to go back to", () => {
    const state = {
      stale: false as const,
      type: "stack" as const,
      key: "root",
      index: 0,
      routeNames,
      preloadedRoutes: [],
      routes: [{ key: "s", name: "session/[id]", params: { id: "a" } }],
    };
    const next = router.getStateForAction(state, redirect, options);
    expect(next?.routes.map((r) => r.name)).toEqual(["(tabs)"]);
    expect(next?.index).toBe(0);
    expect(router.getStateForAction(next as never, { type: "GO_BACK" }, options)).toBeNull();
  });

  it("returns to the existing tabs after a phone push, with no second tabs entry", () => {
    const state = {
      stale: false as const,
      type: "stack" as const,
      key: "root",
      index: 1,
      routeNames,
      preloadedRoutes: [],
      routes: [
        { key: "t", name: "(tabs)", params: undefined },
        { key: "s", name: "session/[id]", params: { id: "a" } },
      ],
    };
    const next = router.getStateForAction(state, redirect, options);
    expect(next?.routes.map((r) => r.key)).toEqual(["t"]);
    expect(next?.routes[0]?.params).toEqual({ screen: "sessions", params: { id: "a" } });
  });
});
