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
