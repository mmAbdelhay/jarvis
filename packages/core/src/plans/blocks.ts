import MarkdownIt from "markdown-it";
import type { RendererRule, StateCore } from "markdown-it";

/**
 * A plan file is markdown, and the panel edits it one structural chunk at a
 * time (one heading, one paragraph, one list, …) rather than as raw text.
 * `parsePlan` is the read side of that: it turns markdown into `PlanBlock`s
 * addressed by 0-based, end-exclusive line ranges taken straight from
 * markdown-it's own `token.map`, so a block's `start`/`end` always line up
 * with what the parser considered one top-level construct.
 */
export type BlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "code"
  | "table"
  | "quote"
  | "hr"
  | "other";

export type PlanBlock = {
  id: string;
  kind: BlockKind;
  /** Heading level 1–6. Present only when `kind` is `"heading"`. */
  level?: number;
  /** 0-based line range, end exclusive, from markdown-it's `token.map`. */
  start: number;
  end: number;
  /** Exact lines `start..end` joined by `"\n"` — a trailing `\r` (CRLF files) is preserved. */
  source: string;
  html: string;
};

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// FNV-1a over UTF-8 bytes (not UTF-16 code units) so the id is stable for
// the bilingual (Arabic/English) plan text this panel actually renders.
function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of Buffer.from(input, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * FNV-1a 32-bit hash of `kind + "\u0000" + source`, as zero-padded hex,
 * suffixed with `-<occurrence>` (0 for the first identical block in a
 * document, 1 for the second, …). Two blocks with the same kind and exact
 * source text therefore get distinct, stable ids as long as their relative
 * order doesn't change — editing one leaves every other block's id alone.
 */
export function blockId(kind: BlockKind, source: string, occurrence: number): string {
  const hash = fnv1a32(`${kind}\u0000${source}`);
  return `${hash.toString(16).padStart(8, "0")}-${occurrence}`;
}

// `- [ ] text` / `- [x] text` list items render a disabled checkbox instead
// of the literal marker. This has to run as a core rule (after inline
// parsing, before rendering) rather than a renderer rule: the marker is part
// of the item's own text token and needs to be stripped from it, which a
// renderer rule — which only reads tokens, never rewrites them — cannot do.
const TASK_MARKER = /^\[([ xX])\](\s|$)/;

function renderTaskCheckboxes(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const itemOpen = tokens[i];
    if (itemOpen === undefined || itemOpen.type !== "list_item_open") continue;

    // Every list item's content markdown-it wraps in paragraph_open/inline/
    // paragraph_close — even in a tight list, where the paragraph tokens are
    // simply marked `hidden`. That makes this shape reliable regardless of
    // list tightness.
    const paragraphOpen = tokens[i + 1];
    if (paragraphOpen === undefined || paragraphOpen.type !== "paragraph_open") continue;
    const inline = tokens[i + 2];
    if (inline === undefined || inline.type !== "inline" || inline.children === null) continue;

    const first = inline.children[0];
    if (first === undefined || first.type !== "text") continue;
    const match = TASK_MARKER.exec(first.content);
    if (match === null) continue;

    const marker = match[1];
    if (marker === undefined) continue;
    const checked = marker.toLowerCase() === "x";
    first.content = first.content.slice(match[0].length);

    // A fixed, hard-coded checkbox string — never derived from the parsed
    // markdown — so inserting it as html_inline is safe even under
    // `html: false`.
    const checkbox = new state.Token("html_inline", "", 0);
    checkbox.content = checked
      ? '<input type="checkbox" checked disabled> '
      : '<input type="checkbox" disabled> ';
    inline.children.unshift(checkbox);
  }
}

function createRenderer() {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

  // Every link — written `[text](url)`, or bare via linkify — opens in a new
  // tab without handing it `window.opener`.
  const defaultLinkOpen: RendererRule =
    md.renderer.rules["link_open"] ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules["link_open"] = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token !== undefined) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener noreferrer");
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  md.core.ruler.push("plan_task_checkbox", renderTaskCheckboxes);
  return md;
}

const md = createRenderer();

function kindForToken(type: string): BlockKind {
  switch (type) {
    case "heading_open":
      return "heading";
    case "paragraph_open":
      return "paragraph";
    case "bullet_list_open":
    case "ordered_list_open":
      return "list";
    case "fence":
    case "code_block":
      return "code";
    case "table_open":
      return "table";
    case "blockquote_open":
      return "quote";
    case "hr":
      return "hr";
    default:
      return "other";
  }
}

function isFrontMatterDelimiter(line: string): boolean {
  return line === "---" || line === "---\r";
}

