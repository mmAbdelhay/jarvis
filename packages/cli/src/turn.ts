// One turn over the control socket: send the prompt, stream this turn's
// events, answer this turn's cards. Every client receives every push (M1
// contracts §3), so other turns (the shell's) and doctor cards (turnId null)
// are ignored. Events that arrive before agent:prompt answers with the turnId
// are held and replayed once the turnId is known.
import type { Card } from "@jarvis/wire";
import type { ControlClient } from "../../desktop/src/daemon/control/client.js";
import { answerCard, parseCard } from "./card.js";
import { terminalLine, terminalText } from "./sanitize.js";
import type { Terminal } from "./terminal.js";

export type TurnOutcome = {
  reason: "done" | "stopped" | "step-limit" | "error" | "refused" | "disconnected";
  error?: string;
};

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function endReason(value: unknown): TurnOutcome["reason"] {
  switch (value) {
    case "done":
    case "stopped":
    case "step-limit":
      return value;
    default:
      return "error";
  }
}

function decisionNotice(decision: unknown): string {
  if (decision === "approved") return "Approved.";
  if (decision === "timeout") return "No answer in 5 minutes. Nothing was changed.";
  return "Denied. Nothing was changed.";
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runTurn(
  client: ControlClient,
  term: Terminal,
  text: string,
): Promise<TurnOutcome> {
  let turnId: string | undefined;
  let settled = false;
  let resolveOutcome: (outcome: TurnOutcome) => void = () => {};
  const outcome = new Promise<TurnOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const finish = (result: TurnOutcome) => {
    if (settled) return;
    settled = true;
    resolveOutcome(result);
  };
  const held: Fields[] = [];
  const ownCards = new Set<string>();
  const queue: Card[] = [];
  let open: { cardId: string; abort: AbortController } | undefined;
  let answering = false;
  let atLineStart = true;

  const write = (chunk: string) => {
    if (chunk === "") return;
    term.write(chunk);
    atLineStart = chunk.endsWith("\n");
  };
  const freshLine = () => {
    if (!atLineStart) write("\n");
  };

  const pump = async () => {
    if (answering) return;
    answering = true;
    try {
      for (let card = queue.shift(); card !== undefined; card = queue.shift()) {
        const abort = new AbortController();
        open = { cardId: card.cardId, abort };
        freshLine();
        const answer = await answerCard(term, card, { signal: abort.signal });
        open = undefined;
        atLineStart = true;
        if (answer === null || settled) continue;
        try {
          await client.invoke("agent:confirm", [answer]);
        } catch (error) {
          write(
            `Couldn't send your answer (${terminalLine(messageOf(error))}). An unanswered card counts as Deny.\n`,
          );
        }
      }
    } finally {
      answering = false;
    }
  };

  const handle = (event: Fields) => {
    switch (event.type) {
      case "text":
        if (event.turnId === turnId && typeof event.delta === "string") {
          write(terminalText(event.delta));
        }
        return;
      case "tool": {
        if (event.turnId !== turnId) return;
        const name = terminalLine(typeof event.name === "string" ? event.name : "tool");
        const summary = terminalLine(typeof event.summary === "string" ? event.summary : "");
        freshLine();
        if (event.status === "running") write(`  · ${name}…\n`);
        else write(`  ${event.status === "ok" ? "✓" : "✗"} ${summary || name}\n`);
        return;
      }
      case "card": {
        const card = parseCard(event.card);
        if (card === undefined || card.turnId === null || card.turnId !== turnId) return;
        if (ownCards.has(card.cardId)) return;
        ownCards.add(card.cardId);
        queue.push(card);
        void pump();
        return;
      }
      case "card-closed": {
        if (typeof event.cardId !== "string" || !ownCards.has(event.cardId)) return;
        const queued = queue.findIndex((card) => card.cardId === event.cardId);
        if (queued >= 0) queue.splice(queued, 1);
        if (open?.cardId === event.cardId) open.abort.abort();
        freshLine();
        write(`${decisionNotice(event.decision)}\n`);
        return;
      }
      case "turn-end":
        if (event.turnId !== turnId) return;
        freshLine();
        finish({
          reason: endReason(event.reason),
          ...(typeof event.error === "string" ? { error: event.error } : {}),
        });
        return;
      default:
        return;
    }
  };

  const offPush = client.onPush((channel, payload) => {
    if (channel !== "agent:events" || !isFields(payload)) return;
    if (turnId === undefined) held.push(payload);
    else handle(payload);
  });
  const offClose = client.onClose(() => finish({ reason: "disconnected" }));
  const offInterrupt = term.onInterrupt(() => {
    if (turnId !== undefined) client.invoke("agent:stop", [{ turnId }]).catch(() => {});
  });
  try {
    const reply = await client.invoke("agent:prompt", [{ text }]);
    if (!isFields(reply) || typeof reply.turnId !== "string") {
      finish({ reason: "error", error: "jarvisd answered without a turn id" });
    } else {
      turnId = reply.turnId;
      for (const event of held.splice(0)) handle(event);
    }
  } catch (error) {
    finish({ reason: "refused", error: messageOf(error) });
  }
  try {
    return await outcome;
  } finally {
    offPush();
    offClose();
    offInterrupt();
    open?.abort.abort();
  }
}
