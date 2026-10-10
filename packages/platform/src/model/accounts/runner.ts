// Plan Y §2.3: run one account CLI process and feed its stdout to a parser.
// The tripwire, an abort and the timeout all stop the systemd unit at once
// (CliProcess.kill), so a CLI that tries a tool of its own never gets to
// finish it. Pure apart from the injected spawner and setTimeout.
import type { CliInvocation } from "./specs.js";
import type { CliStreamEvent, CliStreamParser } from "./stream-types.js";

export type CliProcess = {
  lines: AsyncIterable<string>;
  exit: Promise<number | null>;
  stderrTail(): string;
  kill(): Promise<void>;
};
export type CliSpawner = (inv: CliInvocation) => Promise<CliProcess>;

export async function* runCli(
  inv: CliInvocation,
  spawn: CliSpawner,
  parser: CliStreamParser,
  signal: AbortSignal,
): AsyncGenerator<CliStreamEvent> {
  signal.throwIfAborted();
  const proc = await spawn(inv);
  let exited = false;
  void proc.exit.then(() => {
    exited = true;
  });
  let killed = false;
  let timedOut = false;
  const kill = async () => {
    if (killed) return;
    killed = true;
    await proc.kill();
  };
  const onAbort = () => void kill();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    void kill();
  }, inv.timeoutMs);
  try {
    for await (const line of proc.lines) {
      for (const event of parser.line(line)) {
        if (event.kind === "tripwire") {
          await kill();
          yield event;
          return;
        }
        yield event;
      }
    }
    const exitCode = await proc.exit;
    signal.throwIfAborted();
    if (timedOut) {
      yield { kind: "error", code: "failed", detail: "timed out" };
      return;
    }
    yield* parser.end(exitCode, proc.stderrTail());
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    // The consumer stopped early (an error event, a thrown ProviderError).
    if (!exited) await kill();
  }
}

/** One short process (install, audit, logout): exit code and output tail. */
export async function runOnce(
  inv: CliInvocation,
  spawn: CliSpawner,
): Promise<{ exitCode: number | null; output: string }> {
  const proc = await spawn(inv);
  let output = "";
  const timer = setTimeout(() => void proc.kill(), inv.timeoutMs);
  try {
    for await (const line of proc.lines) output = `${output}${line}\n`.slice(-4096);
    const exitCode = await proc.exit;
    const tail = proc.stderrTail();
    if (!inv.mergeStderr && tail !== "") output = `${output}${tail}`.slice(-4096);
    return { exitCode, output };
  } finally {
    clearTimeout(timer);
  }
}
