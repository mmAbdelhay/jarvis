// The markdown an agent's reply is drawn with in the Chat view, and how a link
// is labelled. It began as a rule-for-rule port of the phone's chat-text.ts and
// linkParts (apps/mobile/src/lib); the desktop now reads more than the phone
// (headings, nested lists, tables, quotes, italics, strikethrough, file paths),
// so the two no longer match rule for rule and the phone is unchanged. Pure
// data: nothing here touches the DOM; code.ts draws it with text nodes only.
// Every scan is linear (no backtracking pattern runs over the reply) and
// nesting stops at MAX_DEPTH, so a hostile or half-streamed reply stays cheap.
export type ChatAlign = "left" | "center" | "right" | undefined;

export type ChatInline =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: ChatInline[] }
  | { kind: "italic"; children: ChatInline[] }
  | { kind: "strike"; children: ChatInline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string }
  /** A file named in the reply: in a code span (`code`) or plain text. */
  | { kind: "path"; text: string; path: string; line?: number; code: boolean };

export type ChatListItem = {
  marker: string;
  inlines: ChatInline[];
  /** A task item: [ ] false, [x] true. */
  checked?: boolean;
  /** What sits under the item's first paragraph: nested lists, fences, more paragraphs. */
  children?: ChatBlock[];
};

export type ChatBlock =
  | { kind: "para"; inlines: ChatInline[] }
  | { kind: "heading"; level: number; inlines: ChatInline[] }
  | { kind: "list"; ordered: boolean; items: ChatListItem[] }
  | { kind: "codeBlock"; text: string; lang?: string }
  | { kind: "quote"; blocks: ChatBlock[] }
  | { kind: "table"; align: ChatAlign[]; head: ChatInline[][]; rows: ChatInline[][][] }
  | { kind: "rule" };

/** How deep emphasis, lists and quotes nest; past it the markers stay text. */
const MAX_DEPTH = 8;

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);
const isPunct = (ch: string | undefined): boolean => ch !== undefined && /[\p{P}\p{S}]/u.test(ch);

// ---- file paths -------------------------------------------------------------

/** Extensions a bare `name.ext` in a code span may carry and still be a file. */
const BARE_EXTENSIONS = new Set(
  "ts tsx js jsx mjs cjs json jsonc md mdx py rs go java kt swift c h cpp hpp cs rb php css scss html htm vue svelte yml yaml toml ini cfg conf sh bash zsh txt lock xml sql env pdf png jpg jpeg gif svg webp csv tsv log gradle plist".split(
    " ",
  ),
);

const hasControl = (value: string): boolean => {
  for (let at = 0; at < value.length; at++) if (value.charCodeAt(at) < 32) return true;
  return false;
};

/**
 * The file a piece of text names, with an optional :line, or undefined.
 * Careful on purpose: a command (`npm run x/y`), a URL, `origin/master` and
 * `and/or` are not files. A relative path needs a file extension; an absolute
 * one (or ./ ../ ~/) needs one too unless it is at least two names deep, so a
 * slash command like /clear is not a path. In plain text a bare `name.ext`
 * (no slash) is never taken: prose is full of those ("e.g.", "v1.2").
 */
