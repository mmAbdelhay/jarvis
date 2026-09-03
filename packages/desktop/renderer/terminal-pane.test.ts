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
    attach: async () => "",
    settings,
  });
}

beforeEach(() => {
  FakeTerminal.instances = [];
  document.body.replaceChildren();
});

describe("a terminal pane", () => {
  // The whole stream, exactly: everything but the marks themselves, in the
  // order the shell wrote it, once each. "Contains" would pass for a pane
  // that dropped the prompt, doubled a chunk or reordered two events, and
  // this is the assertion the feature's one unbreakable rule rests on.
  it("writes every byte to the live terminal", () => {
    const p = pane();
    p.write(`${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}`);
    expect(FakeTerminal.instances[0]?.written.join("")).toBe("$ ls\r\na b\r\n");
  });

  // One read from the pty can carry a whole command and the start of the
  // next. Every event in it is handled in order, and a freeze in the middle
  // does not disturb what follows it.
  it("keeps the stream in order when one chunk holds several commands", () => {
    const p = pane();
    p.write(
      `${A}$ ${B}a\r\n${C("a")}1\r\n${D(0)}` + `${A}$ ${B}b\r\n${C("b")}2\r\n${D(0)}`,
    );
    expect(FakeTerminal.instances[0]?.written.join("")).toBe("$ a\r\n1\r\n$ b\r\n2\r\n");
    expect(p.blocks().map((view) => view.record.command)).toEqual(["a", "b"]);
  });

  // A mark can be torn in half by the read boundary. The splitter holds the
  // fragment back, so the pane must not have written it as plain bytes — and
  // must still see the command it named.
  it("loses nothing when a mark is split across two writes", () => {
    const p = pane();
    p.write(`${A}$ ${B}ls\r\n\u001b]133;C;l`);
    p.write(`s\u0007a b\r\n${D(0)}`);
    expect(FakeTerminal.instances[0]?.written.join("")).toBe("$ ls\r\na b\r\n");
    expect(p.blocks()[0]?.record.command).toBe("ls");
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
    p.write("\u001b[?1049l");
    // The exit sequence on its own, before the D that ends the command: with
    // the two in one chunk, block-done would put the state back to "blocks"
    // and this would pass even if the alt-screen branch did nothing at all.
    expect(p.element.dataset["state"]).toBe("blocks");
    p.write(D(0));
    expect(p.blocks()).toHaveLength(1);
  });

  // Not one byte is examined, let alone withheld: the chunk goes to xterm
  // exactly as it arrived, marks and all, which is the terminal Jarvis
  // shipped before blocks existed.
  it("builds no blocks at all when blocks are off", () => {
    const p = pane({ blocks: false, inputEditor: false, notifyAfterSeconds: 0 });
    const chunk = `${A}$ ${B}ls\r\n${C("ls")}a b\r\n${D(0)}`;
    p.write(chunk);
    expect(p.blocks()).toHaveLength(0);
    expect(FakeTerminal.instances[0]?.written.join("")).toBe(chunk);
  });

  it("drops the oldest blocks past the cap", () => {
    const p = pane();
    for (let i = 0; i < 505; i += 1) p.write(`${A}$ ${B}x\r\n${C(`x${i}`)}out\r\n${D(0)}`);
    expect(p.blocks()).toHaveLength(500);
    expect(p.blocks()[0]?.record.command).toBe("x5");
    // And the dropped views left the page with the records: a cap that only
    // trimmed the array would leak a DOM node per command forever.
    expect(p.element.querySelector(".terminal-blocks")?.children).toHaveLength(500);
  });
});
