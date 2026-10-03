import type { PlanBlock } from "./blocks.js";

export type PlanProgress = { done: number; total: number };

// A GitHub-style task item: a list marker (`-`, `*`, `+` or `1.` / `1)`),
// then `[ ]`, `[x]` or `[X]`. Read from list blocks only, so a checkbox
// written inside a code fence is an example, not a step.
const TASK_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\](?:\s|$)/;

/**
 * How far through its own checklist a plan is: the `- [x]` items against
 * all its `- [ ]` and `- [x]` items. Undefined for a plan with no
 * checklist at all — "0 of 0" is not progress worth showing. This is the
 * plan's own word on what is done, which is the point: an agent working a
 * plan ticks its items as it goes, so the count moves as it does.
 */
export function planProgress(blocks: readonly PlanBlock[]): PlanProgress | undefined {
  let done = 0;
  let total = 0;
  for (const block of blocks) {
    if (block.kind !== "list") continue;
    for (const line of block.source.split("\n")) {
      const match = TASK_ITEM.exec(line);
      if (match === null) continue;
      total += 1;
      if (match[1] !== " ") done += 1;
    }
  }
  return total === 0 ? undefined : { done, total };
}
