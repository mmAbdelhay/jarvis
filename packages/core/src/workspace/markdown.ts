import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";
import type { DocBlock, DocInline } from "./types.js";
import { isSafeHref } from "./url.js";

/**
 * Markdown source to a document model — deliberately not to HTML.
 *
 * The renderer that displays these documents is the process holding
 * `window.jarvis`, and the documents themselves are written by agents and by
 * whatever happens to be in a repository. Handing that process an HTML
 * string to assign to innerHTML would be the sharpest XSS surface in the
 * app. So the parse ends in plain data and the renderer builds nodes from
 * it (doc-view.ts), which cannot execute anything by construction.
 *
 * Two settings carry the same intent: `html: false` (raw HTML in the source
 * is literal text, never markup) and the href gate below, which demotes a
 * link with a non-web scheme to its own text.
 */
const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

export function parseMarkdown(source: string): DocBlock[] {
  const tokens = md.parse(source, {});
  return blocks(tokens, { index: 0 }, null);
}

type Cursor = { index: number };

/**
 * Reads block tokens until `closer` (or the end), advancing the shared
 * cursor. markdown-it emits a flat token stream with explicit *_open/*_close
 * pairs, so a cursor plus a stop token is enough to recurse into nested
 * structures without building an intermediate tree.
 */
function blocks(tokens: Token[], cursor: Cursor, closer: string | null): DocBlock[] {
  const out: DocBlock[] = [];

  while (cursor.index < tokens.length) {
    const token = tokens[cursor.index];
    if (token === undefined) break;
    if (closer !== null && token.type === closer) {
      cursor.index += 1;
      return out;
    }

    switch (token.type) {
      case "heading_open": {
        cursor.index += 1;
        const children = takeInline(tokens, cursor);
        cursor.index += 1; // heading_close
        out.push({ kind: "heading", level: headingLevel(token.tag), children });
        break;
      }
      case "paragraph_open": {
        cursor.index += 1;
        const children = takeInline(tokens, cursor);
        cursor.index += 1; // paragraph_close
        // A paragraph containing nothing but a stripped construct would
        // render as an empty gap; drop it instead.
        if (children.length > 0) out.push({ kind: "paragraph", children });
        break;
      }
      case "fence":
      case "code_block": {
        cursor.index += 1;
        // `info` is the whole fence info string ("ts title=x"); the language
        // is its first word.
        const language = token.info.trim().split(/\s+/)[0] ?? "";
        out.push({ kind: "code", language, text: token.content });
        break;
      }
      case "hr": {
        cursor.index += 1;
        out.push({ kind: "rule" });
        break;
      }
      case "bullet_list_open":
      case "ordered_list_open": {
        const ordered = token.type === "ordered_list_open";
        const listCloser = ordered ? "ordered_list_close" : "bullet_list_close";
        cursor.index += 1;
        const items: DocBlock[][] = [];
        const checked: (boolean | undefined)[] = [];
        while (cursor.index < tokens.length && tokens[cursor.index]?.type !== listCloser) {
          if (tokens[cursor.index]?.type !== "list_item_open") {
            cursor.index += 1;
            continue;
          }
          cursor.index += 1;
          const item = blocks(tokens, cursor, "list_item_close");
          // GFM task lists, unordered only (GitHub's own checklist rendering
          // applies the same restriction — a numbered list's own "1." is
          // never a checkbox). Detected by pattern, not a markdown-it
          // plugin: the marker is plain leading text on the item's first
          // paragraph, and stripping it there is simpler than adding a
          // second dependency for one prefix pattern.
          items.push(item);
          checked.push(ordered ? undefined : stripTaskMarker(item));
        }
        cursor.index += 1; // the list close
        out.push({
          kind: "list",
          ordered,
          items,
          // Omitted entirely — not sent as an all-undefined array — unless
          // at least one item is actually a task, so every list fixture
          // written before task lists existed keeps matching exactly.
          ...(checked.some((value) => value !== undefined) ? { checked } : {}),
        });
        break;
      }
      case "blockquote_open": {
        cursor.index += 1;
        out.push({ kind: "quote", children: blocks(tokens, cursor, "blockquote_close") });
        break;
      }
      case "table_open": {
        cursor.index += 1;
        out.push(table(tokens, cursor));
        break;
      }
      default: {
        // A block markdown-it emits that has no place in the model (and
        // anything a future version adds) is skipped rather than guessed at.
        cursor.index += 1;
        break;
      }
    }
  }

  return out;
}

/**
 * markdown-it emits a table as thead/tbody/tr/th/td open-close pairs around
 * inline tokens. Header and body are read into the same cell shape; the only
 * difference the model keeps is which array a row lands in, because that is
 * the only difference the renderer needs to draw th versus td.
 */
