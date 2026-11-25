// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeTerminal } from "./terminal-double.js";

vi.mock("./vendor/xterm.mjs", async () => {
  const double = await import("./terminal-double.js");
  return { Terminal: double.FakeTerminal };
});

const { renderDockerPane } = await import("./workspace-docker.js");

const view = {
  rows: [{ name: "app", container: "acme-app-1", facts: undefined }],
  composeProject: undefined,
  composeWorkingDir: undefined,
};

describe("the Docker log terminal's links", () => {
  const openTab = vi.fn(async () => {});
  const plansOpenLink = vi.fn(async () => {});

  beforeEach(() => {
    FakeTerminal.instances = [];
    openTab.mockClear();
    plansOpenLink.mockClear();
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis = {
      dockerFollow: vi.fn(),
      openTab,
      plansOpenLink,
    };
  });

  async function selectedHandler(): Promise<{
    activate: (e: unknown, uri: string, r: unknown) => void;
  }> {
    const host = document.createElement("div");
    document.body.append(host);
    renderDockerPane(host, "tab1", "acme", view as never);
    (host.querySelector(".workspace-docker-row, [data-container]") as HTMLElement | null)?.click();
    const terminal = FakeTerminal.instances[0];
    expect(terminal).toBeDefined();
    return (terminal as FakeTerminal).options["linkHandler"] as never;
  }

  it("confirms an OSC 8 link with its real URL and opens it in the project", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const handler = await selectedHandler();
    handler.activate({}, "https://example.com/x", {});
    expect(String(confirm.mock.calls[0]?.[0])).toContain("https://example.com/x");
    expect(openTab).toHaveBeenCalledWith("acme", "https://example.com/x");
    confirm.mockReturnValue(false);
    handler.activate({}, "https://example.com/y", {});
    handler.activate({}, "javascript:alert(1)", {});
    expect(openTab).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });
});
