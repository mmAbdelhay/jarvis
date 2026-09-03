// Saved workflows: parameterised commands the user keeps as YAML files and
// chooses from the ⌘P palette, filled into the editor.
//
// Everything here is pure — the shape completion.ts and zsh-integration.ts
// established. parseWorkflow and fillWorkflow take text and values, never
// paths; loadWorkflows takes its directory listing and file reads injected,
// so none of this ever touches a real filesystem in a test.
//
// parseWorkflow never throws. A malformed file is a workflow the user does
// not get, not a terminal that fails to open — the same reasoning
// parseZshHistory's "skip a bad line" documents, taken one step further
// because here a bad *file* must not cost every other workflow either.

import { parse } from "yaml";

export type Workflow = {
  name: string;
  command: string;
  description: string;
  placeholders: string[];
};

/** The `workflows:` section of jarvis.yaml: project name → the directory
 *  of workflow files for that project, in addition to the always-read
 *  `~/.config/jarvis/workflows/`. */
export type WorkflowsConfig = Record<string, string>;

/** `{{name}}` and `{{ name }}` alike — surrounding whitespace inside the
 *  braces is part of the delimiter, not the name. A fresh RegExp per call:
 *  a module-level `g`-flagged regex is stateful across calls, and this is
 *  cheap enough that sharing one buys nothing but a subtle bug. */
function placeholderPattern(): RegExp {
  return /\{\{\s*([^\s{}]+)\s*\}\}/g;
}

/** Every placeholder `command` names, deduplicated, in first-appearance
 *  order — the order the palette prompts for them in. */
function placeholdersOf(command: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of command.matchAll(placeholderPattern())) {
    const name = match[1];
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

/**
 * The text of one workflow file → a Workflow, or undefined when it is not
 * one — text that is not YAML at all, YAML that is not an object, or an
 * object missing a non-empty `name` or `command`. Never throws.
 *
 * `description` defaults to "" when absent: it is shown, never substituted
 * into, so there is nothing a missing one breaks.
 */
export function parseWorkflow(text: string): Workflow | undefined {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return undefined;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return undefined;
  const raw = doc as Record<string, unknown>;

  const name = raw["name"];
  if (typeof name !== "string" || name === "") return undefined;

  const command = raw["command"];
  if (typeof command !== "string" || command === "") return undefined;

  const rawDescription = raw["description"];
  const description = typeof rawDescription === "string" ? rawDescription : "";

  return { name, command, description, placeholders: placeholdersOf(command) };
}

/** `workflow.command` with every occurrence of each supplied placeholder
 *  substituted. A placeholder with no entry in `values` — the user hit
 *  Escape on it, or it was simply never asked for — stays in the text
 *  rather than becoming the string "undefined". */
export function fillWorkflow(workflow: Workflow, values: Record<string, string>): string {
  return workflow.command.replace(placeholderPattern(), (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : value;
  });
}

export type LoadWorkflowsDeps = {
  /** File names within a directory — not full paths. Thrown for a
   *  directory that does not exist or cannot be read. */
  readDir: (path: string) => string[];
  /** The text of one file, addressed by `${dir}/${name}`. */
  readFile: (path: string) => string;
  /** The directories to read, in order — `loadConfig`'s always-read
   *  `~/.config/jarvis/workflows/` plus whatever `workflows:` names for
   *  the current project. */
  paths: string[];
};

/**
 * Every workflow across `deps.paths`, in directory order and then
 * directory-listing order. A directory that cannot be listed is skipped,
 * not fatal — the same "a bad source costs only itself" rule
 * `parseWorkflow` follows for a single bad file, and `zshWrapperFiles`'s
 * caller follows for a shell integration that fails to install. Never
 * throws.
 */
export function loadWorkflows(deps: LoadWorkflowsDeps): Workflow[] {
  const workflows: Workflow[] = [];
  for (const dir of deps.paths) {
    let names: string[];
    try {
      names = deps.readDir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      let text: string;
      try {
        text = deps.readFile(`${dir}/${name}`);
      } catch {
        continue;
      }
      const workflow = parseWorkflow(text);
      if (workflow !== undefined) workflows.push(workflow);
    }
  }
  return workflows;
}
