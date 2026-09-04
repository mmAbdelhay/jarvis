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

  // The cap keeps the head *and the tail*, with the gap between them stated
  // — the design's Bounds section, and the reason it is written that way: a
  // build log's failure is at its end. Truncating forward kept the banner
  // and threw the error away, and "Explain this failure", which sends the
  // last 4 KB of `output`, then sent the brain the last 4 KB of the
  // *beginning* of a log it was asked to explain the end of.
  it("caps a block's output to its head and its tail, and says what fell out", () => {
    const splitter = createSplitter({ now: clock(), maxOutputBytes: 20 });
    const lines = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
    const events = splitter.push(`${A}$ ${B}build\r\n${C("build")}${lines}FAILED${D(1)}`);
    const block = done(events)[0];
    expect(block?.truncated).toBe(true);
    // The head is what the command started with, the tail is what it ended
    // with — the half a failing build is read for.
    expect(block?.output.startsWith("1\n2\n")).toBe(true);
    expect(block?.output.endsWith("FAILED")).toBe(true);
    expect(block?.output).toContain("lines elided");
    // The two kept halves together stay inside the cap; the marker between
    // them is the visible extra that says they are two halves at all.
    expect(block?.output.replace(/\r\n… \d+ lines elided\r\n/, "").length).toBeLessThanOrEqual(20);
  });

  // Everything under the cap is untouched: no marker, no truncation flag.
  it("leaves a block that fits well inside the cap exactly as it was", () => {
    const splitter = createSplitter({ now: clock(), maxOutputBytes: 100 });
    const events = splitter.push(`${A}$ ${B}echo\r\n${C("echo")}hi\r\n${D(0)}`);
    expect(done(events)[0]).toMatchObject({ output: "hi\r\n", truncated: false });
  });

  // The tail belongs to the block that produced it. A shell that dies
  // mid-command leaves an overflowing block that never closes, and the next
  // command's block must not inherit its leftovers.
  it("does not carry one block's elided tail into the next block", () => {
    const splitter = createSplitter({ now: clock(), maxOutputBytes: 10 });
    splitter.push(`${A}$ ${B}yes\r\n${C("yes")}${"y".repeat(50)}`);
    const events = splitter.push(`${A}$ ${B}echo\r\n${C("echo")}hi${D(0)}`);
    expect(done(events)[0]).toMatchObject({ output: "hi", truncated: false });
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

  it("passes another program's OSC through untouched", () => {
    const splitter = createSplitter({ now: clock() });
    const title = "]0;my title";
    const clipboard = "]52;c;YmFzZTY0";
    const events = splitter.push(`${A}$ ${B}${title}ls\r\n${C("ls")}${clipboard}a  b\r\n${D(0)}`);
    const text = events
      .filter((event) => event.type === "output")
      .map((event) => event.text)
      .join("");
    expect(text).toBe(`$ ${title}ls\r\n${clipboard}a  b\r\n`);
  });

  it("closes the alt-screen when D arrives with no closing [?1049l", () => {
    const splitter = createSplitter({ now: clock() });
    const entering = splitter.push(`${A}$ ${B}top\r\n${C("top")}${ALT_ON}live frame`);
    expect(entering).toContainEqual({ type: "alt-screen", active: true });

    // The program is killed by a signal: no [?1049l, straight to D.
    const closing = splitter.push(D(137));
    expect(closing).toContainEqual({ type: "alt-screen", active: false });
    expect(closing.filter((event) => event.type === "alt-screen")).toHaveLength(1);
    expect(done(closing)[0]).toMatchObject({ exitCode: 137, output: "" });

    // The alt-screen flag must actually be cleared: the next command's
    // output is captured normally, not silently dropped.
    const next = splitter.push(`${A}$ ${B}echo hi\r\n${C("echo hi")}hi\r\n${D(0)}`);
    expect(done(next)[0]).toMatchObject({ command: "echo hi", output: "hi\r\n" });
  });

  it("announces the working directory when the shell reports it", () => {
    const splitter = createSplitter({ now: clock() });
    const events = splitter.push(`${CWD("/repo/src")}${A}$ ${B}`);
    expect(events).toContainEqual({ type: "cwd", path: "/repo/src" });
  });

  it("announces it again when the directory changes", () => {
    const splitter = createSplitter({ now: clock() });
    splitter.push(`${CWD("/repo")}${A}$ ${B}cd src\r\n${C("cd src")}${D(0)}`);
    const events = splitter.push(`${CWD("/repo/src")}${A}$ ${B}`);
    expect(events.filter((e) => e.type === "cwd")).toEqual([
      { type: "cwd", path: "/repo/src" },
    ]);
  });
});
