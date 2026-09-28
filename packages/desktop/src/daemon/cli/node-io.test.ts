import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { nodeCliIo } from "./node-io.js";

type Signal = "SIGINT" | "SIGTERM" | "SIGHUP";

function fakeTerminal() {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    rawMode: false,
    setEncoding() {},
    setRawMode(on: boolean) {
      stdin.rawMode = on;
    },
    pause() {},
    resume() {},
  });
  const written: string[] = [];
  const signals = new Map<Signal, Set<() => void>>();
  const exits: number[] = [];
  const io = nodeCliIo({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: { write: (text: string) => written.push(text) },
    stderr: { write: (text: string) => written.push(text) },
    stdoutIsTTY: true,
    onSignal(signal, listener) {
      const set = signals.get(signal) ?? new Set();
      set.add(listener);
      signals.set(signal, set);
      return () => set.delete(listener);
    },
    exit: (code) => void exits.push(code),
  });
  const raise = (signal: Signal) => {
    for (const listener of [...(signals.get(signal) ?? [])]) listener();
  };
  const listening = () => [...signals.values()].reduce((sum, set) => sum + set.size, 0);
  return { stdin, io, written, raise, exits, listening };
}

describe("nodeCliIo hidden reads", () => {
  it("echoes nothing, honours backspace, and restores the mode on Enter", async () => {
    const t = fakeTerminal();
    const read = t.io.readHidden("Password: ");
    expect(t.stdin.rawMode).toBe(true);
    t.stdin.emit("data", "secrett\u007f\r");
    await expect(read).resolves.toBe("secret");
    expect(t.stdin.rawMode).toBe(false);
    expect(t.written.join("")).not.toContain("secret");
    expect(t.listening()).toBe(0);
  });

  it.each([
    ["SIGTERM", 143],
    ["SIGHUP", 129],
    ["SIGINT", 130],
  ] as const)(
    "restores the mode and exits %s's way when killed mid-prompt",
    async (signal, code) => {
      const t = fakeTerminal();
      const read = t.io.readHidden("Password: ");
      t.stdin.emit("data", "half");
      t.raise(signal);
      await expect(read).resolves.toBeUndefined();
      expect(t.stdin.rawMode).toBe(false);
      expect(t.exits).toEqual([code]);
      expect(t.listening()).toBe(0);
    },
  );

  it("gives undefined on Ctrl-C typed as a byte, and keeps two piped lines", async () => {
    const t = fakeTerminal();
    const read = t.io.readHidden("Password: ");
    t.stdin.emit("data", "abc\u0003");
    await expect(read).resolves.toBeUndefined();
    expect(t.stdin.rawMode).toBe(false);

    const first = t.io.readLine();
    t.stdin.emit("data", "one\r\ntwo\n");
    await expect(first).resolves.toBe("one");
    await expect(t.io.readLine()).resolves.toBe("two");
  });
});
