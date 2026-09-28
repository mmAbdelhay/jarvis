import type { MobileWorkspaceTab } from "@jarvis/wire";
import { describe, expect, it, vi } from "vitest";
import type { RpcClient } from "./rpc-client";
import { createFakeClock } from "./clock";
import { createTerminalStream } from "./terminal-stream";
import {
  activeTab,
  openToolsWith,
  openWorkspaceTab,
  terminalPaneFor,
  toolTabId,
  withoutTool,
  workspaceLayout,
  workspaceRedirectFor,
  workspaceTabsFrom,
  workspaceTarget,
} from "./workspace-tabs";

function tab(id: string, kind: MobileWorkspaceTab["kind"], title: string): MobileWorkspaceTab {
  return {
    id,
    project: "acme",
    url: "",
    kind,
    title,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: undefined,
    hasPlayingVideo: false,
    pageFullscreen: false,
    suspended: false,
  };
}

const SNAPSHOT = {
  tabs: [
    tab("t2", "terminal", "zsh"),
    tab("w1", "web", "Docs"),
    tab("d1", "docker", "Docker"),
    tab("e1", "editor", "Editor"),
    tab("t1", "terminal", "server"),
    tab("a1", "api", "API"),
  ],
};

describe("workspaceTabsFrom", () => {
  it("keeps the snapshot's own order for the inline kinds, then the open tools", () => {
    const tabs = workspaceTabsFrom(SNAPSHOT, ["changes", "docker"], "en");
    expect(tabs.map((t) => t.id)).toEqual(["t2", "d1", "t1", "a1", "tool:changes", "tool:docker"]);
    expect(tabs.map((t) => t.kind)).toEqual([
      "terminal",
      "docker",
      "terminal",
      "api",
      "changes",
      "docker",
    ]);
  });

  it("titles laptop tabs verbatim and tools from the strings table", () => {
    const tabs = workspaceTabsFrom(SNAPSHOT, ["changes", "api"], "en");
    expect(tabs.find((t) => t.id === "t2")?.title).toBe("zsh");
    expect(tabs.find((t) => t.id === "tool:changes")?.title).toBe("Changes");
    expect(tabs.find((t) => t.id === "tool:api")?.title).toBe("API");
    const ar = workspaceTabsFrom(SNAPSHOT, ["changes"], "ar");
    expect(ar.find((t) => t.id === "tool:changes")?.title).not.toBe("Changes");
  });

  it("marks only tools as closable, and lists each tool once", () => {
    const tabs = workspaceTabsFrom({ tabs: [] }, ["api", "api"], "en");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.closable).toBe(true);
    expect(workspaceTabsFrom(SNAPSHOT, [], "en").every((t) => !t.closable)).toBe(true);
  });
});

describe("open tools", () => {
  it("adds the tool the tab param names, once", () => {
    expect(openToolsWith([], "tool:docker")).toEqual(["docker"]);
    expect(openToolsWith(["docker"], "tool:docker")).toEqual(["docker"]);
    expect(openToolsWith(["api"], "t1")).toEqual(["api"]);
    expect(openToolsWith(["api"], "tool:bogus")).toEqual(["api"]);
    expect(openToolsWith(["api"], undefined)).toEqual(["api"]);
  });

  it("closes a tool", () => {
    expect(withoutTool(["api", "docker"], "tool:api")).toEqual(["docker"]);
    expect(toolTabId("changes")).toBe("tool:changes");
  });
});

describe("activeTab", () => {
  const tabs = workspaceTabsFrom(SNAPSHOT, [], "en");
  it("is the param when it names a tab", () => {
    expect(activeTab(tabs, "t1")).toBe("t1");
  });
  it("falls back to the first tab for a missing param", () => {
    expect(activeTab(tabs, undefined)).toBe("t2");
  });
  it("falls back to the first tab for an unknown param", () => {
    expect(activeTab(tabs, "nope")).toBe("t2");
  });
  it("is undefined with no tabs", () => {
    expect(activeTab([], "t1")).toBeUndefined();
  });
});

describe("workspaceTarget", () => {
  it("pushes the full-screen route on a phone", () => {
    expect(workspaceTarget("phone", { id: "t1", kind: "terminal", paneKey: "t1:p2" })).toEqual({
      action: "push",
      href: "/terminal/[paneKey]",
      params: { paneKey: "t1:p2", tabId: "t1" },
    });
    expect(
      workspaceTarget("phone", { id: "tool:docker", kind: "docker", project: "acme" }),
    ).toEqual({ action: "push", href: "/docker/[project]", params: { project: "acme" } });
    expect(workspaceTarget("phone", { id: "a1", kind: "api", project: "acme" })).toEqual({
      action: "push",
      href: "/api/[project]",
      params: { project: "acme" },
    });
    expect(workspaceTarget("phone", { id: "tool:changes", kind: "changes" })).toEqual({
      action: "push",
      href: "/changes",
      params: {},
    });
  });

  it("selects the tab in place on a wide screen", () => {
    expect(workspaceTarget("wide", { id: "t1", kind: "terminal", paneKey: "t1:p2" })).toEqual({
      action: "setParams",
      params: { tab: "t1", pane: "t1:p2" },
    });
    expect(workspaceTarget("wide", { id: "tool:docker", kind: "docker", project: "acme" })).toEqual(
      { action: "setParams", params: { tab: "tool:docker", pane: undefined } },
    );
  });

  it("runs each target through the matching router call", () => {
    const router = { push: vi.fn(), setParams: vi.fn() };
    openWorkspaceTab(router, workspaceTarget("phone", { id: "tool:changes", kind: "changes" }));
    openWorkspaceTab(router, workspaceTarget("wide", { id: "t1", kind: "terminal" }));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/changes", params: {} });
    expect(router.setParams).toHaveBeenCalledWith({ tab: "t1", pane: undefined });
  });
});

