// Rafiq M4 contracts §4: a setup recipe file and the tools its steps may use.
// The recipe card is the ONLY approval its steps get, so a step may call only
// a setup tool of a built-in server that needs no password. Pure.
import { RECIPE_TEXT } from "./messages.js";
import type { RegisteredTool } from "./tool-registry.js";
import { isRecord } from "./types.js";

export const RECIPE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_RECIPE_STEPS = 20;
const MAX_STEP_INPUT_CHARS = 16_384;
const MAX_STEP_ITEMS = 200;
/** Contracts §6 #2: a non-executing instruction step shown on the card. */
export const RECIPE_NOTE_TOOL = "note";
export const RECIPE_RUN_TOOL = "recipes.run";
/** "steps may only use built-in trusted tools", narrowed to what setting a machine up needs. */
export const RECIPE_STEP_TOOLS: ReadonlySet<string> = new Set([
  "pkg.install",
  "svc.restart",
  "apps.set_default",
]);

export type RecipeText = { en: string; ar: string };
export type RecipeStep = { tool: string; input: Record<string, unknown>; title: RecipeText };
export type Recipe = {
  id: string;
  title: RecipeText;
  description: RecipeText;
  steps: RecipeStep[];
  requires: { os: string; minRamGB?: number };
  /** Contracts §6 #15: false means the recipe ships but must not run (default true). */
  available: boolean;
};
export type ParsedRecipe = { ok: true; recipe: Recipe } | { ok: false; error: string };
export type RecipeMachine = { osId: string | null; memTotalBytes: number | null };
export type StepTool = Pick<RegisteredTool, "name" | "server" | "risk" | "secrets" | "hidden">;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
const CONTROL = /[\u0000-\u001f\u007f]/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function recipeText(value: unknown, max: number): RecipeText | undefined {
  if (!isRecord(value)) return undefined;
  const good = (text: unknown): text is string =>
    typeof text === "string" && text.trim() !== "" && text.length <= max && !CONTROL.test(text);
  const { en, ar } = value;
  return good(en) && good(ar) ? { en, ar } : undefined;
}

/** JSON data only, no prototype keys anywhere, at most 8 levels deep. */
function plainJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => plainJson(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, item]) => !FORBIDDEN_KEYS.has(key) && plainJson(item, depth + 1),
  );
}

export function parseRecipe(raw: unknown): ParsedRecipe {
  const fail = (error: string): ParsedRecipe => ({ ok: false, error });
  if (!isRecord(raw)) return fail("a recipe must be an object");
  const { id, title, description, steps, requires } = raw;
  if (typeof id !== "string" || !RECIPE_ID_PATTERN.test(id)) {
    return fail("a recipe id must be a-z, 0-9 and -, up to 32 characters");
  }
  const where = `recipe ${id}`;
  const recipeTitle = recipeText(title, 200);
  if (recipeTitle === undefined) return fail(`${where}: title needs en and ar`);
  const recipeDescription = recipeText(description, 1_000);
  if (recipeDescription === undefined) return fail(`${where}: description needs en and ar`);
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_RECIPE_STEPS) {
    return fail(`${where}: steps must be a list of 1-${MAX_RECIPE_STEPS}`);
  }
  const parsedSteps: RecipeStep[] = [];
  for (const [index, step] of steps.entries()) {
    const at = `${where}: steps[${index}]`;
    if (!isRecord(step)) return fail(`${at} must be an object`);
    const { tool, input } = step;
    if (tool === RECIPE_NOTE_TOOL) {
      const noteTitle = recipeText(step["title"], 1_000);
      if (noteTitle === undefined) return fail(`${at}: title needs en and ar`);
      if (input !== undefined && !(isRecord(input) && Object.keys(input).length === 0)) {
        return fail(`${at}: a note step takes no input`);
      }
      parsedSteps.push({ tool, input: {}, title: noteTitle });
      continue;
    }
    if (typeof tool !== "string" || !RECIPE_STEP_TOOLS.has(tool)) {
      return fail(`${at}: tool must be one of ${[...RECIPE_STEP_TOOLS].join(", ")}`);
    }
    if (!isRecord(input) || !plainJson(input)) return fail(`${at}: input must be a JSON object`);
    const json = JSON.stringify(input);
    if (json.length > MAX_STEP_INPUT_CHARS) return fail(`${at}: input is too large`);
    const items = input["items"];
    if (
      items !== undefined &&
      (!Array.isArray(items) || items.length === 0 || items.length > MAX_STEP_ITEMS)
    ) {
      return fail(`${at}: items must be a list of 1-${MAX_STEP_ITEMS}`);
    }
    const stepTitle = recipeText(step["title"], 200);
    if (stepTitle === undefined) return fail(`${at}: title needs en and ar`);
    parsedSteps.push({
      tool,
      input: JSON.parse(json) as Record<string, unknown>,
      title: stepTitle,
    });
  }
  if (!isRecord(requires)) return fail(`${where}: requires must be an object`);
  const os = requires["os"];
  if (typeof os !== "string" || !RECIPE_ID_PATTERN.test(os)) {
    return fail(`${where}: requires.os must name an os id`);
  }
  const minRamGB = requires["minRamGB"];
  if (
    minRamGB !== undefined &&
    (typeof minRamGB !== "number" ||
      !Number.isFinite(minRamGB) ||
      minRamGB <= 0 ||
      minRamGB > 1_024)
  ) {
    return fail(`${where}: requires.minRamGB must be more than 0 and at most 1024`);
  }
  const available = raw["available"];
  if (available !== undefined && typeof available !== "boolean") {
    return fail(`${where}: available must be true or false`);
  }
  return {
    ok: true,
    recipe: {
      id,
      title: recipeTitle,
      description: recipeDescription,
      steps: parsedSteps,
      requires: { os, ...(minRamGB === undefined ? {} : { minRamGB }) },
      available: available !== false,
    },
  };
}

/** A model-facing reason the recipe cannot run here, or undefined. MemTotal
 *  is a little under the installed RAM; §6 #3 fits at 90%. */
export function recipeFits(recipe: Recipe, machine: RecipeMachine): string | undefined {
  if (!recipe.available) return RECIPE_TEXT.notAvailable(recipe.id);
  if (machine.osId !== recipe.requires.os) {
    return RECIPE_TEXT.wrongOs(recipe.id, recipe.requires.os);
  }
  const min = recipe.requires.minRamGB;
  if (
    min !== undefined &&
    machine.memTotalBytes !== null &&
    machine.memTotalBytes < min * 1024 ** 3 * 0.9
  ) {
    return RECIPE_TEXT.tooLittleRam(recipe.id, min);
  }
  return undefined;
}

/** Why `tool` may not run as a recipe step (for the log), or undefined. */
export function checkStepTool(
  name: string,
  tool: StepTool | undefined,
  hostServers: ReadonlySet<string>,
): string | undefined {
  if (!RECIPE_STEP_TOOLS.has(name)) return `${name} may not be a recipe step`;
  if (tool === undefined || tool.name !== name) return `${name} is not available`;
  if (!hostServers.has(tool.server))
    return `${name} comes from ${tool.server}, not a built-in server`;
  if (tool.hidden) return `${name} is hidden`;
  if (tool.risk === "password" || tool.secrets.length > 0) return `${name} needs a password`;
  return undefined;
}
