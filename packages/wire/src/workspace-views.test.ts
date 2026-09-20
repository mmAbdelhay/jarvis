import { describe, expect, it } from "vitest";
import type { MobileWorkspaceSnapshot, TerminalPaneInfo } from "./workspace-views.js";

describe("workspace view DTOs", () => {
  it("declares the complete mobile workspace snapshot shape", () => {
    const snapshot: MobileWorkspaceSnapshot = {
      tabs: [
        {
          id: "tab-1",
          project: "app",
          url: "terminal://app",
          kind: "terminal",
          title: "Terminal",
          detail: "primary",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          error: undefined,
          hasPlayingVideo: false,
          pageFullscreen: false,
          suspended: false,
        },
      ],
      activeTabId: "tab-1",
    };

    expect(snapshot.tabs[0]?.kind).toBe("terminal");
  });

  it("exposes only a pane key and exited flag for terminal panes", () => {
    const pane: TerminalPaneInfo = { paneKey: "tab-1:split-a", exited: true };

    expect(Object.keys(pane).sort()).toEqual(["exited", "paneKey"]);
  });
});
