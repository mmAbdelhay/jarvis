import { readAgentInputState } from "@jarvis/core";
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

  // A headless-terminal failure must cost that pane its screen (the reader
  // falls back to the raw log), never reach the shell's onData loop.
  describe("when the headless terminal throws", () => {
    type Fake = { cols: number; rows: number; write(): void; resize(): void; dispose(): void };
    function failing(where: "create" | "write" | "resize") {
      let made = 0;
      return {
        made: () => made,
        createTerminal: (options: { cols: number; rows: number }): Fake => {
          made++;
          if (where === "create") throw new Error("create failed");
          return {
            cols: options.cols,
            rows: options.rows,
            write: () => {
              if (where === "write") throw new Error("write failed");
            },
            resize: () => {
              if (where === "resize") throw new Error("resize failed");
            },
            dispose: () => {},
          };
        },
      };
    }

    for (const where of ["create", "write"] as const) {
      it(`drops the pane's screen when ${where} throws`, () => {
        const fake = fakeShells();
        const factory = failing(where);
        const screens = createPaneScreens(fake.shells, {
          createTerminal: factory.createTerminal as never,
        });
        expect(() => fake.emit("tab-1", "x")).not.toThrow();
        expect(screens.screenText("tab-1")).toBeUndefined();
      });
    }

    it("drops the pane's screen when resize throws", () => {
      const fake = fakeShells();
      const factory = failing("resize");
      const screens = createPaneScreens(fake.shells, {
        createTerminal: factory.createTerminal as never,
      });
      fake.emit("tab-1", "x");
      fake.sizes.set("tab-1", { cols: 100, rows: 30 });
      expect(() => fake.emit("tab-1", "y")).not.toThrow();
      expect(screens.screenText("tab-1")).toBeUndefined();
    });
  });

  // Claude Code draws its empty box's placeholder dim (SGR 2) — the bytes
  // below are the real ones from a captured pane. Typed text is never dim.
  describe("placeholder text in the input box", () => {
    const RULE = "─".repeat(60);
    const box = (input: string) => `${RULE}\r\n${input}\x1b[22m\r\n${RULE}\r\n  ? for shortcuts`;

    it("drops dim text after the input glyph, so the box reads empty", async () => {
      const fake = fakeShells();
      const screens = createPaneScreens(fake.shells);
      fake.emit("tab-1", box('❯\u00a0\x1b[2mTry "write a test for <filepath>"'));
      await screens.whenWritten();
      const screen = screens.screenText("tab-1") ?? "";
      expect(screen.split("\n")[1]).toBe("❯");
      expect(readAgentInputState(screen, "anthropic")).toBe("idle-input");
    });

    it("keeps the same words typed normally, as a draft", async () => {
      const fake = fakeShells();
      const screens = createPaneScreens(fake.shells);
      fake.emit("tab-1", box('❯\u00a0Try "write a test for <filepath>"'));
      await screens.whenWritten();
      const screen = screens.screenText("tab-1") ?? "";
      expect(screen.split("\n")[1]).toBe('❯\u00a0Try "write a test for <filepath>"');
      expect(readAgentInputState(screen, "anthropic")).toBe("busy");
    });

    it("keeps dim text on a line that does not start with the input glyph", async () => {
      const fake = fakeShells();
      const screens = createPaneScreens(fake.shells);
      fake.emit("tab-1", "\x1b[2m(3s · esc to interrupt)\x1b[22m");
      await screens.whenWritten();
      expect(screens.screenText("tab-1")).toBe("(3s · esc to interrupt)");
    });
  });
});
