import { describe, expect, it } from "vitest";
import { PYTHON } from "./__fixtures__/recipes.js";
import { RECIPE_TEXT } from "./messages.js";
import { createRecipeEngine, type RecipeContext, type RecipeRunReport } from "./recipe-engine.js";
import type { RegisteredTool } from "./tool-registry.js";
import type { ToolOutcome } from "./types.js";

const registered = (name: string, extra: Partial<RegisteredTool> = {}): RegisteredTool => ({
  name,
  modelName: name.replace(".", "_"),
  server: name.startsWith("svc.") ? "jarvis-diag" : "jarvis-pkg",
  description: name,
  risk: "confirm",
  hidden: false,
  secrets: [],
  batchItems: name === "pkg.install",
  inputSchema: {},
  modelSchema: {},
  ...extra,
});

function setup(options: {
  recipes?: unknown[];
  osId?: string;
  memGB?: number;
  tools?: Map<string, RegisteredTool>;
  fail?: number;
}) {
  const tools =
    options.tools ??
    new Map([
      ["pkg.install", registered("pkg.install")],
      ["svc.restart", registered("svc.restart")],
    ]);
  const logs: string[] = [];
  const described: { tool: string; input: Record<string, unknown>; lang: string }[] = [];
  const ran: number[] = [];
  const engine = createRecipeEngine({
    load: async () => options.recipes ?? [PYTHON],
    machine: async () => ({
      osId: options.osId ?? "rafiq",
      memTotalBytes: (options.memGB ?? 16) * 1024 ** 3,
    }),
    hostServers: new Set(["jarvis-pkg", "jarvis-diag"]),
    log: (line) => logs.push(line),
  });
  const context: RecipeContext = {
    registry: {
      get: (name) => tools.get(name),
      describe: async (tool, input, lang = "en") => {
        described.push({ tool: tool.name, input, lang });
        const what = JSON.stringify(input["items"] ?? input["unit"]);
        return { title: `${tool.name} ${what}`, detail: "", source: "debian" };
      },
    },
    lang: "ar",
    callStep: async (index): Promise<ToolOutcome> => {
      ran.push(index);
      return index === options.fail
        ? { ok: false, data: null, text: "E: Unable to locate package", code: "not_found" }
        : { ok: true, data: {}, text: "{}" };
    },
  };
  return { engine, context, logs, described, ran };
}

const report = (outcome: ToolOutcome) => outcome.data as RecipeRunReport;

describe("recipe card (M4 §4)", () => {
  it("shows every step as its own item, in the turn language", async () => {
    const { engine, context, described } = await setup({});
    const prepared = await engine.prepare({ id: "python-dev" }, context);
    if (!prepared.ok) throw new Error(prepared.outcome.text);
    const { preset } = prepared.prepared;
    expect(preset.elements).toEqual([0, 1, 2]);
    expect(preset.items.map((i) => i.tool)).toEqual(["pkg.install", "pkg.install", "svc.restart"]);
    expect(preset.items.map((i) => i.description.title)).toEqual([
      "تثبيت بايثون",
      "تثبيت venv",
      "إعادة تشغيل SSH",
    ]);
    // A batch step is described one package at a time, like any batch card.
    expect(described.filter((d) => d.tool === "pkg.install")).toHaveLength(3);
    expect(described.every((d) => d.lang === "ar")).toBe(true);
    expect(preset.items[0]?.description.detail).toContain("python3-pip");
    expect(preset.items[0]?.description.source).toBe("debian");
  });

  it("refuses what it cannot run, with a reason for the model", async () => {
    const cases: [Parameters<typeof setup>[0], Record<string, unknown>, string][] = [
      [{}, { id: "Python!" }, RECIPE_TEXT.badId],
      [{}, { id: "rust-dev" }, RECIPE_TEXT.unknown("rust-dev")],
      [{ osId: "debian" }, { id: "python-dev" }, RECIPE_TEXT.wrongOs("python-dev", "rafiq")],
      [{ memGB: 2 }, { id: "python-dev" }, RECIPE_TEXT.tooLittleRam("python-dev", 4)],
      [
        { tools: new Map([["pkg.install", registered("pkg.install")]]) },
        { id: "python-dev" },
        RECIPE_TEXT.stepUnavailable("python-dev", "svc.restart"),
      ],
      [
        {
          tools: new Map([
            ["pkg.install", registered("pkg.install", { server: "acme-tools" })],
            ["svc.restart", registered("svc.restart")],
          ]),
        },
        { id: "python-dev" },
        RECIPE_TEXT.stepUnavailable("python-dev", "pkg.install"),
      ],
      [
        {
          tools: new Map([
            ["pkg.install", registered("pkg.install", { risk: "password" })],
            ["svc.restart", registered("svc.restart")],
          ]),
        },
        { id: "python-dev" },
        RECIPE_TEXT.stepUnavailable("python-dev", "pkg.install"),
      ],
    ];
    for (const [options, input, text] of cases) {
      const { engine, context } = setup(options);
      const prepared = await engine.prepare(input, context);
      expect(prepared.ok).toBe(false);
      if (!prepared.ok) expect(prepared.outcome.text).toBe(text);
    }
  });

  it("skips broken recipe files, logs each once, and still finds the good ones", async () => {
    const { engine, context, logs } = setup({ recipes: [{ id: "broken" }, PYTHON] });
    expect((await engine.prepare({ id: "python-dev" }, context)).ok).toBe(true);
    await engine.prepare({ id: "python-dev" }, context);
    expect(logs).toHaveLength(1);
  });
});

