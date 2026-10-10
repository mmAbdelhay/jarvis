// The real CliSpawner: writes the invocation's files (0600, dirs 0700),
// spawns `wrap(inv)` (the systemd-run sandbox in jarvisd, the bare argv in
// tests) with exactly the env it returns, writes stdin and closes it, and
// reads stdout (and stderr, when the invocation merges them) line by line.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { CliProcess, CliSpawner } from "./runner.js";
import type { CliInvocation } from "./specs.js";

function lineQueue(streams: Readable[]): AsyncIterable<string> {
  const queue: string[] = [];
  let open = streams.length;
  let wake: (() => void) | undefined;
  for (const stream of streams) {
    const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    reader.on("line", (line) => {
      queue.push(line);
      wake?.();
    });
    reader.on("close", () => {
      open -= 1;
      wake?.();
    });
  }
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (open === 0) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
}

export function createNodeCliSpawner(options: {
  wrap(inv: CliInvocation, unit: string): { command: string[]; env: Record<string, string> };
  unitName(inv: CliInvocation): string;
  stopUnit?(unit: string): Promise<void>;
}): CliSpawner {
  return async (inv): Promise<CliProcess> => {
    for (const file of inv.files) {
      await mkdir(posix.dirname(file.path), { recursive: true, mode: 0o700 });
      await writeFile(file.path, file.content, { mode: 0o600 });
    }
    const unit = options.unitName(inv);
    const { command, env } = options.wrap(inv, unit);
    const [program, ...args] = command;
    if (program === undefined) throw new Error("empty command");
    const child = spawn(program, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let tail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      tail = `${tail}${chunk.toString("utf8")}`.slice(-4096);
    });
    const exit = new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
      child.once("error", () => resolve(null));
    });
    child.stdin.on("error", () => {}); // EPIPE when the CLI exits before reading
    child.stdin.end(inv.stdin);
    return {
      lines: lineQueue(inv.mergeStderr ? [child.stdout, child.stderr] : [child.stdout]),
      exit,
      stderrTail: () => tail,
      async kill() {
        await options.stopUnit?.(unit).catch(() => {});
        if (child.exitCode === null) child.kill("SIGTERM");
      },
    };
  };
}
