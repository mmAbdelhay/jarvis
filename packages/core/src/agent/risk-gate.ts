// The risk gate (spec §5): every confirm/password call of one step goes on
// ONE card; each item is ticked by default and can be unticked; Deny is the
// default and no answer in 5 minutes is Deny. Secrets typed on the card go
// to the tool directly — merged into its input at execution, scrubbed from
// whatever it returns — and never into events, model messages or the audit
// log. One audit line per item, approved or not.
import { auditInput } from "./audit.js";
import { AGENT_TEXT } from "./messages.js";
import {
  type AgentEvent,
  type AuditEntry,
  CARD_TIMEOUT_MS,
  type Card,
  type CardItem,
  type ConfirmAnswer,
} from "./contract.js";
import type { CardDescription, RegisteredTool } from "./tool-registry.js";
import { type ToolOutcome, isRecord } from "./types.js";

export type GateCall = { callId: string; tool: RegisteredTool; input: Record<string, unknown> };
export type GateItemStatus = "ran" | "unticked" | "denied" | "timeout" | "stopped";
export type GateItemResult = {
  callId: string;
  status: GateItemStatus;
  outcome?: ToolOutcome;
  /** For a batchItems call that ran: how many of its elements were unticked. */
  skippedItems: number;
};

export type GateBatchRequest = {
  turnId: string | null;
  via: "desktop" | "doctor";
  calls: GateCall[];
  signal?: AbortSignal;
  /** At most this many items may be ticked (the doctor's Wi-Fi pick: 1). */
  maxTicked?: number;
  execute(call: GateCall, input: Record<string, unknown>): Promise<ToolOutcome>;
};

export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateError";
  }
}

export type RiskGateDeps = {
  emit(event: AgentEvent): void;
  describe(tool: RegisteredTool, input: Record<string, unknown>): Promise<CardDescription>;
  audit(entry: AuditEntry): Promise<void>;
  now(): number;
  newId(): string;
  timers: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  log(line: string): void;
};

export interface RiskGate {
  runBatch(request: GateBatchRequest): Promise<GateItemResult[]>;
  /** Throws GateError for a closed or unknown card, an unknown item, or a
   *  secret for a field the item does not have. */
  confirm(answer: ConfirmAnswer): void;
  openCards(): Card[];
  /** Closes every open card as denied (shutdown). */
  closeAll(): void;
}

type Decision = {
  decision: "approved" | "denied" | "timeout";
  ticked: ReadonlySet<string>;
  secrets: Record<string, Record<string, string>>;
};

const refused = (decision: "denied" | "timeout"): Decision => ({
  decision,
  ticked: new Set(),
  secrets: {},
});

function scrubText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret !== "") out = out.replaceAll(secret, "[hidden]");
  return out;
}

export function scrubSecretValues(value: unknown, secrets: readonly string[]): unknown {
  if (secrets.every((s) => s === "")) return value;
  if (typeof value === "string") return scrubText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => scrubSecretValues(item, secrets));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubSecretValues(item, secrets)]),
    );
  }
  return value;
}

function secretLabel(tool: RegisteredTool, name: string): string {
  const properties = tool.inputSchema["properties"];
  const property = isRecord(properties) ? properties[name] : undefined;
  if (isRecord(property) && typeof property["title"] === "string" && property["title"] !== "") {
    return property["title"];
  }
  return name.charAt(0).toUpperCase() + name.slice(1);
}

type Unit = {
  callIndex: number;
  /** Which element of input.items this card item stands for (batchItems tools). */
  elementIndex: number | undefined;
  describedInput: Record<string, unknown>;
  item: CardItem;
};

function batchElements(call: GateCall): unknown[] | undefined {
  const items = call.input["items"];
  return call.tool.batchItems && Array.isArray(items) && items.length > 0 ? items : undefined;
}

/** Card items are described this many at a time: a 150-update card must
 *  open in seconds, and jarvis.describe is a stdio round trip each. */
export const DESCRIBE_CONCURRENCY = 8;
/** No card holds more items from one call than this (updates.apply's 1-200,
 *  M2 contracts §2; also the shell's tick cap in @jarvis/wire). */
