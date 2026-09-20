import { describe, expect, it, vi } from "vitest";
import { ELECTRON_BOUND_CHANNELS, registerDesktopOnly } from "./desktop-only.js";
import { CHANNEL_POLICY } from "./remote-policy.js";

describe("desktop-only registrations", () => {
  it("registers exactly the Electron-bound channels", () => {
    const handle = vi.fn();
    registerDesktopOnly({ ...fakeDesktopDeps(), handle });
    expect(new Set(handle.mock.calls.map(([channel]) => channel))).toEqual(
      new Set(ELECTRON_BOUND_CHANNELS),
    );
  });

  it("never registers a channel the policy allows remotely", () => {
    for (const channel of ELECTRON_BOUND_CHANNELS) {
      expect(CHANNEL_POLICY[channel]).toBe("desktop-only");
    }
  });

  it("dialog:pickFiles returns [] on cancel and the paths otherwise", async () => {
    const handle = vi.fn();
    const dialog = {
      showOpenDialog: vi.fn(async (..._args: unknown[]) => ({
        canceled: true,
        filePaths: ["/a"],
      })),
    };
    registerDesktopOnly({ ...fakeDesktopDeps(), handle, dialog });
    const listener = handle.mock.calls.find(([c]) => c === "dialog:pickFiles")![1];
    expect(await listener({}, { multiple: true })).toEqual([]);
    expect(dialog.showOpenDialog.mock.calls[0]![1]).toEqual({
      properties: ["openFile", "multiSelections"],
    });
  });
});

function fakeDesktopDeps() {
  return {
    handle: vi.fn(),
    window: { getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) } as never,
    screen: { getDisplayMatching: () => ({ scaleFactor: 2 }) },
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [] })) },
    buildMenu: () => ({ popup: vi.fn() }),
    workspace: { setBounds: vi.fn(), setDevToolsBounds: vi.fn() },
    chooseDock: vi.fn(),
    language: "en" as const,
  };
}
