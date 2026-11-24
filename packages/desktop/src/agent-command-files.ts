// Reads the three things the composer shows of a command or skill file: its
// name (when the front matter gives a valid one), a one-line description and
// the argument hint. Nothing else leaves the file; a body is never kept.

export type CommandFileMeta = {
  name?: string;
  description?: string;
  hint?: string;
  hidden: boolean;
};

export const COMMAND_NAME = /^[A-Za-z][A-Za-z0-9:._-]{0,60}$/;
const DESCRIPTION_MAX = 200;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
const CONTROL = /[\x00-\x1f\x7f]/g;

function tidy(text: string, max = DESCRIPTION_MAX): string | undefined {
  const cleaned = text
    .replaceAll(CONTROL, "")
    .replace(/\s+/g, " ")
    .replace(/^["']|["']$/g, "")
    .trim();
  return cleaned === "" ? undefined : cleaned.slice(0, max);
}

export function parseCommandFile(text: string): CommandFileMeta {
  const lines = text.split(/\r?\n/);
  const meta: CommandFileMeta = { hidden: false };
  let body = lines;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    const front = end === -1 ? lines.slice(1) : lines.slice(1, end);
    for (let at = 0; at < front.length; at++) {
      const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(front[at] ?? "");
      if (match === null) continue;
      const key = (match[1] ?? "").toLowerCase().replaceAll("_", "-");
      let value = (match[2] ?? "").trim();
      if (/^[>|][+-]?$/.test(value)) {
        const block: string[] = [];
        while (at + 1 < front.length && /^(\s|$)/.test(front[at + 1] ?? "")) {
          block.push((front[++at] ?? "").trim());
        }
        value = block.join(" ");
      }
      if (key === "name") {
        const name = value.replace(/^["']|["']$/g, "").trim();
        if (COMMAND_NAME.test(name)) meta.name = name;
      } else if (key === "description") {
        const description = tidy(value);
        if (description !== undefined) meta.description = description;
      } else if (key === "argument-hint") {
        const hint = tidy(value, 80);
        if (hint !== undefined) meta.hint = hint;
      } else if (key === "user-invocable" || key === "hidden") {
        const flag = value.toLowerCase();
        if (
          (key === "user-invocable" && flag === "false") ||
          (key === "hidden" && flag === "true")
        ) {
          meta.hidden = true;
        }
      }
    }
    body = end === -1 ? [] : lines.slice(end + 1);
  }
  if (meta.description === undefined) {
    for (const line of body) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#") || trimmed === "---") continue;
      const description = tidy(trimmed);
      if (description !== undefined) meta.description = description;
      break;
    }
  }
  return meta;
}