describe("recipe run (M4 §4)", () => {
  async function prepared(options: Parameters<typeof setup>[0]) {
    const s = setup(options);
    const result = await s.engine.prepare({ id: "python-dev" }, s.context);
    if (!result.ok) throw new Error(result.outcome.text);
    return { ...s, recipe: result.prepared };
  }

  it("runs the ticked steps in order and skips the unticked one", async () => {
    const { recipe, ran } = await prepared({});
    const outcome = await recipe.run({ id: "python-dev", items: [0, 2] });
    expect(ran).toEqual([0, 2]);
    expect(outcome.ok).toBe(true);
    expect(report(outcome).steps.map((s) => s.status)).toEqual(["ok", "skipped", "ok"]);
    expect(report(outcome).steps[0]?.title).toBe("Install Python");
  });

  it("stops at the first failure: later ticked steps are not-run", async () => {
    const { recipe, ran } = await prepared({ fail: 0 });
    const outcome = await recipe.run({ id: "python-dev", items: [0, 1, 2] });
    expect(ran).toEqual([0]);
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("not_found");
    expect(report(outcome).steps).toEqual([
      {
        step: 0,
        title: "Install Python",
        tool: "pkg.install",
        status: "failed",
        code: "not_found",
      },
      { step: 1, title: "Install venv", tool: "pkg.install", status: "not-run" },
      { step: 2, title: "Restart SSH", tool: "svc.restart", status: "not-run" },
    ]);
    expect(outcome.text).toContain(RECIPE_TEXT.stepFailed("Install Python"));
    expect(outcome.text).toContain("Unable to locate package");
  });

  it("maps each card item to its own audit result", async () => {
    const { recipe } = await prepared({ fail: 1 });
    const outcome = await recipe.run({ id: "python-dev", items: [0, 1, 2] });
    expect([0, 1, 2].map((i) => recipe.preset.resultOf(i, outcome))).toEqual([
      "ok",
      "failed",
      "skipped",
    ]);
  });

  it("re-checks each step tool when it runs", async () => {
    const tools = new Map([
      ["pkg.install", registered("pkg.install")],
      ["svc.restart", registered("svc.restart")],
    ]);
    const { recipe, ran } = await prepared({ tools });
    tools.delete("svc.restart");
    const outcome = await recipe.run({ id: "python-dev", items: [0, 2] });
    expect(ran).toEqual([0]);
    expect(report(outcome).steps[2]).toMatchObject({ status: "failed", code: "unsupported" });
  });

  it("shows a note step as an item and never executes it", async () => {
    const note = { tool: "note", title: { en: "Log out and back in", ar: "سجّل الخروج ثم الدخول" } };
    const s = setup({ recipes: [{ ...PYTHON, steps: [PYTHON.steps[1], note] }] });
    const result = await s.engine.prepare({ id: "python-dev" }, s.context);
    if (!result.ok) throw new Error(result.outcome.text);
    expect(result.prepared.preset.items.map((i) => i.tool)).toEqual(["pkg.install", "note"]);
    expect(result.prepared.preset.items[1]?.description.title).toBe("سجّل الخروج ثم الدخول");
    const outcome = await result.prepared.run({ id: "python-dev", items: [0, 1] });
    expect(s.ran).toEqual([0]);
    expect(report(outcome).steps.map((x) => x.status)).toEqual(["ok", "ok"]);
  });

  it("stops between steps when the user stops the turn", async () => {
    const { recipe, ran } = await prepared({});
    const controller = new AbortController();
    controller.abort();
    const outcome = await recipe.run({ id: "python-dev", items: [0] }, controller.signal);
    expect(ran).toEqual([]);
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("stopped");
  });
});