export const MAX_BATCH_ITEMS = 200;

function batchLimit(tool: RegisteredTool): number {
  const properties = tool.inputSchema["properties"];
  const items = isRecord(properties) ? properties["items"] : undefined;
  const max = isRecord(items) ? items["maxItems"] : undefined;
  return typeof max === "number" && Number.isInteger(max) && max >= 1
    ? Math.min(max, MAX_BATCH_ITEMS)
    : MAX_BATCH_ITEMS;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function createRiskGate(deps: RiskGateDeps): RiskGate {
  const open = new Map<
    string,
    { card: Card; maxTicked: number; settle(decision: Decision): void }
  >();

  async function writeAudit(entry: AuditEntry): Promise<void> {
    try {
      await deps.audit(entry);
    } catch (error) {
      deps.log(
        `[gate] audit write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function runBatch(request: GateBatchRequest): Promise<GateItemResult[]> {
    // One unit per card item. A batchItems tool (contracts §6 #1) gives one
    // unit per element of input.items, each described on its own; a batch
    // over its limit is refused before the card (no item, no audit, no run).
    const oversize = new Map<number, number>();
    const jobs: {
      callIndex: number;
      elementIndex: number | undefined;
      describedInput: Record<string, unknown>;
      call: GateCall;
    }[] = [];
    for (const [callIndex, call] of request.calls.entries()) {
      const elements = batchElements(call);
      if (elements === undefined) {
        jobs.push({ callIndex, elementIndex: undefined, describedInput: call.input, call });
        continue;
      }
      const limit = batchLimit(call.tool);
      if (elements.length > limit) {
        oversize.set(callIndex, limit);
        continue;
      }
      for (const [elementIndex, element] of elements.entries()) {
        jobs.push({
          callIndex,
          elementIndex,
          describedInput: { ...call.input, items: [element] },
          call,
        });
      }
    }
    const descriptions = await mapLimit(jobs, DESCRIBE_CONCURRENCY, (job) =>
      deps.describe(job.call.tool, job.describedInput),
    );
    const units: Unit[] = jobs.map((job, index) => {
      const description = descriptions[index] as CardDescription;
      return {
        callIndex: job.callIndex,
        elementIndex: job.elementIndex,
        describedInput: job.describedInput,
        item: {
          itemId: `item-${index + 1}`,
          tool: job.call.tool.name,
          title: description.title,
          detail: description.detail,
          source: description.source,
          risk: job.call.tool.risk === "password" ? "password" : "confirm",
          secretFields: job.call.tool.secrets.map((name) => ({
            name,
            label: secretLabel(job.call.tool, name),
          })),
        },
      };
    });
    const items = units.map((unit) => unit.item);
    const card: Card = {
      cardId: deps.newId(),
      turnId: request.turnId,
      expiresAt: deps.now() + CARD_TIMEOUT_MS,
      items,
    };

    const decision: Decision =
      units.length === 0
        ? refused("denied")
        : await new Promise<Decision>((resolve) => {
            let settled = false;
            const onAbort = () => settle(refused("denied"));
            const timer = deps.timers.setTimeout(() => settle(refused("timeout")), CARD_TIMEOUT_MS);
            function settle(result: Decision): void {
              if (settled) return;
              settled = true;
              deps.timers.clearTimeout(timer);
              request.signal?.removeEventListener("abort", onAbort);
              open.delete(card.cardId);
              deps.emit({ type: "card-closed", cardId: card.cardId, decision: result.decision });
              resolve(result);
            }
            open.set(card.cardId, {
              card,
              maxTicked: request.maxTicked ?? Number.POSITIVE_INFINITY,
              settle,
            });
            deps.emit({ type: "card", card });
            if (request.signal?.aborted === true) onAbort();
            else request.signal?.addEventListener("abort", onAbort, { once: true });
          });

    const results: GateItemResult[] = [];
    for (const [callIndex, call] of request.calls.entries()) {
      const limit = oversize.get(callIndex);
      if (limit !== undefined) {
        results.push({
          callId: call.callId,
          status: "ran",
          outcome: { ok: false, data: null, text: AGENT_TEXT.tooManyItems(limit), code: "invalid" },
          skippedItems: 0,
        });
        continue;
      }
      const mine = units.filter((unit) => unit.callIndex === callIndex);
      const ticked =
        decision.decision === "approved"
          ? mine.filter((unit) => decision.ticked.has(unit.item.itemId))
          : [];
      const provided: Record<string, string> = Object.assign(
        {},
        ...ticked.map((unit) => decision.secrets[unit.item.itemId] ?? {}),
      );
      const secretValues = Object.values(provided);
      let status: GateItemStatus;
      let outcome: ToolOutcome | undefined;
      if (ticked.length === 0) {
        status = decision.decision === "approved" ? "unticked" : decision.decision;
      } else if (request.signal?.aborted === true) {
        status = "stopped";
      } else {
        status = "ran";
        const elements = batchElements(call);
        // A batch tool runs ONCE with only its ticked elements (criterion 8).
        const input =
          elements === undefined
            ? call.input
            : { ...call.input, items: ticked.map((unit) => elements[unit.elementIndex as number]) };
        let raw: ToolOutcome;
        try {
          raw = await request.execute(call, { ...input, ...provided });
        } catch (error) {
          raw = {
            ok: false,
            data: null,
            text: error instanceof Error ? error.message : String(error),
            code: "failed",
          };
        }
        outcome = {
          ok: raw.ok,
          data: scrubSecretValues(raw.data, secretValues),
          text: scrubText(raw.text, secretValues),
          ...(raw.code === undefined ? {} : { code: raw.code }),
        };
      }
      results.push({
        callId: call.callId,
        status,
        ...(outcome === undefined ? {} : { outcome }),
        skippedItems: status === "ran" ? mine.length - ticked.length : 0,
      });
      // One audit line per card item.
      for (const unit of mine) {
        const wasTicked = ticked.includes(unit);
        await writeAudit({
          ts: deps.now(),
          tool: call.tool.name,
          title: unit.item.title,
          input: auditInput(
            unit.describedInput,
            call.tool.secrets,
            wasTicked ? Object.keys(provided) : [],
          ),
          decision: wasTicked
            ? "approved"
            : decision.decision === "approved"
              ? "denied"
              : decision.decision,
          via: request.via,
          result: !wasTicked || outcome === undefined ? "skipped" : outcome.ok ? "ok" : "failed",
          ...(wasTicked && outcome !== undefined && !outcome.ok
            ? { message: outcome.text.slice(0, 500) }
            : {}),
        });
      }
    }
    return results;
  }

  return {
    runBatch,
    confirm(answer) {
      const entry = open.get(answer.cardId);
      if (entry === undefined) throw new GateError("That card is no longer open");
      const items = new Map(entry.card.items.map((item) => [item.itemId, item]));
      for (const id of answer.ticked) {
        if (!items.has(id)) throw new GateError(`The card has no item ${id}`);
      }
      const secrets: Record<string, Record<string, string>> = Object.create(null);
      for (const [itemId, fields] of Object.entries(answer.secrets)) {
        const item = items.get(itemId);
        if (item === undefined) throw new GateError(`The card has no item ${itemId}`);
        const allowed = new Set(item.secretFields.map((field) => field.name));
        const kept: Record<string, string> = Object.create(null);
        for (const [name, value] of Object.entries(fields)) {
          if (!allowed.has(name)) throw new GateError(`Item ${itemId} has no secret field ${name}`);
          kept[name] = value;
        }
        secrets[itemId] = kept;
      }
      const ticked = new Set(answer.ticked);
      if (ticked.size > entry.maxTicked)
        throw new GateError(`Tick at most ${entry.maxTicked} item(s) on this card`);
      entry.settle(
        answer.approve && ticked.size > 0
          ? { decision: "approved", ticked, secrets }
          : refused("denied"),
      );
    },
    openCards() {
      return [...open.values()].map((entry) => entry.card);
    },
    closeAll() {
      for (const entry of [...open.values()]) entry.settle(refused("denied"));
    },
  };
}
