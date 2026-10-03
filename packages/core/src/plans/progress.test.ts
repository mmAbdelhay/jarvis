import { describe, expect, it } from "vitest";
import { parsePlan } from "./blocks.js";
import { planProgress } from "./progress.js";

describe("planProgress", () => {
  it("counts ticked task items against all of them, across lists", () => {
    const plan = parsePlan(
      [
        "# Arabic voice routing",
        "",
        "- [x] Normalise the transcript",
        "- [ ] Resolve the project",
        "",
        "## Tests",
        "",
        "1. [X] One failing test per phrase",
        "2. [ ] Mixed scripts",
        "   - [ ] nested step",
      ].join("\n"),
    );
    expect(planProgress(plan)).toEqual({ done: 2, total: 5 });
  });

  it("ignores checkboxes in code and plain bullets", () => {
    const plan = parsePlan(
      ["- a plain bullet", "", "```md", "- [x] an example, not a step", "```"].join("\n"),
    );
    expect(planProgress(plan)).toBeUndefined();
  });
});
