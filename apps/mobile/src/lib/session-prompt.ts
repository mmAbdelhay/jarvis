// The prompt a session is waiting at, for the session screen's prompt
// card: the agent's own question and option labels, read from the laptop
// (`session:prompt`) and answered by index and label (`session:answer`),
// which the laptop checks against the prompt on screen *then* before
// typing anything. Parsed field by field — the keys the laptop would type
// stay on the laptop; the phone only ever needs the labels.
import type { RpcClient } from "./rpc-client";

export type PhonePrompt = { question: string; options: string[] };

export function parsePhonePrompt(value: unknown): PhonePrompt | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const question = record["question"];
  const options = record["options"];
  if (typeof question !== "string" || !Array.isArray(options) || options.length === 0) {
    return undefined;
  }
  const labels: string[] = [];
  for (const option of options.slice(0, 12)) {
    if (typeof option !== "object" || option === null) return undefined;
    const label = (option as Record<string, unknown>)["label"];
    if (typeof label !== "string") return undefined;
    labels.push(label.slice(0, 200));
  }
  return { question: question.slice(0, 500), options: labels };
}

/** Undefined for "at no readable prompt", and for anything the call or
 *  its answer could not establish — a card that is not there is the safe
 *  thing to show. */
export async function fetchPrompt(
  client: Pick<RpcClient, "call">,
  sessionId: string,
): Promise<PhonePrompt | undefined> {
  const result = await client.call("session:prompt", [sessionId], { whenNotOpen: "reject" });
  return result.ok ? parsePhonePrompt(result.value) : undefined;
}

export type AnswerOutcome = "answered" | "changed" | "offline";

export async function answerPrompt(
  client: Pick<RpcClient, "call">,
  sessionId: string,
  index: number,
  label: string,
): Promise<AnswerOutcome> {
  const result = await client.call("session:answer", [sessionId, index, label], {
    whenNotOpen: "reject",
  });
  if (!result.ok) return "offline";
  const value = result.value as { ok?: unknown } | null;
  return value !== null && typeof value === "object" && value.ok === true ? "answered" : "changed";
}
