// A plan's checklist progress as the laptop computed it (plans.ts attaches
// `progress` to a plan doc that has a checklist), read field by field: an
// older laptop sends none, and a plan with no checklist has none.
export type PlanProgressView = { done: number; total: number };

export function planProgressOf(doc: unknown): PlanProgressView | undefined {
  if (typeof doc !== "object" || doc === null) return undefined;
  const progress = (doc as Record<string, unknown>)["progress"];
  if (typeof progress !== "object" || progress === null) return undefined;
  const { done, total } = progress as Record<string, unknown>;
  if (typeof done !== "number" || typeof total !== "number") return undefined;
  if (
    !Number.isInteger(done) ||
    !Number.isInteger(total) ||
    total < 1 ||
    done < 0 ||
    done > total
  ) {
    return undefined;
  }
  return { done, total };
}

const TASK_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s*(.*)$/;
const STEP_MAX = 120;

/**
 * The plan's current step: its first unticked `- [ ]` item, as plain text
 * — the same task-item rule the laptop counts progress by, read from list
 * blocks only. Undefined when every item is ticked or there are none.
 */
export function currentStep(doc: unknown): string | undefined {
  if (typeof doc !== "object" || doc === null) return undefined;
  const blocks = (doc as Record<string, unknown>)["blocks"];
  if (!Array.isArray(blocks)) return undefined;
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const { kind, source } = block as Record<string, unknown>;
    if (kind !== "list" || typeof source !== "string") continue;
    for (const line of source.split("\n")) {
      const match = TASK_ITEM.exec(line);
      if (match === null || match[1] !== " ") continue;
      // Inline markup reads as noise on one line: keep the words.
      const text = (match[2] ?? "").replaceAll(/[*_`~]/g, "").trim();
      if (text !== "") return text.slice(0, STEP_MAX);
    }
  }
  return undefined;
}
