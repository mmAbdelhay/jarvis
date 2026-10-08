// The CLI's only view of the terminal: lines, secrets with no echo, and Ctrl+C.
// Everything above it is tested with FakeTerminal. A secret is read only from
// a real terminal (stdin and stdout both TTYs). Piped input never fills a
// password field, and never answers a card (card.ts checks `interactive`).
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface Terminal {
  readonly interactive: boolean;
  write(text: string): void;
  /** null: end of input, Ctrl+C, or the signal aborted. */
  readLine(prompt: string, signal?: AbortSignal): Promise<string | null>;
  /** No echo. null: no terminal, Ctrl+C/Ctrl+D, or the signal aborted. */
  readSecret(prompt: string, signal?: AbortSignal): Promise<string | null>;
  /** Ctrl+C while no prompt is reading. */
  onInterrupt(listener: () => void): () => void;
}

type TtyInput = Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
type TtyOutput = Writable & { isTTY?: boolean };

export interface NodeTerminalOptions {
  input?: TtyInput;
  output?: TtyOutput;
  /** false in tests: do not install a process SIGINT handler. */
  signals?: boolean;
}

export function nodeTerminal(options: NodeTerminalOptions = {}): Terminal {
  const input: TtyInput = options.input ?? process.stdin;
  const output: TtyOutput = options.output ?? process.stdout;
  const interactive =
    input.isTTY === true && output.isTTY === true && typeof input.setRawMode === "function";
  const interrupts = new Set<() => void>();
  if (options.signals !== false) {
    process.on("SIGINT", () => {
      if (interrupts.size === 0) process.exit(130);
      for (const listener of [...interrupts]) listener();
    });
  }

  return {
    interactive,
    write(text) {
      output.write(text);
    },
    readLine(prompt, signal) {
      if (signal?.aborted) return Promise.resolve(null);
      return new Promise((resolve) => {
        const rl = createInterface({ input, output, terminal: interactive });
        let done = false;
        const finish = (value: string | null) => {
          if (done) return;
          done = true;
          signal?.removeEventListener("abort", onAbort);
          rl.close();
          resolve(value);
        };
        const onAbort = () => {
          output.write("\n");
          finish(null);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        rl.on("SIGINT", () => {
          output.write("\n");
          finish(null);
        });
        rl.on("close", () => finish(null));
        rl.question(prompt, (answer) => finish(answer));
      });
    },
    readSecret(prompt, signal) {
      const setRaw = input.setRawMode;
      if (!interactive || setRaw === undefined || signal?.aborted) return Promise.resolve(null);
      output.write(prompt);
      return new Promise((resolve) => {
        let value = "";
        let inEscape = false;
        const finish = (result: string | null) => {
          input.off("data", onData);
          signal?.removeEventListener("abort", onAbort);
          setRaw.call(input, false);
          input.pause();
          output.write("\n");
          value = "";
          resolve(result);
        };
        const onAbort = () => finish(null);
        const onData = (chunk: Buffer | string) => {
          for (const ch of String(chunk)) {
            if (inEscape) {
              if (/[A-Za-z~]/.test(ch)) inEscape = false;
              continue;
            }
            if (ch === "\u001b") {
              inEscape = true;
              continue;
            }
            if (ch === "\r" || ch === "\n") return finish(value);
            if (ch === "\u0003" || ch === "\u0004") return finish(null);
            if (ch === "\u007f" || ch === "\b") {
              value = Array.from(value).slice(0, -1).join("");
              continue;
            }
            if (ch >= " ") value += ch;
          }
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        setRaw.call(input, true);
        input.on("data", onData);
        input.resume();
      });
    },
    onInterrupt(listener) {
      interrupts.add(listener);
      return () => {
        interrupts.delete(listener);
      };
    },
  };
}
