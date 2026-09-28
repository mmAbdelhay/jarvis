// The real terminal behind CliIo (commands.ts).
//
// Lines are read from stdin through one buffer, so two lines that arrive in
// one chunk (`printf 'old\nnew\n' | jarvisd set-password --stdin`) are both
// kept. A hidden read switches the terminal to raw mode, where nothing is
// echoed and Ctrl-C arrives as a byte rather than a signal; it echoes
// nothing back, not even a mask, and restores the mode however it ends —
// Enter, Ctrl-C, Ctrl-D, or a terminating signal from outside.
//
// No electron here (core/no-electron.test.ts).
import type { CliIo } from "./commands.js";

type Input = NodeJS.ReadStream;
type Output = { write(text: string): unknown };

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = new Set(["\u007f", "\b"]);
/** Signals that end the process, with the shell's 128+n exit code. */
const TERMINATING: readonly ["SIGINT" | "SIGTERM" | "SIGHUP", number][] = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
];

export function nodeCliIo(streams: {
  stdin: Input;
  stdout: Output;
  stderr: Output;
  stdoutIsTTY: boolean;
  onSignal(signal: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): () => void;
  /** Ends the process with `code` (after a terminating signal). */
  exit(code: number): void;
}): CliIo {
  const { stdin, stdout, stderr } = streams;
  let buffer = "";
  let ended = false;
  stdin.setEncoding("utf8");

  function takeLine(): string | undefined {
    const newline = buffer.indexOf("\n");
    if (newline === -1) {
      if (!ended || buffer === "") return undefined;
      const last = buffer;
      buffer = "";
      return last;
    }
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  }

  return {
    out: (line) => void stdout.write(`${line}\n`),
    err: (line) => void stderr.write(`${line}\n`),
    stdinIsTTY: stdin.isTTY === true,
    stdoutIsTTY: streams.stdoutIsTTY,

    readLine(prompt) {
      if (prompt !== undefined) stderr.write(prompt);
      const ready = takeLine();
      if (ready !== undefined || ended) return Promise.resolve(ready);
      return new Promise((resolve) => {
        const finish = () => {
          stdin.off("data", onData);
          stdin.off("end", onEnd);
          stdin.pause();
        };
        const onData = (chunk: string) => {
          buffer += chunk;
          const line = takeLine();
          if (line === undefined) return;
          finish();
          resolve(line);
        };
        const onEnd = () => {
          ended = true;
          finish();
          resolve(takeLine());
        };
        stdin.on("data", onData);
        stdin.on("end", onEnd);
        stdin.resume();
      });
    },

    readHidden(prompt) {
      stderr.write(prompt);
      return new Promise((resolve) => {
        let value: string[] = [];
        // A kill while the terminal is raw (SIGTERM, SIGHUP, an external
        // SIGINT) would otherwise leave the user's shell with echo off:
        // restore the mode first, then end as the signal would have.
        const offSignals = TERMINATING.map(([signal, code]) =>
          streams.onSignal(signal, () => {
            finish(undefined);
            streams.exit(code);
          }),
        );
        const finish = (result: string | undefined) => {
          for (const off of offSignals.splice(0)) off();
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          stderr.write("\n");
          value = [];
          resolve(result);
        };
        const onData = (chunk: string) => {
          for (const character of chunk) {
            if (character === "\r" || character === "\n") return finish(value.join(""));
            if (character === CTRL_C) return finish(undefined);
            if (character === CTRL_D && value.length === 0) return finish(undefined);
            if (BACKSPACE.has(character)) value.pop();
            else if (character >= " ") value.push(character);
          }
        };
        stdin.setRawMode(true);
        stdin.on("data", onData);
        stdin.resume();
      });
    },

    onInterrupt: (listener) => streams.onSignal("SIGINT", listener),
  };
}