describe("workspaceRedirectFor", () => {
  it("sends a wide terminal route to its workspace tab and pane", () => {
    expect(workspaceRedirectFor("wide", "t1", "t1:p2")).toBe("/workspace?tab=t1&pane=t1%3Ap2");
    expect(workspaceRedirectFor("wide", undefined, "t1")).toBe("/workspace?tab=t1&pane=t1");
    expect(workspaceRedirectFor("wide", undefined, undefined)).toBe("/workspace");
  });
  it("never redirects a phone", () => {
    expect(workspaceRedirectFor("phone", "t1", "t1")).toBeUndefined();
  });
});

describe("terminalPaneFor", () => {
  const panes = [
    { paneKey: "t1", exited: false },
    { paneKey: "t1:p2", exited: false },
  ];
  it("waits for the tab's own pane inventory", () => {
    expect(terminalPaneFor({ tabId: "t1", panes, panesTabId: "t9" })).toBeUndefined();
  });
  it("prefers the pane param, then the tab's main pane, then the first", () => {
    expect(terminalPaneFor({ tabId: "t1", panes, panesTabId: "t1", pane: "t1:p2" })).toBe("t1:p2");
    expect(terminalPaneFor({ tabId: "t1", panes, panesTabId: "t1", pane: "gone" })).toBe("t1");
    expect(
      terminalPaneFor({ tabId: "t1", panes: [panes[1]!], panesTabId: "t1", pane: undefined }),
    ).toBe("t1:p2");
    expect(terminalPaneFor({ tabId: "t1", panes: [], panesTabId: "t1" })).toBeUndefined();
  });
});

describe("workspaceLayout", () => {
  it("wide: tools and strip over the active pane", () => {
    expect(workspaceLayout("wide", "t1")).toEqual({
      showTools: true,
      showBack: false,
      showList: false,
      paneKey: "t1",
      showEmpty: false,
    });
    expect(workspaceLayout("wide", undefined).showEmpty).toBe(true);
  });
  it("phone: the list, or an inherited tab with a way back", () => {
    expect(workspaceLayout("phone", undefined)).toEqual({
      showTools: false,
      showBack: false,
      showList: true,
      paneKey: undefined,
      showEmpty: false,
    });
    expect(workspaceLayout("phone", "t1")).toMatchObject({ showBack: true, paneKey: "t1" });
  });
});

// Review Focus 2: crossing the breakpoint keeps the same pty. The screen
// mounts the active pane under a host whose React key is
// `workspaceLayout(...).paneKey`, and the pane attaches on mount. This
// drives that rule with the real terminal stream over a fake rpc: the
// host re-attaches only when the key changes, as React does.
describe("RF2: attach count across the breakpoint", () => {
  function fakeClient() {
    const attaches: string[] = [];
    const client = {
      call: (channel: string, args: unknown[]) => {
        if (channel === "terminal:snapshot") attaches.push(String(args[0]));
        return new Promise(() => {});
      },
      subscribe: () => ({ ok: true, value: undefined }),
      unsubscribe: () => {},
      onPush: () => () => {},
      onState: () => () => {},
      state: () => "open",
    } as unknown as RpcClient;
    return { client, attaches };
  }

  function paneHost(client: RpcClient) {
    let mounted: { key: string; close(): void } | undefined;
    return (key: string | undefined) => {
      if (mounted?.key === key) return;
      mounted?.close();
      mounted = undefined;
      if (key === undefined) return;
      const stream = createTerminalStream({
        client,
        paneKey: key,
        clock: createFakeClock(),
        log: () => {},
      });
      stream.open({ write: () => {}, reset: () => {} });
      mounted = { key, close: () => stream.close() };
    };
  }

  it("wide → phone → wide attaches once per paneKey", () => {
    const { client, attaches } = fakeClient();
    const render = paneHost(client);
    const tabs = workspaceTabsFrom(SNAPSHOT, [], "en");
    const panes = [{ paneKey: "t1", exited: false }];
    for (const kind of ["wide", "phone", "wide"] as const) {
      const active = activeTab(tabs, "t1");
      const paneKey = terminalPaneFor({ tabId: "t1", panes, panesTabId: "t1" });
      expect(active).toBe("t1");
      render(workspaceLayout(kind, paneKey).paneKey);
    }
    expect(attaches).toEqual(["t1"]);
  });

  it("switching tabs attaches the new pane (the control)", () => {
    const { client, attaches } = fakeClient();
    const render = paneHost(client);
    render(workspaceLayout("wide", "t1").paneKey);
    render(workspaceLayout("wide", "t2").paneKey);
    expect(attaches).toEqual(["t1", "t2"]);
  });
});
