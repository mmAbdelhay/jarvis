// @vitest-environment jsdom
//
// One terminal as the user sees it: frozen blocks above, a live terminal
// below. xterm.js is doubled the way every other renderer terminal test
// doubles it, and block-render.js is stubbed because what a finished block
// *looks* like is block-render's own test's business — what is under test
// here is the pane's state machine and, above all, that every byte still
// reaches the live terminal.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFitAddon, FakeTerminal } from "./terminal-double.js";

vi.mock("./vendor/xterm.mjs", () => ({ Terminal: FakeTerminal }));
vi.mock("./vendor/addon-fit.mjs", () => ({ FitAddon: FakeFitAddon }));
vi.mock("./block-render.js", () => ({
  renderOutput: (ansi: string) => {
    const element = document.createElement("div");
    element.className = "block-output";
    element.textContent = ansi;
    return element;
  },
}));

const { createPane } = await import("./terminal-pane.js");

const A = "\u001b]133;A\u0007";
const B = "\u001b]133;B\u0007";
const C = (c: string) => `\u001b]133;C;${c}\u0007`;
const D = (n: number) => `\u001b]133;D;${n}\u0007`;

function pane(settings = { blocks: true, inputEditor: false, notifyAfterSeconds: 0 }) {
  const host = document.createElement("div");
  document.body.append(host);
  return createPane(host, {
    sendInput: vi.fn(),
    resize: vi.fn(),
    openLink: vi.fn(),
    attach: async () => "",
    settings,
  });
}

beforeEach(() => {
  FakeTerminal.instances = [];
  document.body.replaceChildren();
});

describe("a terminal pane", () => {
  it("writes every byte to the live terminal", () => {
    const p = pane();
    p.write(`${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}`);
    expect(FakeTerminal.instances[0]?.written.join("")).toContain("a b");
  });

  it("freezes a finished command into a block and clears the live terminal", () => {
    const p = pane();
    p.write(`${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}`);
    expect(p.blocks()).toHaveLength(1);
    expect(p.blocks()[0]?.record.command).toBe("ls");
    expect(FakeTerminal.instances[0]?.resets).toBeGreaterThan(0);
  });

  it("keeps the live terminal alone while a command is still running", () => {
    const p = pane();
    p.write(`${A}$ ${B}sleep 9\r\n${C("sleep 9")}working`);
    expect(p.blocks()).toHaveLength(0);
    expect(FakeTerminal.instances[0]?.resets).toBe(0);
  });

  it("gives the whole pane to a full-screen program and takes it back after", () => {
    const p = pane();
    p.write(`${A}$ ${B}top\r\n${C("top")}\u001b[?1049h`);
    expect(p.element.dataset["state"]).toBe("alt");
    p.write("\u001b[?1049l" + D(0));
    expect(p.element.dataset["state"]).not.toBe("alt");
  });

  it("builds no blocks at all when blocks are off", () => {
    const p = pane({ blocks: false, inputEditor: false, notifyAfterSeconds: 0 });
    p.write(`${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}`);
    expect(p.blocks()).toHaveLength(0);
    expect(FakeTerminal.instances[0]?.written.join("")).toContain("a b");
  });

  it("drops the oldest blocks past the cap", () => {
    const p = pane();
    for (let i = 0; i < 505; i += 1) p.write(`${A}$ ${B}x\r\n${C(`x${i}`)}out\r\n${D(0)}`);
    expect(p.blocks()).toHaveLength(500);
    expect(p.blocks()[0]?.record.command).toBe("x5");
  });
});
