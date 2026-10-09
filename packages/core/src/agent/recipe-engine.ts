// Rafiq M4 contracts §4: a recipe on ONE card with one item per step; the
// ticked steps run in order through jarvisd's own registry; the first failure
// stops the rest; the model gets a per-step report. The recipe card is the
// only approval the steps get, so every step tool is checked when the card is
// built AND when the step runs. Pure.
import type { Lang } from "./i18n.js";
import { mapLimit } from "./map-limit.js";
import { RECIPE_TEXT } from "./messages.js";
import {
  checkStepTool,
  parseRecipe,
  RECIPE_ID_PATTERN,
  RECIPE_NOTE_TOOL,
  type Recipe,
  type RecipeMachine,
  recipeFits,
} from "./recipes.js";
import type { GatePreset } from "./risk-gate.js";
import type { CardDescription, RegisteredTool, ToolRegistry } from "./tool-registry.js";
import { isRecord, type ToolOutcome } from "./types.js";

export type RecipeStepStatus = "ok" | "failed" | "skipped" | "not-run";
export type RecipeStepReport = {
  step: number;
  title: string;
  tool: string;
  status: RecipeStepStatus;
  code?: string;
};
export type RecipeRunReport = { id: string; ok: boolean; steps: RecipeStepReport[] };

