// @vitest-environment jsdom
// packages/desktop/renderer/block-render.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_THEME } from "./terminal-theme.js";

// The real xterm, counted. Everything here needs a genuine emulator — the
// whole module is "replay the bytes and walk the buffer" — so this subclasses
// rather than replaces, and only records how many were ever built.
const constructions = { count: 0 };
vi.mock("./vendor/xterm.mjs", async () => {
  const actual = await vi.importActual<typeof import("./vendor/xterm.mjs")>("./vendor/xterm.mjs");
  return {
    ...actual,
    Terminal: class extends actual.Terminal {
      constructor(...args: ConstructorParameters<typeof actual.Terminal>) {
        super(...args);
        constructions.count += 1;
      }
    },
  };
});

const { renderOutput } = await import("./block-render.js");

describe("freezing a block's output", () => {
  it("returns the element before it is populated, and fills it in after a tick", async () => {
    const element = renderOutput("one\r\ntwo\r\n", 80);
    expect(element.childNodes.length).toBe(0);
    await flush();
    expect(element.querySelectorAll(".block-line").length).toBeGreaterThanOrEqual(2);
  });

  it("renders plain text as lines of spans", async () => {
    const element = renderOutput("one\r\ntwo\r\n", 80);
    await flush();
    expect(element.textContent).toContain("one");
    expect(element.textContent).toContain("two");
    expect(element.querySelectorAll(".block-line").length).toBeGreaterThanOrEqual(2);
  });

  it("paints an ANSI colour with the theme's own value", async () => {
    const element = renderOutput("[31mred[0m\r\n", 80);
    await flush();
    const span = [...element.querySelectorAll("span")].find((s) => s.textContent === "red");
    expect(span?.style.color).toBe(hexToRgb(TERMINAL_THEME.red));
  });

  it("carries bold, italic and underline across", async () => {
    const element = renderOutput("[1mb[0m[3mi[0m[4mu[0m\r\n", 80);
    await flush();
    const style = (text: string) =>
      [...element.querySelectorAll("span")].find((s) => s.textContent === text)?.style;
    expect(style("b")?.fontWeight).toBe("bold");
    expect(style("i")?.fontStyle).toBe("italic");
    expect(style("u")?.textDecoration).toContain("underline");
  });

  it("renders markup in program output as text, never as elements", async () => {
    const element = renderOutput("<img src=x onerror=alert(1)>\r\n", 80);
    await flush();
    expect(element.querySelector("img")).toBeNull();
    expect(element.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("keeps wide characters in one cell group", async () => {
    const element = renderOutput("مرحبا 世界\r\n", 80);
    await flush();
    expect(element.textContent).toContain("世界");
  });

  // One terminal is reused for every block (500 per pane at the cap), so the
  // hazard these pin is a shared emulator: xterm's write() defers parsing to
  // a macrotask and reset() neither drains nor discards what is queued, so a
  // second block resetting on top of a first block's pending bytes would
  // paint one into the other. The renders are queued for exactly that reason.
  // 500 blocks per pane at the cap, each of which used to construct a whole
  // xterm to paint once and throw away — pure churn in the process that also
  // draws the UI.
  it("builds one terminal for many blocks, not one each", async () => {
    const before = constructions.count;
    renderOutput("one\r\n", 80);
    renderOutput("two\r\n", 80);
    renderOutput("three\r\n", 80);
    renderOutput("four\r\n", 80);
    await flushAll();

    expect(constructions.count - before).toBeLessThanOrEqual(1);
  });

  it("keeps each block's output to its own element when three render at once", async () => {
    const first = renderOutput("alpha\r\n", 80);
    const second = renderOutput("beta\r\n", 80);
    const third = renderOutput("gamma\r\n", 80);
    await flushAll();

    expect(first.textContent).toContain("alpha");
    expect(first.textContent).not.toContain("beta");
    expect(second.textContent).toContain("beta");
    expect(second.textContent).not.toContain("alpha");
    expect(second.textContent).not.toContain("gamma");
    expect(third.textContent).toContain("gamma");
    expect(third.textContent).not.toContain("beta");
  });

  // A block wider than the one before it must not be painted at the old
  // width — the reused terminal is resized, not rebuilt.
  it("renders at each block's own width", async () => {
    renderOutput("narrow\r\n", 20);
    const wide = renderOutput(`${"x".repeat(100)}\r\n`, 120);
    await flushAll();

    // 100 x's on one line, not wrapped onto two at 20 columns.
    const lines = [...wide.querySelectorAll(".block-line")].filter(
      (line) => (line.textContent ?? "").includes("x"),
    );
    expect(lines).toHaveLength(1);
  });

  // Output taller than the terminal's 24 rows lives in the scrollback, and
  // paint() walks it — a reused terminal that lost its scrollback would
  // silently truncate every long block.
  it("keeps output that is taller than the terminal", async () => {
    const element = renderOutput(
      Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\r\n"),
      80,
    );
    await flushAll();

    expect(element.textContent).toContain("line-0");
    expect(element.textContent).toContain("line-199");
  });

  it("survives a bad cols value instead of throwing", async () => {
    let element: HTMLElement | undefined;
    expect(() => {
      element = renderOutput("hello\r\n", Number.NaN);
    }).not.toThrow();
    await flush();
    expect(element?.textContent).toContain("hello");
  });
});

/** jsdom normalises inline colours to rgb(); the theme is written in hex. */
function hexToRgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

/** Waits out the macrotask xterm's write() defers its parsing into. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The same, for renders that queue behind each other: one macrotask per
 *  block, plus room to spare. */
async function flushAll(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await flush();
}
