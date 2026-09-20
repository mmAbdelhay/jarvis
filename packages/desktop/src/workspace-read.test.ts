import type { WorkspaceState } from "@jarvis/core";
import type { MobileWorkspaceSnapshot } from "@jarvis/wire";
import { describe, expect, it } from "vitest";

describe("mobile workspace snapshot shape", () => {
  it("stays structurally assignable both ways with core WorkspaceState", () => {
    const core: WorkspaceState = {
      tabs: [
        {
          id: "tab-1",
          project: "app",
          url: "https://example.test",
          kind: "web",
          title: "Example",
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

    const mobile: MobileWorkspaceSnapshot = core;
    const roundTrip: WorkspaceState = mobile;

    expect(roundTrip.tabs[0]?.id).toBe("tab-1");
  });
});
