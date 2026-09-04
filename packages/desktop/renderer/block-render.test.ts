// @vitest-environment jsdom
// packages/desktop/renderer/block-render.test.ts
import { describe, expect, it } from "vitest";
import { TERMINAL_THEME } from "./terminal-theme.js";
import { renderOutput } from "./block-render.js";

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