export function filePathOf(
  value: string,
  options: { code: boolean },
): { path: string; line?: number } | undefined {
  if (value.length === 0 || value.length > 300) return undefined;
  let path = value;
  let line: number | undefined;
  // :12 or :12:5 — the line is the first number, the column is dropped.
  const suffix = /:(\d{1,7})(?::\d{1,7})?$/.exec(value);
  if (suffix !== null) {
    line = Number(suffix[1]);
    path = value.slice(0, suffix.index);
  }
  if (path.length === 0 || /[\s:*?<>|"'`\\]/.test(path) || hasControl(path)) return undefined;
  const prefixed = path.startsWith("/") || /^(\.\.?|~)\//.test(path);
  if (path.startsWith("//") || path.endsWith("/") || path.includes("//")) return undefined;
  const segments = path.split("/").filter((part) => part !== "" && part !== "." && part !== "..");
  const base = segments[segments.length - 1];
  if (base === undefined || base === "~") return undefined;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1) : "";
  const hasExt = /^[A-Za-z][A-Za-z0-9]{0,9}$/.test(ext);
  const slashed = path.includes("/");
  let ok: boolean;
  if (prefixed) ok = hasExt || segments.length >= 2;
  else if (slashed) ok = hasExt;
  else ok = options.code && hasExt && BARE_EXTENSIONS.has(ext.toLowerCase());
  if (!ok) return undefined;
  return line === undefined ? { path } : { path, line };
}

/** A short label for a long path: the end of it kept, the front given up. */
export function pathLabel(path: string, max = 40): string {
  if (path.length <= max) return path;
  const parts = path.split("/").filter((part) => part !== "");
  let label = parts[parts.length - 1] ?? path;
  if (label.length + 2 > max) {
    const room = max - 1;
    const head = Math.ceil(room / 2) - 1;
    return `${label.slice(0, head)}…${label.slice(label.length - (room - head))}`;
  }
  for (let at = parts.length - 2; at >= 0; at--) {
    const next = `${parts[at]}/${label}`;
    if (next.length + 2 > max) break;
    label = next;
  }
  return `…/${label}`;
}

// ---- inlines ----------------------------------------------------------------

type Frame = { ch: string; count: number; children: ChatInline[] };

function pushNode(list: ChatInline[], node: ChatInline): void {
  const last = list[list.length - 1];
  if (node.kind === "text" && last?.kind === "text") last.text += node.text;
  else list.push(node);
}

function flattenFrame(into: Frame, frame: Frame): void {
  pushNode(into.children, { kind: "text", text: frame.ch.repeat(frame.count) });
  for (const child of frame.children) pushNode(into.children, child);
}

/** A trailing run of these is the sentence's, not the URL's. */
const URL_TAIL = ")].,;:!?*_~";

/** Splits plain text around the paths in it; the words stay as they were. */
function withPaths(text: string): ChatInline[] {
  const out: ChatInline[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/\S+/g)) {
    const token = match[0];
    const at = match.index ?? 0;
    let from = 0;
    while (from < token.length && "([{\"'<".includes(token[from] ?? "")) from++;
    let to = token.length;
    while (to > from && ")]}\"'>.,;:!?".includes(token[to - 1] ?? "")) to--;
    const core = token.slice(from, to);
    // Only a token with a slash: "e.g." and "v1.2" are words.
    if (!core.includes("/")) continue;
    const found = filePathOf(core, { code: false });
    if (found === undefined) continue;
    if (at + from > cursor) pushNode(out, { kind: "text", text: text.slice(cursor, at + from) });
    out.push({
      kind: "path",
      text: core,
      path: found.path,
      ...(found.line === undefined ? {} : { line: found.line }),
      code: false,
    });
    cursor = at + to;
  }
  if (cursor < text.length) pushNode(out, { kind: "text", text: text.slice(cursor) });
  return out;
}

function pathsIn(inlines: ChatInline[]): ChatInline[] {
  const out: ChatInline[] = [];
  for (const inline of inlines) {
    if (inline.kind === "text") for (const part of withPaths(inline.text)) pushNode(out, part);
    else if (inline.kind === "bold" || inline.kind === "italic" || inline.kind === "strike")
      out.push({ kind: inline.kind, children: pathsIn(inline.children) });
    else out.push(inline);
  }
  return out;
}

