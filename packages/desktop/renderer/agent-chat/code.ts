// Code and markdown: the in-house tokenizer (comment, string, number,
// keyword — no dependency), a code block with its Copy button, and the
// replies' markdown blocks. Text reaches the DOM through textContent and text
// nodes only (never innerHTML); a link opens only if it is https; a file path
// asks the host to open it, and the host (main) decides whether it may.
import {
  type ChatBlock,
  type ChatInline,
  isHttpsUrl,
  linkParts,
  type ChatListItem,
  pathLabel,
  parseChatText,
} from "../agent-chat-text.js";
import { el, fmt, type Translate } from "./dom.js";

export type TokenKind = "plain" | "comment" | "string" | "number" | "keyword";
export type Token = { kind: TokenKind; text: string };
export type Family = "c" | "py" | "sh" | "json" | "plain";

/** Code longer than this is shown plain: tokenizing it would cost more than it shows. */
const HIGHLIGHT_LIMIT = 20_000;

const C_KEYWORDS =
  "abstract as async await break case catch class const continue default delete do else enum export extends false final finally fn for from func function go if impl implements import in instanceof interface let loop match mod mut namespace new null nil package private protected pub public return self static struct super switch this throw true try type typeof undefined use var void while with yield";
const PY_KEYWORDS =
  "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield";
const SH_KEYWORDS =
  "case do done elif else esac exit export fi for function if in local return select then until while";

const STRING = String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'`;
const NUMBER = String.raw`\b0x[0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b`;

function expression(comment: string, strings: string, keywords: string): RegExp {
  const words = keywords.split(" ").join("|");
  return new RegExp(`(${comment})|(${strings})|(${NUMBER})|\\b(${words})\\b`, "g");
}

const PATTERNS: Record<Exclude<Family, "plain">, RegExp> = {
  c: expression(
    String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/`,
    `${STRING}|\`(?:\\\\.|[^\`\\\\])*\``,
    C_KEYWORDS,
  ),
  py: expression("#[^\\n]*", STRING, PY_KEYWORDS),
  sh: expression("#[^\\n]*", STRING, SH_KEYWORDS),
  json: expression("(?!)", STRING, "true false null"),
};

const FAMILY_BY_HINT: Record<string, Family> = {
  js: "c",
  jsx: "c",
  ts: "c",
  tsx: "c",
  mjs: "c",
  cjs: "c",
  java: "c",
  go: "c",
  rs: "c",
  c: "c",
  h: "c",
  cpp: "c",
  cs: "c",
  swift: "c",
  kt: "c",
  css: "c",
  php: "c",
  py: "py",
  python: "py",
  rb: "py",
  yml: "py",
  yaml: "py",
  toml: "py",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  shell: "sh",
  fish: "sh",
  json: "json",
};

/** The language family for a file extension or fence name; plain when unknown. */
export function familyOf(hint: string | undefined): Family {
  if (hint === undefined) return "plain";
  const key = hint.toLowerCase().replace(/^.*\./, "");
  return FAMILY_BY_HINT[key] ?? "plain";
}

/** Splits code into runs; concatenating the runs gives the input back. */
export function tokenize(text: string, family: Family): Token[] {
  if (family === "plain" || text.length > HIGHLIGHT_LIMIT) return [{ kind: "plain", text }];
  const tokens: Token[] = [];
  let cursor = 0;
  const kinds: TokenKind[] = ["comment", "string", "number", "keyword"];
  for (const match of text.matchAll(PATTERNS[family])) {
    const at = match.index ?? 0;
    if (at > cursor) tokens.push({ kind: "plain", text: text.slice(cursor, at) });
    const which = [1, 2, 3, 4].find((group) => match[group] !== undefined) ?? 0;
    tokens.push({ kind: kinds[which - 1] ?? "plain", text: match[0] });
    cursor = at + match[0].length;
  }
  if (cursor < text.length) tokens.push({ kind: "plain", text: text.slice(cursor) });
  return tokens;
}

