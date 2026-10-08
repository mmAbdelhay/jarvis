// Reads docs/os/threat-model.md (design §3.2) and checks that every mitigation
// points at code and at least one test that exist, and that each linked test
// name still appears in its file, so renaming or deleting a test fails CI
// (criterion 2). Links are absolute GitHub URLs so the published docs page works too.
export const REPO_URL = "https://github.com/mmAbdelhay/jarvis/blob/master/";

export type DocLink = { text: string; path: string };
export type MitigationRow = { id: string; actors: string[]; code: DocLink[]; tests: DocLink[] };
export type ThreatModel = {
  assets: string[];
  actors: string[];
  mitigations: MitigationRow[];
  accepted: { id: string; actors: string[] }[];
};

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const TEST_PATH = /(\.test\.ts|_test\.go|\/tst_[A-Za-z0-9_]+\.(cpp|qml))$/;

export function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

function tableRows(text: string): string[][] {
  const rows = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .filter((line) => !/^\|\s*:?-{3,}/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  return rows.slice(1);
}

function links(cell: string): DocLink[] {
  const out: DocLink[] = [];
  for (const match of cell.matchAll(LINK)) {
    const [, text = "", href = ""] = match;
    if (href.startsWith(REPO_URL)) out.push({ text, path: href.slice(REPO_URL.length) });
  }
  return out;
}

const ids = (cell: string | undefined) =>
  (cell ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");

export function parseThreatModel(markdown: string): ThreatModel {
  const firstColumn = (heading: string) =>
    tableRows(section(markdown, heading)).map((row) => row[0] ?? "");
  return {
    assets: firstColumn("Assets"),
    actors: firstColumn("Actors"),
    mitigations: tableRows(section(markdown, "Mitigations")).map((row) => ({
      id: row[0] ?? "",
      actors: ids(row[1]),
      code: links(row[4] ?? ""),
      tests: links(row[5] ?? ""),
    })),
    accepted: tableRows(section(markdown, "Accepted risks")).map((row) => ({
      id: row[0] ?? "",
      actors: ids(row[1]),
    })),
  };
}

export function checkThreatModel(
  model: ThreatModel,
  readRepoFile: (path: string) => string | undefined,
): string[] {
  const problems: string[] = [];
  const known = new Set(model.actors);
  const covered = new Set<string>();
  for (const row of model.mitigations) {
    if (row.tests.length === 0) problems.push(`${row.id}: no test link`);
    if (row.code.length === 0) problems.push(`${row.id}: no code link`);
    for (const actor of row.actors) {
      if (!known.has(actor)) problems.push(`${row.id}: unknown actor ${actor}`);
      covered.add(actor);
    }
    for (const link of [...row.code, ...row.tests]) {
      if (link.path.split("/").includes("..")) {
        problems.push(`${row.id}: linked path leaves the repository: ${link.path}`);
        continue;
      }
      const content = readRepoFile(link.path);
      if (content === undefined) {
        problems.push(`${row.id}: linked file is missing: ${link.path}`);
        continue;
      }
      if (!row.tests.includes(link)) continue;
      if (!TEST_PATH.test(link.path)) problems.push(`${row.id}: not a test file: ${link.path}`);
      else if (!content.includes(link.text)) {
        problems.push(`${row.id}: test "${link.text}" is not in ${link.path}`);
      }
    }
  }
  for (const risk of model.accepted) for (const actor of risk.actors) covered.add(actor);
  for (const actor of model.actors) {
    if (!covered.has(actor))
      problems.push(`${actor}: no mitigation or accepted risk names this actor`);
  }
  return problems;
}