function parseInlines(text: string): ChatInline[] {
  const root: Frame = { ch: "", count: 0, children: [] };
  const frames: Frame[] = [root];
  const top = (): Frame => frames[frames.length - 1] as Frame;
  const length = text.length;
  let textStart = 0;
  let linkFailUntil = -1;
  const flush = (upto: number): void => {
    if (upto > textStart)
      pushNode(top().children, { kind: "text", text: text.slice(textStart, upto) });
  };
  let i = 0;
  while (i < length) {
    const ch = text[i] as string;
    if (ch === "\n") {
      // Emphasis never crosses a line: what is open stays literal.
      flush(i);
      textStart = i;
      while (frames.length > 1) {
        const closed = frames.pop() as Frame;
        flattenFrame(top(), closed);
      }
      i++;
    } else if (ch === "`") {
      let run = i;
      while (text[run] === "`") run++;
      if (run - i === 1) {
        let end = i + 1;
        while (end < length && text[end] !== "`" && text[end] !== "\n") end++;
        if (end < length && text[end] === "`" && end > i + 1 && text[end + 1] !== "`") {
          flush(i);
          const code = text.slice(i + 1, end);
          const found = filePathOf(code, { code: true });
          pushNode(
            top().children,
            found === undefined
              ? { kind: "code", text: code }
              : {
                  kind: "path",
                  text: code,
                  path: found.path,
                  ...(found.line === undefined ? {} : { line: found.line }),
                  code: true,
                },
          );
          i = end + 1;
          textStart = i;
          continue;
        }
      }
      i = run;
    } else if (ch === "[" && i >= linkFailUntil) {
      let close = i + 1;
      while (close < length && text[close] !== "]" && text[close] !== "\n") close++;
      let linked = false;
      if (text[close] === "]" && text.startsWith("(https://", close + 1)) {
        let end = close + 10;
        while (end < length && text[end] !== ")" && !isSpace(text[end])) end++;
        if (text[end] === ")" && end > close + 10) {
          flush(i);
          pushNode(top().children, {
            kind: "link",
            text: text.slice(i + 1, close),
            url: text.slice(close + 2, end),
          });
          i = end + 1;
          textStart = i;
          linked = true;
        }
      }
      if (!linked) {
        // Every [ before this ] fails the same way: do not look again.
        linkFailUntil = close;
        i++;
      }
    } else if (ch === "h" && text.startsWith("https://", i)) {
      let end = i + 8;
      while (end < length && !isSpace(text[end])) end++;
      let trimmed = end;
      while (trimmed > i + 8 && URL_TAIL.includes(text[trimmed - 1] as string)) trimmed--;
      if (trimmed > i + 8) {
        flush(i);
        const url = text.slice(i, trimmed);
        pushNode(top().children, { kind: "link", text: url, url });
        i = trimmed;
        textStart = i;
      } else i += 8;
    } else if (ch === "*" || ch === "_" || ch === "~") {
      let run = i;
      while (text[run] === ch) run++;
      const count = run - i;
      const before = i > 0 ? text[i - 1] : undefined;
      const after = run < length ? text[run] : undefined;
      if (ch === "~" && count !== 2) {
        i = run;
        continue;
      }
      const leftFlank =
        after !== undefined &&
        !isSpace(after) &&
        (!isPunct(after) || before === undefined || isSpace(before) || isPunct(before));
      const rightFlank =
        before !== undefined &&
        !isSpace(before) &&
        (!isPunct(before) || after === undefined || isSpace(after) || isPunct(after));
      // _ never opens or closes inside a word: snake_case stays as written.
      const canOpen = ch === "_" ? leftFlank && (!rightFlank || isPunct(before)) : leftFlank;
      const canClose = ch === "_" ? rightFlank && (!leftFlank || isPunct(after)) : rightFlank;
      if (!canOpen && !canClose) {
        i = run;
        continue;
      }
      flush(i);
      let left = count;
      if (canClose) {
        while (left > 0) {
          let found = -1;
          for (let k = frames.length - 1; k >= 1; k--) {
            const candidate = frames[k] as Frame;
            if (candidate.ch === ch && candidate.children.length > 0 && (ch !== "~" || left >= 2)) {
              found = k;
              break;
            }
          }
          if (found < 0) break;
          while (frames.length - 1 > found) {
            const closed = frames.pop() as Frame;
            flattenFrame(top(), closed);
          }
          const frame = frames[found] as Frame;
          const take = ch === "~" ? 2 : Math.min(frame.count, left) >= 2 ? 2 : 1;
          const kind = ch === "~" ? "strike" : take === 2 ? "bold" : "italic";
          const node: ChatInline = { kind, children: frame.children };
          frame.count -= take;
          left -= take;
          if (frame.count > 0) frame.children = [node];
          else {
            frames.pop();
            pushNode(top().children, node);
          }
        }
      }
      if (left > 0 && canOpen && frames.length <= MAX_DEPTH) {
        frames.push({ ch, count: left, children: [] });
      } else if (left > 0) {
        pushNode(top().children, { kind: "text", text: ch.repeat(left) });
      }
      textStart = run;
      i = run;
    } else i++;
  }
  flush(length);
  while (frames.length > 1) {
    const closed = frames.pop() as Frame;
    flattenFrame(top(), closed);
  }
  return pathsIn(root.children);
}

