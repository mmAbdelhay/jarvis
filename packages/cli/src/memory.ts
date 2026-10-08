// `jarvis memory [list|clear]` (Rafiq M2.5 contracts §2, §5). Memory text is
// the model's own writing about the user, so it prints inert like any model text.
import type { ControlClient } from "../../desktop/src/daemon/control/client.js";
import { terminalLine } from "./sanitize.js";
import type { Terminal } from "./terminal.js";

export type MemoryItem = { id: string; kind: "summary" | "fact"; text: string; createdAt: number };

export function parseMemoryItems(value: unknown): MemoryItem[] {
  if (!Array.isArray(value)) return [];
  const items: MemoryItem[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const { id, kind, text, createdAt } = raw as Record<string, unknown>;
    if (typeof id !== "string" || id === "" || typeof text !== "string") continue;
    if ((kind !== "summary" && kind !== "fact") || typeof createdAt !== "number") continue;
    items.push({ id, kind, text, createdAt });
  }
  return items;
}

export function formatMemory(item: MemoryItem): string {
  const date = new Date(item.createdAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const when = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${when}  ${item.kind.padEnd(7)}  ${terminalLine(item.text, 500)}`;
}

export async function memoryCommand(
  client: ControlClient,
  term: Terminal,
  action: "list" | "clear",
  yes: boolean,
): Promise<number> {
  if (action === "list") {
    const items = parseMemoryItems(await client.invoke("memory:list", [{ limit: 100 }]));
    if (items.length === 0) {
      term.write("Jarvis hasn't remembered anything yet.\n");
      return 0;
    }
    for (const item of items) term.write(`${formatMemory(item)}\n`);
    return 0;
  }
  if (!yes) {
    if (!term.interactive) {
      term.write("To forget everything without a prompt, run: jarvis memory clear --yes\n");
      return 2;
    }
    const answer = await term.readLine(
      "Forget everything Jarvis remembers? This can't be undone. [y/N] ",
    );
    if (answer === null || answer.trim().toLowerCase() !== "y") {
      term.write("Kept.\n");
      return 0;
    }
  }
  await client.invoke("memory:clear", []);
  term.write("Done. Jarvis has forgotten everything it remembered.\n");
  return 0;
}
