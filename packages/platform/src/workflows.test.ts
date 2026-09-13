import { describe, expect, it } from "vitest";
import { fillWorkflow, loadWorkflows, parseWorkflow } from "./workflows.js";

describe("parseWorkflow", () => {
  it("parses a file with name, command and description", () => {
    const text = [
      "name: New branch",
      "command: git checkout -b {{branch}}",
      "description: Start a branch",
    ].join("\n");

    expect(parseWorkflow(text)).toEqual({
      name: "New branch",
      command: "git checkout -b {{branch}}",
      description: "Start a branch",
      placeholders: ["branch"],
    });
  });

  it("treats {{branch}} and {{ branch }} as the same placeholder, deduplicated, in first-appearance order", () => {
    // "target" sorts before "branch" alphabetically, so this only passes if
    // the order really is first-appearance rather than an incidental sort.
    const text = [
      "name: Rebase",
      "command: git fetch && git rebase {{ target }} && echo {{branch}} {{target}} {{branch}}",
      "description: Rebase onto a branch",
    ].join("\n");

    expect(parseWorkflow(text)?.placeholders).toEqual(["target", "branch"]);
  });

  it("returns undefined for a file missing `command`", () => {
    const text = ["name: New branch", "description: Start a branch"].join("\n");

    expect(parseWorkflow(text)).toBeUndefined();
  });

  it("returns undefined for text that is not YAML at all, rather than throwing", () => {
    const text = "{ this is not: yaml: at all: [";

    expect(() => parseWorkflow(text)).not.toThrow();
    expect(parseWorkflow(text)).toBeUndefined();
  });

  it("returns undefined for YAML that parses to something other than an object", () => {
    expect(parseWorkflow("- one\n- two\n")).toBeUndefined();
    expect(parseWorkflow("just a string\n")).toBeUndefined();
  });

  it("returns undefined for a file missing `name`", () => {
    const text = ["command: git status", "description: Status"].join("\n");

    expect(parseWorkflow(text)).toBeUndefined();
  });

  it("defaults description to an empty string when absent", () => {
    const text = ["name: Status", "command: git status"].join("\n");

    expect(parseWorkflow(text)).toEqual({
      name: "Status",
      command: "git status",
      description: "",
      placeholders: [],
    });
  });
});

describe("fillWorkflow", () => {
  it("substitutes every occurrence of a placeholder", () => {
    const workflow = parseWorkflow(
      [
        "name: Push",
        "command: git push origin {{branch}} && echo {{branch}} done",
        "description: Push",
      ].join("\n"),
    )!;

    expect(fillWorkflow(workflow, { branch: "main" })).toBe(
      "git push origin main && echo main done",
    );
  });

  it("leaves an unsupplied placeholder in place rather than becoming 'undefined'", () => {
    const workflow = parseWorkflow(
      ["name: Deploy", "command: deploy {{env}} --tag {{tag}}", "description: Deploy"].join("\n"),
    )!;

    expect(fillWorkflow(workflow, { env: "staging" })).toBe("deploy staging --tag {{tag}}");
  });

  it("substitutes both spaced and unspaced forms of the same placeholder", () => {
    const workflow = parseWorkflow(
      [
        "name: Rebase",
        "command: git rebase {{ branch }} && echo {{branch}}",
        "description: Rebase",
      ].join("\n"),
    )!;

    expect(fillWorkflow(workflow, { branch: "main" })).toBe("git rebase main && echo main");
  });
});

describe("loadWorkflows", () => {
  it("parses every workflow file across the given directories", () => {
    const files: Record<string, string> = {
      "/a/one.yaml": "name: One\ncommand: echo one\ndescription: First",
      "/a/two.yaml": "name: Two\ncommand: echo two\ndescription: Second",
      "/b/three.yaml": "name: Three\ncommand: echo three\ndescription: Third",
    };
    const dirs: Record<string, string[]> = {
      "/a": ["one.yaml", "two.yaml"],
      "/b": ["three.yaml"],
    };

    const workflows = loadWorkflows({
      readDir: (path) => dirs[path] ?? [],
      readFile: (path) => {
        const text = files[path];
        if (text === undefined) throw new Error("not found");
        return text;
      },
      paths: ["/a", "/b"],
    });

    expect(workflows.map((w) => w.name)).toEqual(["One", "Two", "Three"]);
  });

  it("skips an unreadable directory rather than throwing", () => {
    const workflows = loadWorkflows({
      readDir: (path) => {
        if (path === "/broken") throw new Error("ENOENT");
        return ["ok.yaml"];
      },
      readFile: () => "name: Ok\ncommand: echo ok\ndescription: Ok",
      paths: ["/broken", "/fine"],
    });

    expect(workflows).toEqual([
      { name: "Ok", command: "echo ok", description: "Ok", placeholders: [] },
    ]);
  });

  it("skips a malformed file rather than throwing", () => {
    const workflows = loadWorkflows({
      readDir: () => ["good.yaml", "bad.yaml"],
      readFile: (path) =>
        path.endsWith("bad.yaml")
          ? "not: valid: yaml: ["
          : "name: Good\ncommand: echo good\ndescription: Good",
      paths: ["/dir"],
    });

    expect(workflows.map((w) => w.name)).toEqual(["Good"]);
  });

  it("returns nothing for a directory that lists no files", () => {
    const workflows = loadWorkflows({
      readDir: () => [],
      readFile: () => {
        throw new Error("should never be read");
      },
      paths: ["/empty"],
    });

    expect(workflows).toEqual([]);
  });

  // "Most specific wins": a later path in `paths` shadows an earlier one
  // that declares a workflow of the same name, deduped down to one entry —
  // callers list the always-read global directory first and a project's
  // own directory last, so the project's own version is what the palette
  // offers. Undated per-project override is how the rest of the app's
  // config works (editors:, clusters:), and disambiguating the palette's
  // labels instead would make the user resolve a collision they never
  // created.
  it("dedupes a name shared across directories, keeping the later (more specific) path's version", () => {
    const files: Record<string, string> = {
      "/global/deploy.yaml": "name: Deploy\ncommand: echo global\ndescription: Global",
      "/project/deploy.yaml": "name: Deploy\ncommand: echo project\ndescription: Project",
    };
    const dirs: Record<string, string[]> = {
      "/global": ["deploy.yaml"],
      "/project": ["deploy.yaml"],
    };

    const workflows = loadWorkflows({
      readDir: (path) => dirs[path] ?? [],
      readFile: (path) => {
        const text = files[path];
        if (text === undefined) throw new Error("not found");
        return text;
      },
      paths: ["/global", "/project"],
    });

    expect(workflows).toEqual([
      { name: "Deploy", command: "echo project", description: "Project", placeholders: [] },
    ]);
  });
});