// ---- blocks -----------------------------------------------------------------

const indentOf = (line: string): number => {
  let at = 0;
  while (line.charCodeAt(at) === 32) at++;
  return at;
};
const isBlank = (line: string): boolean => {
  for (let at = 0; at < line.length; at++) {
    const code = line.charCodeAt(at);
    if (code !== 32 && code !== 9 && code !== 13) return false;
  }
  return true;
};

/** Leading tabs count as four spaces, so nesting by tab reads like nesting by spaces. */
function expandTabs(line: string): string {
  let at = 0;
  while (line.charCodeAt(at) === 32 || line.charCodeAt(at) === 9) at++;
  if (!line.slice(0, at).includes("\t")) return line;
  let columns = 0;
  for (const ch of line.slice(0, at)) columns += ch === "\t" ? 4 : 1;
  return " ".repeat(columns) + line.slice(at);
}

type Marker = { indent: number; ordered: boolean; marker: string; offset: number; text: string };

function markerOf(line: string): Marker | undefined {
  const indent = indentOf(line);
  const ch = line[indent];
  if (ch === "-" || ch === "*" || ch === "+") {
    if (line[indent + 1] !== " ") return undefined;
    return {
      indent,
      ordered: false,
      marker: "•",
      offset: indent + 2,
      text: line.slice(indent + 2).trimStart(),
    };
  }
  let at = indent;
  while (at < indent + 9 && line.charCodeAt(at) >= 48 && line.charCodeAt(at) <= 57) at++;
  if (at === indent) return undefined;
  const stop = line[at];
  if ((stop !== "." && stop !== ")") || line[at + 1] !== " ") return undefined;
  return {
    indent,
    ordered: true,
    marker: line.slice(indent, at + 1),
    offset: at + 2,
    text: line.slice(at + 2).trimStart(),
  };
}

function isRule(line: string): boolean {
  if (indentOf(line) > 3) return false;
  let mark: string | undefined;
  let count = 0;
  for (const ch of line) {
    if (ch === " " || ch === "\t" || ch === "\r") continue;
    if (ch !== "-" && ch !== "*" && ch !== "_") return false;
    if (mark !== undefined && ch !== mark) return false;
    mark = ch;
    count++;
  }
  return count >= 3;
}

