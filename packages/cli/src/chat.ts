// `jarvis` (interactive chat) and `jarvis ask` (one turn) on top of runTurn.
import { MAX_PROMPT_CHARS } from "@jarvis/wire";
import type { ControlClient } from "../../desktop/src/daemon/control/client.js";
import { terminalLine } from "./sanitize.js";
import type { Terminal } from "./terminal.js";
import { runTurn, type TurnOutcome } from "./turn.js";

export function describeOutcome(outcome: TurnOutcome): string {
  switch (outcome.reason) {
    case "done":
      return "";
    case "stopped":
      return "Stopped.\n";
    case "step-limit":
      return "Jarvis stopped after too many steps. Ask again to continue.\n";
    case "error":
      return `Something went wrong: ${terminalLine(outcome.error ?? "unknown error")}\n`;
    case "refused":
      return `Jarvis couldn't take that message: ${terminalLine(outcome.error ?? "")}\n`;
    case "disconnected":
      return "Lost the connection to Jarvis.\n";
  }
}

export function exitCode(outcome: TurnOutcome): number {
  if (outcome.reason === "done") return 0;
  return outcome.reason === "stopped" ? 130 : 1;
}

export async function ask(client: ControlClient, term: Terminal, text: string): Promise<number> {
  const outcome = await runTurn(client, term, text);
  term.write(describeOutcome(outcome));
  return exitCode(outcome);
}

export async function chat(client: ControlClient, term: Terminal): Promise<number> {
  await hintSetup(client, term);
  term.write("Jarvis is listening. Ctrl+C stops a reply; Ctrl+D or /quit leaves.\n");
  for (;;) {
    const line = await term.readLine("› ");
    if (line === null) return 0;
    const text = line.trim();
    if (text === "") continue;
    if (text === "/quit" || text === "/exit") return 0;
    if (text.length > MAX_PROMPT_CHARS) {
      term.write("That message is too long (8000 characters at most).\n");
      continue;
    }
    const outcome = await runTurn(client, term, text);
    term.write(describeOutcome(outcome));
    if (outcome.reason === "disconnected") return 1;
  }
}

async function hintSetup(client: ControlClient, term: Terminal): Promise<void> {
  try {
    const list = await client.invoke("provider:list", []);
    const providers =
      typeof list === "object" && list !== null ? (list as { providers?: unknown }).providers : [];
    if (Array.isArray(providers) && providers.length === 0) {
      term.write("No model provider yet. Run: jarvis setup\n");
    }
  } catch {
    // The first prompt reports any real problem.
  }
}
