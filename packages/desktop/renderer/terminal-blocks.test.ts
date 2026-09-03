import { describe, expect, it } from "vitest";
import { createSplitter, type BlockEvent } from "./terminal-blocks.js";

const A = "]133;A";
const B = "]133;B";
const C = (command: string) => `]133;C;${command}`;
const D = (code: number) => `]133;D;${code}`;
const CWD = (path: string) => `]7;file://${path}`;
const ALT_ON = "[?1049h";
const ALT_OFF = "[?1049l";

/** A clock that ticks one second per read, so durations are assertable. */
function clock(): () => number {
  let t = 1000;
  return () => (t += 1000);
}

const done = (events: BlockEvent[]) =>
  events.filter((event) => event.type === "block-done").map((event) => event.block);

describe("the splitter", () => {
  it("turns a prompt, a command and its output into one block", () => {
    const splitter = createSplitter({ now: clock() });
    splitter.push(`${CWD("/repo")}${A}user@host $ ${B}pnpm test\r\n`);
    const events = splitter.push(`${C("pnpm test")}42 passed\r\n${D(0)}`);

    expect(done(events)).toEqual([
      expect.objectContaining({
        command: "pnpm test",
        output: "42 passed\r\n",
        exitCode: 0,
        cwd: "/repo",
        truncated: false,
      }),
    ]);
  });

  it("passes every non-mark byte through to the live terminal, in order", () => {
    const splitter = createSplitter({ now: clock() });
    const events = splitter.push(`${A}$ ${B}ls\r\n${C("ls")}a  b\r\n${D(0)}`);
    const text = events
      .filter((event) => event.type === "output")
      .map((event) => event.text)
      .join("");
    expect(text).toBe("$ ls\r\na  b\r\n");
  });

  it("survives a mark split across two chunks", () => {
    const splitter = createSplitter({ now: clock() });
    splitter.push(`${A}$ ${B}ls\r\n]133;C;l`);
    const events = splitter.push(`sout\r\n${D(0)}`);
    expect(done(events)[0]).toMatchObject({ command: "ls", output: "out\r\n" });
  });

  it("records the exit code of a failed command", () => {
    const splitter = createSplitter({ now: clock() });
    const events = splitter.push(`${A}$ ${B}git push\r\n${C("git push")}rejected\r\n${D(1)}`);
    expect(done(events)[0]).toMatchObject({ exitCode: 1 });
  });

  it("treats an interrupt as a finished block with its status", () => {
    const splitter = createSplitter({ now: clock() });
    const events = splitter.push(`${A}$ ${B}sleep 9\r\n${C("sleep 9")}^C${D(130)}`);
    expect(done(events)[0]).toMatchObject({ exitCode: 130 });
  });

  it("ignores a D that closes nothing", () => {
    const splitter = createSplitter({ now: clock() });
    expect(done(splitter.push(`${D(0)}${A}$ ${B}`))).toEqual([]);
  });

  it("caps a block's output and says that it did", () => {
    const splitter = createSplitter({ now: clock(), maxOutputBytes: 10 });
    const events = splitter.push(`${A}$ ${B}yes\r\n${C("yes")}${"y".repeat(50)}${D(0)}`);
    const block = done(events)[0];
    expect(block?.output.length).toBeLessThanOrEqual(10);
    expect(block?.truncated).toBe(true);
  });

  it("reports the alternate screen and stops building blocks inside it", () => {
    const splitter = createSplitter({ now: clock() });
    const entering = splitter.push(`${A}$ ${B}top\r\n${C("top")}${ALT_ON}live frame`);
    expect(entering).toContainEqual({ type: "alt-screen", active: true });

    const leaving = splitter.push(`${ALT_OFF}${D(0)}`);
    expect(leaving).toContainEqual({ type: "alt-screen", active: false });
    // A full-screen program's frames are not output worth freezing.
    expect(done(leaving)[0]?.output).toBe("");
  });

  it("closes an open block when the shell exits mid-command", () => {
    const splitter = createSplitter({ now: clock() });
    splitter.push(`${A}$ ${B}sleep 9\r\n${C("sleep 9")}partial`);
    expect(splitter.active()).toMatchObject({ command: "sleep 9" });
  });

  it("times a block from its start mark to its end mark", () => {
    const splitter = createSplitter({ now: clock() });
    const events = splitter.push(`${A}$ ${B}x\r\n${C("x")}${D(0)}`);
    const block = done(events)[0];
    expect((block?.endedAt ?? 0) - (block?.startedAt ?? 0)).toBe(1000);
  });

  it("survives the alt-screen sequence split across two push calls", () => {
    const splitter = createSplitter({ now: clock() });
    // The sequence "[?1049h" is split mid-way, right after "[?1049".
    const first = splitter.push(`${A}$ ${B}top\r\n${C("top")}[?1049`);
    // A chunk ending part-way through the sequence must be held back, not
    // scanned as plain bytes — so no alt-screen event fires yet, and the
    // partial sequence must not appear (garbled) in any output event.
    expect(first.some((event) => event.type === "alt-screen")).toBe(false);
    const firstOutputs = first
      .filter((event) => event.type === "output")
      .map((event) => event.text)
      .join("");
    expect(firstOutputs).not.toContain("");

    const second = splitter.push("hlive frame");
    expect(second).toContainEqual({ type: "alt-screen", active: true });

    const allOutput = [...first, ...second]
      .filter((event) => event.type === "output")
      .map((event) => event.text)
      .join("");
    // The alt-screen sequence itself reaches the live terminal exactly once,
    // in order, followed by the frame it introduced.
    expect(allOutput.endsWith(`${ALT_ON}live frame`)).toBe(true);
    expect(allOutput.split(ALT_ON).length - 1).toBe(1);
  });
});
