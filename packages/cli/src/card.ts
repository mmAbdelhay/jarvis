// Approval cards as a terminal prompt (Rafiq M2.5 contracts §5): a numbered
// list, every item ticked; `a` approves the ticked items, `d` denies, a number
// toggles one item; secret fields are asked with no echo, only for ticked
// items. A card is answered only from an interactive terminal. With piped
// input the CLI denies and says why, so `yes a | jarvis …` can never approve.
import type { Card, CardItem, CardSource, ConfirmAnswer } from "@jarvis/wire";
import { terminalLine } from "./sanitize.js";
import type { Terminal } from "./terminal.js";

const MAX_ITEMS = 200;
const SOURCE_LABELS: Record<CardSource, string> = {
  debian: "Debian",
  flathub: "Flathub",
  system: "System",
  network: "Network",
};

export const NO_TERMINAL_NOTICE =
  "Jarvis asked to change something. Approval cards need an interactive terminal (run jarvis). Denied; nothing was changed.\n";

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isSource = (value: unknown): value is CardSource =>
  typeof value === "string" && Object.hasOwn(SOURCE_LABELS, value);

export function parseCard(value: unknown): Card | undefined {
  if (!isFields(value)) return undefined;
  const { cardId, turnId, expiresAt, items } = value;
  if (typeof cardId !== "string" || cardId === "") return undefined;
  if (turnId !== null && typeof turnId !== "string") return undefined;
  if (typeof expiresAt !== "number" || !Array.isArray(items)) return undefined;
  if (items.length === 0 || items.length > MAX_ITEMS) return undefined;
  const parsed: CardItem[] = [];
  const ids = new Set<string>();
  for (const raw of items) {
    const item = parseItem(raw);
    if (item === undefined || ids.has(item.itemId)) return undefined;
    ids.add(item.itemId);
    parsed.push(item);
  }
  return { cardId, turnId, expiresAt, items: parsed };
}

function parseItem(raw: unknown): CardItem | undefined {
  if (!isFields(raw)) return undefined;
  const { itemId, tool, title, detail, source, risk, secretFields } = raw;
  if (typeof itemId !== "string" || itemId === "") return undefined;
  if (typeof tool !== "string" || typeof title !== "string" || typeof detail !== "string") {
    return undefined;
  }
  if (!isSource(source) || (risk !== "confirm" && risk !== "password")) return undefined;
  if (!Array.isArray(secretFields)) return undefined;
  const fields: CardItem["secretFields"] = [];
  for (const field of secretFields) {
    if (!isFields(field) || typeof field.name !== "string" || field.name === "") return undefined;
    if (typeof field.label !== "string") return undefined;
    fields.push({ name: field.name, label: field.label });
  }
  return { itemId, tool, title, detail, source, risk, secretFields: fields };
}

export function renderCard(card: Card, ticked: ReadonlySet<string>): string {
  const count = card.items.length;
  const lines = [
    count === 1
      ? "Jarvis needs your approval for this change:"
      : `Jarvis needs your approval for ${count} changes:`,
  ];
  card.items.forEach((item, index) => {
    const box = ticked.has(item.itemId) ? "[x]" : "[ ]";
    const password = item.risk === "password" ? " · asks for a password" : "";
    lines.push(
      `  ${index + 1}. ${box} ${terminalLine(item.title)}  (${SOURCE_LABELS[item.source]}${password})`,
    );
    const detail = terminalLine(item.detail);
    if (detail !== "") lines.push(`        ${detail}`);
  });
  const range = count === 1 ? "1" : `1-${count}`;
  lines.push(`  a = approve ticked (${ticked.size})   d = deny   ${range} = tick or untick`);
  return `${lines.join("\n")}\n`;
}

export interface AnswerOptions {
  /** Aborted when the card closes elsewhere (shell answer, timeout, turn gone). */
  signal?: AbortSignal;
  now?: () => number;
}

/** null: send nothing (closed elsewhere, or expired). Otherwise the agent:confirm payload. */
export async function answerCard(
  term: Terminal,
  card: Card,
  options: AnswerOptions = {},
): Promise<ConfirmAnswer | null> {
  const now = options.now ?? Date.now;
  const deny: ConfirmAnswer = { cardId: card.cardId, approve: false, ticked: [], secrets: {} };
  if (!term.interactive) {
    term.write(NO_TERMINAL_NOTICE);
    return deny;
  }
  const ticked = new Set(card.items.map((item) => item.itemId));
  term.write(renderCard(card, ticked));
  for (;;) {
    const line = await term.readLine("approve? › ", options.signal);
    if (options.signal?.aborted) return null;
    if (now() > card.expiresAt) {
      term.write("This card expired. Nothing was changed.\n");
      return null;
    }
    if (line === null) return deny;
    const choice = line.trim().toLowerCase();
    if (choice === "d") return deny;
    if (choice === "a") {
      if (ticked.size === 0) {
        term.write("Nothing is ticked. Tick an item, or type d to deny.\n");
        continue;
      }
      const secrets = await askSecrets(term, card, ticked, options.signal);
      if (options.signal?.aborted) return null;
      if (secrets === null) {
        term.write("Not approved. The card is still open.\n");
        continue;
      }
      return {
        cardId: card.cardId,
        approve: true,
        ticked: card.items.filter((item) => ticked.has(item.itemId)).map((item) => item.itemId),
        secrets,
      };
    }
    if (/^\d+$/.test(choice)) {
      const item = card.items[Number(choice) - 1];
      if (item === undefined) {
        term.write(`There is no item ${choice}.\n`);
        continue;
      }
      if (ticked.has(item.itemId)) ticked.delete(item.itemId);
      else ticked.add(item.itemId);
      term.write(renderCard(card, ticked));
      continue;
    }
    term.write("Type a to approve, d to deny, or an item number.\n");
  }
}

async function askSecrets(
  term: Terminal,
  card: Card,
  ticked: ReadonlySet<string>,
  signal: AbortSignal | undefined,
): Promise<ConfirmAnswer["secrets"] | null> {
  const secrets: ConfirmAnswer["secrets"] = {};
  for (const item of card.items) {
    if (!ticked.has(item.itemId) || item.secretFields.length === 0) continue;
    const fields: Record<string, string> = {};
    for (const field of item.secretFields) {
      const prompt = `${terminalLine(item.title)} — ${terminalLine(field.label)} (hidden): `;
      const value = await term.readSecret(prompt, signal);
      if (value === null || value === "") return null;
      fields[field.name] = value;
    }
    secrets[item.itemId] = fields;
  }
  return secrets;
}
