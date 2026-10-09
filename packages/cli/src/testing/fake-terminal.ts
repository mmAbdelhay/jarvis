// A scripted Terminal. Lines and secrets are answered in order. When the
// script runs out, a read with an AbortSignal waits (for feed() or the abort);
// a read without one is end of input (null).
import type { Terminal } from "../terminal.js";

export type Scripted = string | null;

export class FakeTerminal implements Terminal {
  readonly interactive: boolean;
  output = "";
  readonly prompts: string[] = [];
  readonly secretPrompts: string[] = [];
  readonly #lines: Scripted[];
  readonly #secrets: Scripted[];
  readonly #interrupts = new Set<() => void>();
  #waiting: ((value: Scripted) => void) | undefined;

  constructor(script: { lines?: Scripted[]; secrets?: Scripted[]; interactive?: boolean } = {}) {
    this.#lines = [...(script.lines ?? [])];
    this.#secrets = [...(script.secrets ?? [])];
    this.interactive = script.interactive ?? true;
  }

  write(text: string): void {
    this.output += text;
  }

  readLine(prompt: string, signal?: AbortSignal): Promise<string | null> {
    this.prompts.push(prompt);
    this.output += prompt;
    return this.#next(this.#lines, signal);
  }

  readSecret(prompt: string, signal?: AbortSignal): Promise<string | null> {
    if (!this.interactive) return Promise.resolve(null);
    this.secretPrompts.push(prompt);
    this.output += `${prompt}\n`;
    return this.#next(this.#secrets, signal);
  }

  onInterrupt(listener: () => void): () => void {
    this.#interrupts.add(listener);
    return () => {
      this.#interrupts.delete(listener);
    };
  }

  /** Ctrl+C while no prompt is reading. */
  interrupt(): void {
    for (const listener of [...this.#interrupts]) listener();
  }

  /** Answers the read that is waiting, or queues the line for the next one. */
  feed(line: Scripted): void {
    const waiting = this.#waiting;
    this.#waiting = undefined;
    if (waiting) waiting(line);
    else this.#lines.push(line);
  }

  #next(queue: Scripted[], signal: AbortSignal | undefined): Promise<Scripted> {
    if (signal?.aborted) return Promise.resolve(null);
    if (queue.length > 0) return Promise.resolve(queue.shift() ?? null);
    if (signal === undefined) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.#waiting = resolve;
      signal.addEventListener(
        "abort",
        () => {
          this.#waiting = undefined;
          resolve(null);
        },
        { once: true },
      );
    });
  }
}
