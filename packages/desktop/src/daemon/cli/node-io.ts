// The real terminal behind CliIo (commands.ts).
//
// Lines are read from stdin through one buffer, so two lines that arrive in
// one chunk (`printf 'old\nnew\n' | jarvisd set-password --stdin`) are both
// kept. A hidden read switches the terminal to raw mode, where nothing is
// echoed and Ctrl-C arrives as a byte rather than a signal; it echoes
// nothing back, not even a mask, and restores the mode however it ends.
//
// No electron here (core/no-electron.test.ts).
import type { CliIo } from "./commands.js";

type Input = NodeJS.ReadStream;
type Output = { write(text: string): unknown };

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = new Set(["\u007f", "\b"]);

export function nodeCliIo(streams: {
  stdin: Input;
  stdout: Output;
  stderr: Output;
  onSignal(signal: "SIGINT", listener: () => void): () => void;
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
        const finish = (result: string | undefined) => {
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