function table(tokens: Token[], cursor: Cursor): DocBlock {
  const head: DocInline[][] = [];
  const rows: DocInline[][][] = [];
  let inHead = false;

  while (cursor.index < tokens.length) {
    const token = tokens[cursor.index];
    if (token === undefined) break;
    if (token.type === "table_close") {
      cursor.index += 1;
      break;
    }

    switch (token.type) {
      case "thead_open":
        inHead = true;
        cursor.index += 1;
        break;
      case "thead_close":
        inHead = false;
        cursor.index += 1;
        break;
      case "tr_open": {
        cursor.index += 1;
        const cells: DocInline[][] = [];
        while (cursor.index < tokens.length && tokens[cursor.index]?.type !== "tr_close") {
          const cell = tokens[cursor.index];
          if (cell?.type === "th_open" || cell?.type === "td_open") {
            cursor.index += 1;
            cells.push(takeInline(tokens, cursor));
            cursor.index += 1; // th_close / td_close
            continue;
          }
          cursor.index += 1;
        }
        cursor.index += 1; // tr_close
        if (inHead) head.push(...cells);
        else rows.push(cells);
        break;
      }
      default:
        cursor.index += 1;
        break;
    }
  }

  return { kind: "table", head, rows };
}

// "- [ ] " / "- [x] " / "- [X] " — the GFM task-list marker, as it survives
// into the item's first paragraph's first text node once markdown-it has
// already consumed the list bullet itself.
const TASK_MARKER = /^\[([ xX])\]\s+/;

/**
 * Strips a leading task marker from `item`'s first paragraph in place and
 * returns its checked state, or undefined if the item is not a task at all.
 * Mutates `item` (the freshly-built, not-yet-shared block array) so the
 * marker text never appears twice — once as raw "[x]" and once as a real
 * checkbox glyph the renderer draws from the returned boolean.
 */
function stripTaskMarker(item: DocBlock[]): boolean | undefined {
  const first = item[0];
  if (first === undefined || first.kind !== "paragraph") return undefined;
  const firstChild = first.children[0];
  if (firstChild === undefined || firstChild.kind !== "text") return undefined;

  const match = TASK_MARKER.exec(firstChild.text);
  if (match === null) return undefined;

  const mark = match[1];
  const rest = firstChild.text.slice(match[0].length);
  if (rest === "") first.children.shift();
  else first.children[0] = { kind: "text", text: rest };

  return mark !== undefined && mark.toLowerCase() === "x";
}

function headingLevel(tag: string): 1 | 2 | 3 | 4 | 5 | 6 {
  const level = Number(tag.slice(1));
  return level >= 1 && level <= 6 ? (level as 1 | 2 | 3 | 4 | 5 | 6) : 1;
}

/** Consumes one `inline` token at the cursor and returns its model. */
function takeInline(tokens: Token[], cursor: Cursor): DocInline[] {
  const token = tokens[cursor.index];
  if (token === undefined || token.type !== "inline") return [];
  cursor.index += 1;
  return inlines(token.children ?? [], { index: 0 }, null);
}

function inlines(tokens: Token[], cursor: Cursor, closer: string | null): DocInline[] {
  const out: DocInline[] = [];

  while (cursor.index < tokens.length) {
    const token = tokens[cursor.index];
    if (token === undefined) break;
    if (closer !== null && token.type === closer) {
      cursor.index += 1;
      return out;
    }

    switch (token.type) {
      case "text": {
        cursor.index += 1;
        if (token.content !== "") out.push({ kind: "text", text: token.content });
        break;
      }
      case "code_inline": {
        cursor.index += 1;
        out.push({ kind: "code", text: token.content });
        break;
      }
      case "softbreak": {
        cursor.index += 1;
        out.push({ kind: "text", text: " " });
        break;
      }
      case "hardbreak": {
        cursor.index += 1;
        out.push({ kind: "text", text: "\n" });
        break;
      }
      case "em_open": {
        cursor.index += 1;
        out.push({ kind: "emphasis", children: inlines(tokens, cursor, "em_close") });
        break;
      }
      case "strong_open": {
        cursor.index += 1;
        out.push({ kind: "strong", children: inlines(tokens, cursor, "strong_close") });
        break;
      }
      case "link_open": {
        cursor.index += 1;
        // markdown-it 15 types an attribute value as string | number, so a
        // non-string href is treated as no href at all rather than coerced
        // into one — an attribute that is not a string is not a link target.
        const rawHref = token.attrGet("href");
        const href = typeof rawHref === "string" ? rawHref : "";
        const children = inlines(tokens, cursor, "link_close");
        // A link whose scheme is not http(s) keeps its words and loses its
        // href: the document still reads correctly, and nothing clickable
        // in the privileged renderer points at javascript: or file:.
        if (isSafeHref(href)) out.push({ kind: "link", href, children });
        else out.push(...children);
        break;
      }
      default: {
        // image, html_inline (already inert under html:false), and anything
        // a future markdown-it adds: keep the text, drop the construct.
        cursor.index += 1;
        if (token.content !== "") out.push({ kind: "text", text: token.content });
        break;
      }
    }
  }

  return out;
}