function headingOf(line: string): { level: number; text: string } | undefined {
  const indent = indentOf(line);
  if (indent > 3) return undefined;
  let at = indent;
  while (line[at] === "#") at++;
  const level = at - indent;
  if (level < 1 || level > 6 || (line[at] !== " " && line[at] !== "\t")) return undefined;
  let end = line.length;
  while (end > at && (line[end - 1] === " " || line[end - 1] === "\t" || line[end - 1] === "\r"))
    end--;
  let close = end;
  while (close > at && line[close - 1] === "#") close--;
  if (close < end && (close === at || line[close - 1] === " " || line[close - 1] === "\t"))
    end = close;
  while (end > at && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  return { level, text: line.slice(at, end).trim() };
}

type Fence = { mark: string; size: number; indent: number; lang: string | undefined };

function fenceOf(line: string): Fence | undefined {
  const indent = indentOf(line);
  if (indent > 3) return undefined;
  const mark = line[indent];
  if (mark !== "`" && mark !== "~") return undefined;
  let at = indent;
  while (line[at] === mark) at++;
  const size = at - indent;
  if (size < 3) return undefined;
  const info = line.slice(at).trim();
  if (mark === "`" && info.includes("`")) return undefined;
  const lang = /^[A-Za-z0-9_+#.-]{1,20}$/.test(info) ? info : undefined;
  return { mark, size, indent, lang };
}

function closesFence(line: string, fence: Fence): boolean {
  const indent = indentOf(line);
  if (indent > 3 || line[indent] !== fence.mark) return false;
  let at = indent;
  while (line[at] === fence.mark) at++;
  return at - indent >= fence.size && isBlank(line.slice(at));
}

/** A table row's cells: split on unescaped pipes, outer pipes dropped. */
function cellsOf(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  for (let at = 0; at < text.length; at++) {
    const ch = text[at] as string;
    if (ch === "\\" && text[at + 1] === "|") {
      current += "|";
      at++;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else current += ch;
  }
  // A closing pipe leaves nothing after it; text after the last pipe is a cell.
  if (current.trim() !== "" || !text.endsWith("|") || text.endsWith("\\|"))
    cells.push(current.trim());
  return cells;
}

function alignOf(cell: string): { ok: boolean; align: ChatAlign } {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":") && cell.length > 1;
  const dashes = cell.slice(left ? 1 : 0, right ? -1 : undefined);
  if (dashes.length === 0) return { ok: false, align: undefined };
  for (const ch of dashes) if (ch !== "-") return { ok: false, align: undefined };
  return {
    ok: true,
    align: left && right ? "center" : right ? "right" : left ? "left" : undefined,
  };
}

function tableAt(lines: string[], at: number): { block: ChatBlock; next: number } | undefined {
  const header = lines[at] ?? "";
  const rule = lines[at + 1];
  if (rule === undefined || !header.includes("|") || !rule.includes("-") || indentOf(header) > 3)
    return undefined;
  const heads = cellsOf(header);
  const marks = cellsOf(rule).map(alignOf);
  if (heads.length === 0 || heads.length !== marks.length || marks.some((mark) => !mark.ok))
    return undefined;
  const rows: ChatInline[][][] = [];
  let next = at + 2;
  while (next < lines.length) {
    const line = lines[next] ?? "";
    if (isBlank(line) || !line.includes("|")) break;
    const cells = cellsOf(line);
    rows.push(heads.map((_, column) => parseInlines(cells[column] ?? "")));
    next++;
  }
  return {
    block: {
      kind: "table",
      align: marks.map((mark) => mark.align),
      head: heads.map((cell) => parseInlines(cell)),
      rows,
    },
    next,
  };
}

function listAt(lines: string[], start: number, depth: number): { block: ChatBlock; next: number } {
  const first = markerOf(lines[start] ?? "") as Marker;
  const items: ChatListItem[] = [];
  const sibling = (line: string): Marker | undefined => {
    const found = markerOf(line);
    return found !== undefined &&
      found.ordered === first.ordered &&
      found.indent <= first.indent + 1 &&
      !isRule(line)
      ? found
      : undefined;
  };
  let at = start;
  while (at < lines.length) {
    const head = sibling(lines[at] ?? "");
    if (head === undefined) break;
    at++;
    let text = head.text;
    let checked: boolean | undefined;
    const task = /^\[([ xX])\](?: |$)/.exec(text);
    if (task !== null) {
      checked = task[1] !== " ";
      text = text.slice(task[0].length);
    }
    const body = [text];
    let open: Fence | undefined;
    let ended = false;
    while (at < lines.length && !ended) {
      const line = lines[at] ?? "";
      if (open !== undefined) {
        body.push(line.slice(Math.min(indentOf(line), head.offset)));
        if (closesFence(body[body.length - 1] ?? "", open)) open = undefined;
        at++;
      } else if (isBlank(line)) {
        let next = at;
        while (next < lines.length && isBlank(lines[next] ?? "")) next++;
        const after = lines[next];
        if (after !== undefined && indentOf(after) >= first.indent + 2) {
          for (; at < next; at++) body.push("");
        } else {
          if (after !== undefined && sibling(after) !== undefined) at = next;
          ended = true;
        }
      } else if (indentOf(line) >= first.indent + 2) {
        const stripped = line.slice(Math.min(indentOf(line), head.offset));
        body.push(stripped);
        open = fenceOf(stripped);
        at++;
      } else ended = true;
    }
    const blocks = parseBlocks(body, depth + 1);
    const lead = blocks[0];
    const item: ChatListItem = {
      marker: head.marker,
      inlines: lead?.kind === "para" ? lead.inlines : [],
      ...(checked === undefined ? {} : { checked }),
    };
    const rest = lead?.kind === "para" ? blocks.slice(1) : blocks;
    if (rest.length > 0) item.children = rest;
    items.push(item);
    if (ended && at < lines.length && sibling(lines[at] ?? "") === undefined) break;
  }
  return { block: { kind: "list", ordered: first.ordered, items }, next: at };
}

function parseBlocks(lines: string[], depth: number): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "para", inlines: parseInlines(paragraph.join("\n")) });
      paragraph = [];
    }
  };
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] ?? "";
    if (isBlank(line)) {
      flush();
      at++;
      continue;
    }
    const fence = fenceOf(line);
    if (fence !== undefined) {
      flush();
      const inner: string[] = [];
      at++;
      while (at < lines.length && !closesFence(lines[at] ?? "", fence)) {
        const row = lines[at] ?? "";
        inner.push(row.slice(Math.min(indentOf(row), fence.indent)));
        at++;
      }
      at++;
      blocks.push({
        kind: "codeBlock",
        text: inner.join("\n"),
        ...(fence.lang === undefined ? {} : { lang: fence.lang }),
      });
      continue;
    }
    const heading = headingOf(line);
    if (heading !== undefined) {
      flush();
      blocks.push({ kind: "heading", level: heading.level, inlines: parseInlines(heading.text) });
      at++;
      continue;
    }
    if (isRule(line)) {
      flush();
      blocks.push({ kind: "rule" });
      at++;
      continue;
    }
    if (depth < MAX_DEPTH) {
      if (indentOf(line) <= 3 && line[indentOf(line)] === ">") {
        flush();
        const inner: string[] = [];
        while (at < lines.length) {
          const row = lines[at] ?? "";
          const mark = indentOf(row);
          if (mark > 3 || row[mark] !== ">") break;
          inner.push(row.slice(row[mark + 1] === " " ? mark + 2 : mark + 1));
          at++;
        }
        blocks.push({ kind: "quote", blocks: parseBlocks(inner, depth + 1) });
        continue;
      }
      const table = tableAt(lines, at);
      if (table !== undefined) {
        flush();
        blocks.push(table.block);
        at = table.next;
        continue;
      }
      if (markerOf(line) !== undefined) {
        flush();
        const list = listAt(lines, at, depth);
        blocks.push(list.block);
        at = list.next;
        continue;
      }
    }
    paragraph.push(line);
    at++;
  }
  flush();
  return blocks;
}

export function parseChatText(text: string): ChatBlock[] {
  return parseBlocks(text.split("\n").map(expandTabs), 0);
}

/** A link's visible text, and the host beside it whenever the text does
 *  not plainly start with that host: a label, a `user:pass@` prefix or a
 *  look-alike cannot hide where the link goes. */
export function linkParts(text: string, url: string): { text: string; host?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { text: url };
  }
  const host = parsed.host.toLowerCase();
  const bare = url.replace(/^https:\/\//i, "").replace(/\/$/, "");
  const shown = text === url || text === bare || text.toLowerCase() === host ? bare : text;
  const leading = shown
    .replace(/^https:\/\//i, "")
    .split(/[/?#]/, 1)[0]
    ?.toLowerCase();
  const credentials = parsed.username !== "" || parsed.password !== "";
  if (!credentials && leading === host) return { text: shown };
  return { text: shown, host };
}

/** Whether a URL may be opened from a reply: https only. */
export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