/**
 * Parses `markdown` into top-level blocks: front matter (if any, as a single
 * `"other"` block), then one block per top-level markdown-it token
 * (nesting level 0, with a `map` — i.e. every opening or self-closing
 * top-level token; closing tokens carry no `map` and are folded into the
 * block they close). A block's `html` is rendered from that same slice of
 * the token stream, so nested content (list items, table cells, …) renders
 * exactly as markdown-it would render the whole document.
 */
export function parsePlan(markdown: string): PlanBlock[] {
  const lines = markdown.split("\n");
  const blocks: PlanBlock[] = [];
  const occurrences = new Map<string, number>();

  const nextOccurrence = (kind: BlockKind, source: string): number => {
    const key = `${kind}\u0000${source}`;
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return occurrence;
  };

  let bodyStart = 0;
  const firstLine = lines[0];
  if (firstLine !== undefined && isFrontMatterDelimiter(firstLine)) {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || !isFrontMatterDelimiter(line)) continue;
      const end = i + 1;
      const source = lines.slice(0, end).join("\n");
      blocks.push({
        id: blockId("other", source, nextOccurrence("other", source)),
        kind: "other",
        start: 0,
        end,
        source,
        html: `<pre>${md.utils.escapeHtml(source)}</pre>`,
      });
      bodyStart = end;
      break;
    }
  }

  const bodyText = lines.slice(bodyStart).join("\n");
  // markdown-it's own normalize step treats a lone `\r` (not part of `\r\n`)
  // as a line break too, the same as our own `lines` array's `\n`-only split
  // does not — a stray `\r` inside a line would otherwise shift every
  // subsequent token's `map` by one line relative to our own line indices.
  // Blank it out to a space for parsing only; `lines` (and therefore every
  // block's `source`, and `replaceBlock`'s splicing) keeps the original
  // bytes untouched.
  const parseText = bodyText.replace(/\r(?!\n)/g, " ");
  const tokens = md.parse(parseText, {});

  const topLevel: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token !== undefined && token.level === 0 && token.map !== null) topLevel.push(i);
  }

  for (let t = 0; t < topLevel.length; t++) {
    const tokenIndex = topLevel[t];
    if (tokenIndex === undefined) continue;
    const token = tokens[tokenIndex];
    if (token === undefined || token.map === null) continue;

    const nextTokenIndex = topLevel[t + 1];
    const endTokenIndex = nextTokenIndex !== undefined ? nextTokenIndex - 1 : tokens.length - 1;

    const kind = kindForToken(token.type);
    const level = kind === "heading" ? Number(token.tag.slice(1)) : undefined;
    const start = token.map[0] + bodyStart;
    const end = token.map[1] + bodyStart;
    const source = lines.slice(start, end).join("\n");
    const html = md.renderer.render(tokens.slice(tokenIndex, endTokenIndex + 1), md.options, {});

    blocks.push({
      id: blockId(kind, source, nextOccurrence(kind, source)),
      kind,
      ...(level !== undefined ? { level } : {}),
      start,
      end,
      source,
      html,
    });
  }

  return blocks;
}

/** True when `markdown`'s own line ending (sampled from its first line break) is `\r\n`. */
function usesCrlf(markdown: string): boolean {
  const newlineIndex = markdown.indexOf("\n");
  return newlineIndex > 0 && markdown[newlineIndex - 1] === "\r";
}

/**
 * Replaces lines `block.start..block.end` (exclusive) with `newSource`,
 * split on `"\n"`. Every other line is untouched — including a CRLF line's
 * trailing `\r`, and whether the file ends with a trailing newline, since
 * both survive only in lines this function never touches.
 *
 * `newSource` itself is always LF (it comes from a textarea). When `markdown`
 * is a CRLF file, each of its lines is re-terminated with `\r` before
 * splicing so the result doesn't end up with mixed line endings — a bare
 * `\n` from the replacement sitting next to `\r\n` from the rest of the
 * file.
 */
export function replaceBlock(
  markdown: string,
  block: Pick<PlanBlock, "start" | "end">,
  newSource: string,
): string {
  const lines = markdown.split("\n");
  const crlf = usesCrlf(markdown);
  const hadTrailingNewline = markdown.endsWith("\n");
  const normalizedNewLines = newSource.replace(/\r\n?/g, "\n").split("\n");

  // The replacement's last line becomes the file's own last line — with no
  // line break after it — exactly when this block reaches the true end of a
  // file that itself has no trailing newline. Every other new line is
  // followed by a `\n` from `join`, so it needs the file's own `\r` first.
  const replacesFinalLineWithoutTrailingNewline = !hadTrailingNewline && block.end === lines.length;
  const newLines = crlf
    ? normalizedNewLines.map((line, i) => {
        const isLast = i === normalizedNewLines.length - 1;
        return isLast && replacesFinalLineWithoutTrailingNewline ? line : `${line}\r`;
      })
    : normalizedNewLines;

  lines.splice(block.start, block.end - block.start, ...newLines);
  return lines.join("\n");
}