export type CodeContext = {
  t: Translate;
  openLink(url: string): void;
  copy(text: string): void;
  /** Opens a file named in a reply. Absent: a path is drawn as plain text. */
  openFile?(path: string): void;
};

/** A Copy button that says Copied for a moment. */
export function copyButton(
  ctx: CodeContext,
  getText: () => string,
  className = "ac-copy",
): HTMLButtonElement {
  const button = el("button", className, ctx.t("agentChatCopy"));
  button.type = "button";
  button.addEventListener("click", () => {
    ctx.copy(getText());
    button.textContent = ctx.t("agentChatCopied");
    setTimeout(() => {
      button.textContent = ctx.t("agentChatCopy");
    }, 1500);
  });
  return button;
}

/** `<pre><code>` with token spans. */
export function renderCode(text: string, hint?: string): HTMLPreElement {
  const pre = el("pre", "ac-code");
  pre.dir = "ltr";
  const code = el("code");
  for (const token of tokenize(text, familyOf(hint))) {
    if (token.kind === "plain") code.append(document.createTextNode(token.text));
    else code.append(el("span", `ac-tok ac-tok--${token.kind}`, token.text));
  }
  pre.append(code);
  return pre;
}

/** A code block. With a language the header names it beside Copy; with none
 *  there is no header and Copy sits over the code. Code reads left to right in
 *  any language of the interface. */
export function codeBlock(ctx: CodeContext, text: string, hint?: string): HTMLElement {
  const box = el("div", "ac-codebox");
  box.dir = "ltr";
  const copy = copyButton(ctx, () => text);
  const code = renderCode(text, hint);
  code.dir = "ltr";
  if (hint !== undefined && hint !== "") {
    const bar = el("div", "ac-codebox__bar");
    bar.append(el("span", "ac-codebox__lang", hint), copy);
    box.append(bar, code);
  } else {
    copy.classList.add("ac-copy--overlay");
    box.append(copy, code);
  }
  return box;
}

function renderInlines(inlines: readonly ChatInline[], ctx: CodeContext): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const inline of inlines) {
    if (inline.kind === "text") fragment.append(document.createTextNode(inline.text));
    else if (inline.kind === "bold" || inline.kind === "italic" || inline.kind === "strike") {
      const tag = inline.kind === "bold" ? "strong" : inline.kind === "italic" ? "em" : "del";
      fragment.append(wrap(el(tag), renderInlines(inline.children, ctx)));
    } else if (inline.kind === "code") fragment.append(el("code", "ac-inline", inline.text));
    else if (inline.kind === "path") {
      const open = ctx.openFile;
      if (open === undefined) {
        fragment.append(
          inline.code ? el("code", "ac-inline", inline.text) : document.createTextNode(inline.text),
        );
      } else {
        // A button whose short label names the file; the whole path is its name.
        const label = pathLabel(inline.path) + (inline.line === undefined ? "" : `:${inline.line}`);
        const button = el("button", inline.code ? "ac-path ac-inline" : "ac-path", label);
        button.type = "button";
        button.dir = "ltr";
        button.title = inline.text;
        button.setAttribute("aria-label", fmt(ctx.t("agentChatOpenPath"), { path: inline.text }));
        button.addEventListener("click", () => open(inline.path));
        fragment.append(button);
      }
    } else if (!isHttpsUrl(inline.url)) fragment.append(document.createTextNode(inline.text));
    else {
      const parts = linkParts(inline.text, inline.url);
      const link = el("a", "agent-chat__link", parts.text);
      link.href = inline.url;
      link.rel = "noopener noreferrer";
      link.addEventListener("click", (event) => {
        event.preventDefault();
        ctx.openLink(inline.url);
      });
      fragment.append(link);
      if (parts.host !== undefined)
        fragment.append(el("span", "agent-chat__host", ` (${parts.host})`));
    }
  }
  return fragment;
}

