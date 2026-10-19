import type { ShellExit, ShellOutput } from "@jarvis/platform";
import { describe, expect, it } from "vitest";
import { createPaneScreens } from "./pane-screen.js";

function fakeShells() {
  const outputs = new Set<(output: ShellOutput) => void>();
  const exits = new Set<(exit: ShellExit) => void>();
  const sizes = new Map<string, { cols: number; rows: number }>();
  let offset = 0;
  return {
    sizes,
    shells: {
      onOutput(listener: (output: ShellOutput) => void) {
        outputs.add(listener);
        return () => outputs.delete(listener);
      },
      onShellExit(listener: (exit: ShellExit) => void) {
        exits.add(listener);
        return () => exits.delete(listener);
      },
      termSize: (paneKey: string) => sizes.get(paneKey),
    },
    emit(paneKey: string, chunk: string) {
      for (const listener of outputs) listener({ paneKey, chunk, offset });
      offset += chunk.length;
    },
    exit(paneKey: string) {
      for (const listener of exits) listener({ paneKey, code: 0 });
    },
    listenerCount: () => outputs.size + exits.size,
  };
}

describe("createPaneScreens", () => {
  it("is undefined for a pane that has printed nothing", () => {
    const fake = fakeShells();
    const screens = createPaneScreens(fake.shells);
    expect(screens.screenText("tab-1")).toBeUndefined();
  });

  // What Claude Code does: draws a line, then jumps back with cursor
  // positioning and overwrites it. The raw stream holds both; the screen
  // only the second.
  it("renders cursor-positioned redraws as the screen shows them", async () => {
    const fake = fakeShells();
    fake.sizes.set("tab-1", { cols: 40, rows: 5 });
    const screens = createPaneScreens(fake.shells);
    fake.emit("tab-1", "\x1b[1;1H✶ Moseying… (3s)\x1b[2;1H❯ \x1b[3;1Hstatus");
    fake.emit("tab-1", "\x1b[1;1H\x1b[2K✻ Baked for 15s");
    await screens.whenWritten();
    expect(screens.screenText("tab-1")).toBe("✻ Baked for 15s\n❯\nstatus");
  });

  it("wraps at the pane's own width, following a resize", async () => {
    const fake = fakeShells();
    fake.sizes.set("tab-1", { cols: 10, rows: 4 });
    const screens = createPaneScreens(fake.shells);
    fake.emit("tab-1", "0123456789ABC\r\n");
    await screens.whenWritten();
    expect(screens.screenText("tab-1")).toBe("0123456789\nABC");

    fake.sizes.set("tab-1", { cols: 20, rows: 4 });
    fake.emit("tab-1", "\x1b[2J\x1b[H0123456789ABC");
    await screens.whenWritten();
    expect(screens.screenText("tab-1")?.split("\n").at(-1)).toBe("0123456789ABC");
  });

  it("keeps scrollback above the visible screen", async () => {
    const fake = fakeShells();
    fake.sizes.set("tab-1", { cols: 20, rows: 3 });
    const screens = createPaneScreens(fake.shells);
    fake.emit("tab-1", Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\r\n"));
    await screens.whenWritten();
    const lines = screens.screenText("tab-1")?.split("\n") ?? [];
    expect(lines[0]).toBe("line 0");
    expect(lines.at(-1)).toBe("line 49");
  });

  it("keeps each pane's screen apart", async () => {
    const fake = fakeShells();
    const screens = createPaneScreens(fake.shells);
    fake.emit("tab-1", "one");
    fake.emit("tab-2", "two");
    await screens.whenWritten();
    expect(screens.screenText("tab-1")).toBe("one");
    expect(screens.screenText("tab-2")).toBe("two");
  });

  it("forgets a pane's screen when its shell exits, and starts fresh after", async () => {
    const fake = fakeShells();
    const screens = createPaneScreens(fake.shells);
    fake.emit("tab-1", "old");
    await screens.whenWritten();
    fake.exit("tab-1");
    expect(screens.screenText("tab-1")).toBeUndefined();
    fake.emit("tab-1", "new");
    await screens.whenWritten();
    expect(screens.screenText("tab-1")).toBe("new");
  });

  it("unsubscribes and drops every screen on dispose", async () => {
    const fake = fakeShells();
    const screens = createPaneScreens(fake.shells);
    fake.emit("tab-1", "one");
    await screens.whenWritten();
    screens.dispose();
    expect(fake.listenerCount()).toBe(0);
    expect(screens.screenText("tab-1")).toBeUndefined();
  });
});