export type RecipeContext = {
  registry: Pick<ToolRegistry, "get" | "describe">;
  lang: Lang;
  /** Runs one step's tool (the loop's execute: activity line, registry call). */
  callStep(
    index: number,
    tool: RegisteredTool,
    input: Record<string, unknown>,
  ): Promise<ToolOutcome>;
};
export type PreparedRecipe = {
  recipe: Recipe;
  preset: GatePreset;
  run(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome>;
};
export type RecipePrepared =
  | { ok: true; prepared: PreparedRecipe }
  | { ok: false; outcome: ToolOutcome };
export interface RecipeEngine {
  prepare(input: Record<string, unknown>, context: RecipeContext): Promise<RecipePrepared>;
}
export type RecipeEngineDeps = {
  /** The raw recipe files (JSON values), sorted by file name. */
  load(): Promise<readonly unknown[]>;
  machine(): Promise<RecipeMachine>;
  /** TRUSTED_MCP_SERVERS: the only servers a step tool may come from. */
  hostServers: ReadonlySet<string>;
  log(line: string): void;
};

const DESCRIBE_STEP_CONCURRENCY = 4;

const refuse = (code: string, text: string): RecipePrepared => ({
  ok: false,
  outcome: { ok: false, data: null, text, code },
});

function reportOf(outcome: ToolOutcome): RecipeRunReport | undefined {
  const data = outcome.data;
  return isRecord(data) && Array.isArray(data["steps"]) ? (data as RecipeRunReport) : undefined;
}

function tickedSteps(input: Record<string, unknown>): Set<number> {
  const ticked = new Set<number>();
  const items = input["items"];
  if (!Array.isArray(items)) return ticked;
  for (const item of items) {
    // Contracts §6 #1: the card input is {id, items: [stepIndex]}.
    if (typeof item === "number" && Number.isInteger(item)) ticked.add(item);
  }
  return ticked;
}

export function createRecipeEngine(deps: RecipeEngineDeps): RecipeEngine {
  const warned = new Set<string>();

  async function find(id: string): Promise<Recipe | undefined> {
    for (const raw of await deps.load()) {
      const parsed = parseRecipe(raw);
      if (!parsed.ok) {
        if (!warned.has(parsed.error)) {
          warned.add(parsed.error);
          deps.log(`[recipes] ${parsed.error}; skipped`);
        }
        continue;
      }
      // The first file with this id wins (files are read in name order).
      if (parsed.recipe.id === id) return parsed.recipe;
    }
    return undefined;
  }

  /** A batch step is described one element at a time, like any batch card. */
  async function describeStep(
    context: RecipeContext,
    tool: RegisteredTool,
    input: Record<string, unknown>,
  ): Promise<CardDescription> {
    const items = input["items"];
    if (!tool.batchItems || !Array.isArray(items) || items.length === 0) {
      return context.registry.describe(tool, input, context.lang);
    }
    const parts = await mapLimit(items, DESCRIBE_STEP_CONCURRENCY, (item) =>
      context.registry.describe(tool, { ...input, items: [item] }, context.lang),
    );
    return {
      title: parts.map((part) => part.title).join(context.lang === "ar" ? "، " : ", "),
      detail: "",
      source: parts[0]?.source ?? "system",
    };
  }

  async function run(
    recipe: Recipe,
    input: Record<string, unknown>,
    context: RecipeContext,
    signal: AbortSignal | undefined,
  ): Promise<ToolOutcome> {
    const ticked = tickedSteps(input);
    const steps: RecipeStepReport[] = [];
    let failure: { title: string; text: string; code: string } | undefined;
    let stopped = false;
    for (const [index, step] of recipe.steps.entries()) {
      // Reports are for the model: English titles.
      const base = { step: index, title: step.title.en, tool: step.tool };
      if (!ticked.has(index)) {
        steps.push({ ...base, status: "skipped" });
        continue;
      }
      if (failure !== undefined || signal?.aborted === true) {
        stopped ||= failure === undefined;
        steps.push({ ...base, status: "not-run" });
        continue;
      }
      if (step.tool === RECIPE_NOTE_TOOL) {
        // §6 #2: an instruction shown on the card; nothing to execute.
        steps.push({ ...base, status: "ok" });
        continue;
      }
      // Re-checked now: the registry may have changed while the card was open.
      const tool = context.registry.get(step.tool);
      const outcome: ToolOutcome =
        tool === undefined || checkStepTool(step.tool, tool, deps.hostServers) !== undefined
          ? {
              ok: false,
              data: null,
              text: RECIPE_TEXT.stepUnavailable(recipe.id, step.tool),
              code: "unsupported",
            }
          : await context.callStep(index, tool, step.input);
      if (outcome.ok) {
        steps.push({ ...base, status: "ok" });
        continue;
      }
      const code = outcome.code ?? "failed";
      steps.push({ ...base, status: "failed", code });
      failure = { title: step.title.en, text: outcome.text.slice(0, 2_000), code };
    }
    const report: RecipeRunReport = { id: recipe.id, ok: failure === undefined && !stopped, steps };
    const text =
      failure === undefined
        ? JSON.stringify(report)
        : // The failure first: the audit line keeps the first 500 characters.
          `${RECIPE_TEXT.stepFailed(failure.title)}\n${failure.text}\n${JSON.stringify(report)}`;
    return {
      ok: report.ok,
      data: report,
      text,
      ...(report.ok ? {} : { code: failure?.code ?? "stopped" }),
    };
  }

  return {
    async prepare(input, context) {
      const id = input["id"];
      if (typeof id !== "string" || !RECIPE_ID_PATTERN.test(id)) {
        return refuse("invalid", RECIPE_TEXT.badId);
      }
      const recipe = await find(id);
      if (recipe === undefined) return refuse("not_found", RECIPE_TEXT.unknown(id));
      const misfit = recipeFits(recipe, await deps.machine());
      if (misfit !== undefined) return refuse("unsupported", misfit);
      const tools: (RegisteredTool | undefined)[] = [];
      for (const step of recipe.steps) {
        if (step.tool === RECIPE_NOTE_TOOL) {
          tools.push(undefined);
          continue;
        }
        const tool = context.registry.get(step.tool);
        const problem = checkStepTool(step.tool, tool, deps.hostServers);
        if (tool === undefined || problem !== undefined) {
          deps.log(`[recipes] ${id}: ${problem ?? `${step.tool} is not available`}`);
          return refuse("unsupported", RECIPE_TEXT.stepUnavailable(id, step.tool));
        }
        tools.push(tool);
      }
      const described = await mapLimit(
        recipe.steps,
        DESCRIBE_STEP_CONCURRENCY,
        async (_, index) => {
          const tool = tools[index];
          const empty: CardDescription = { title: "", detail: "", source: "system" };
          return tool === undefined
            ? empty
            : describeStep(context, tool, recipe.steps[index]?.input ?? {});
        },
      );
      const preset: GatePreset = {
        elements: recipe.steps.map((_, index) => index),
        items: recipe.steps.map((step, index) => {
          const about = described[index] as CardDescription;
          return {
            tool: step.tool,
            description: {
              title: step.title[context.lang],
              detail: [about.title, about.detail]
                .filter((part) => part !== "")
                .join(" — ")
                .slice(0, 1_000),
              source: about.source,
            },
          };
        }),
        resultOf(elementIndex, outcome) {
          const status = reportOf(outcome)?.steps[elementIndex]?.status;
          return status === "ok" ? "ok" : status === "failed" ? "failed" : "skipped";
        },
      };
      return {
        ok: true,
        prepared: {
          recipe,
          preset,
          run: (runInput, signal) => run(recipe, runInput, context, signal),
        },
      };
    },
  };
}