function wrap<T extends HTMLElement>(node: T, content: DocumentFragment): T {
  node.append(content);
  return node;
}

function renderItem(item: ChatListItem, ctx: CodeContext): HTMLElement {
  const row = el("div", "agent-chat__item");
  row.setAttribute("role", "listitem");
  row.dir = "auto";
  // The marker reads left to right whatever the item's language: "1." must not become ".1".
  const marker = el("span", "agent-chat__marker", item.marker);
  marker.dir = "ltr";
  if (item.checked !== undefined) {
    marker.textContent = item.checked ? "\u2611" : "\u2610";
    marker.setAttribute("role", "img");
    marker.setAttribute(
      "aria-label",
      ctx.t(item.checked ? "agentChatTaskDone" : "agentChatTaskOpen"),
    );
    row.dataset["checked"] = String(item.checked);
  }
  const body = el("div", "agent-chat__itembody");
  body.append(renderInlines(item.inlines, ctx));
  for (const child of item.children ?? []) body.append(renderBlock(child, ctx));
  row.append(marker, body);
  return row;
}

function renderBlock(block: ChatBlock, ctx: CodeContext): HTMLElement {
  if (block.kind === "codeBlock") return codeBlock(ctx, block.text, block.lang);
  if (block.kind === "list") {
    const list = el("div", "agent-chat__list");
    list.setAttribute("role", "list");
    // The marker column is as wide as the widest marker of this list ("10." fits).
    const widest = Math.max(
      2,
      ...block.items.map((item) => (item.checked === undefined ? item.marker.length : 1)),
    );
    list.style.setProperty("--ac-mk", `${widest + 0.5}ch`);
    for (const item of block.items) list.append(renderItem(item, ctx));
    return list;
  }
  if (block.kind === "heading") {
    const level = Math.min(6, Math.max(1, block.level));
    const heading = el("div", `ac-h ac-h--${level}`);
    heading.setAttribute("role", "heading");
    heading.setAttribute("aria-level", String(level));
    heading.dir = "auto";
    heading.append(renderInlines(block.inlines, ctx));
    return heading;
  }
  if (block.kind === "quote") {
    const quote = el("blockquote", "ac-quote");
    for (const inner of block.blocks) quote.append(renderBlock(inner, ctx));
    return quote;
  }
  if (block.kind === "rule") return el("hr", "ac-rule");
  if (block.kind === "table") {
    const box = el("div", "ac-tablewrap");
    // Wide tables scroll inside this box; it takes the keyboard so they can be scrolled.
    box.tabIndex = 0;
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", ctx.t("agentChatTableLabel"));
    const table = el("table", "ac-table");
    const cell = (tag: "th" | "td", inlines: ChatInline[], column: number): HTMLElement => {
      const node = el(tag);
      node.dir = "auto";
      const align = block.align[column];
      if (align !== undefined) node.dataset["align"] = align;
      if (tag === "th") node.setAttribute("scope", "col");
      node.append(renderInlines(inlines, ctx));
      return node;
    };
    const head = el("tr");
    for (const [column, inlines] of block.head.entries()) head.append(cell("th", inlines, column));
    const thead = el("thead");
    thead.append(head);
    table.append(thead);
    const body = el("tbody");
    for (const row of block.rows) {
      const line = el("tr");
      for (const [column, inlines] of row.entries()) line.append(cell("td", inlines, column));
      body.append(line);
    }
    table.append(body);
    box.append(table);
    return box;
  }
  const paragraph = el("p", "agent-chat__para");
  paragraph.dir = "auto";
  paragraph.append(renderInlines(block.inlines, ctx));
  return paragraph;
}

/** The markdown of a reply or a plan, as blocks. */
export function renderMarkdown(text: string, ctx: CodeContext): HTMLElement[] {
  return parseChatText(text).map((block) => renderBlock(block, ctx));
}
