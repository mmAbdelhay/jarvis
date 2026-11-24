// Code and light markdown: the in-house tokenizer (comment, string, number,
// keyword — no dependency), a code block with its Copy button, and the
// replies' markdown blocks. Text reaches the DOM through textContent only;
// a link opens only if it is https.
import {
  type ChatBlock,
  type ChatInline,
  isHttpsUrl,
  linkParts,
  parseChatText,
} from "../agent-chat-text.js";
import { el, type Translate } from "./dom.js";

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
  const code = el("code");
  for (const token of tokenize(text, familyOf(hint))) {
    if (token.kind === "plain") code.append(document.createTextNode(token.text));
    else code.append(el("span", `ac-tok ac-tok--${token.kind}`, token.text));
  }
  pre.append(code);
  return pre;
}

/** A code block with a Copy button above it. */
export function codeBlock(ctx: CodeContext, text: string, hint?: string): HTMLElement {
  const box = el("div", "ac-codebox");
  const bar = el("div", "ac-codebox__bar");
  bar.append(copyButton(ctx, () => text));
  box.append(bar, renderCode(text, hint));
  return box;
}

function renderInlines(inlines: readonly ChatInline[], ctx: CodeContext): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const inline of inlines) {
    if (inline.kind === "text") fragment.append(document.createTextNode(inline.text));
    else if (inline.kind === "bold") fragment.append(el("strong", undefined, inline.text));
    else if (inline.kind === "code") fragment.append(el("code", "ac-inline", inline.text));
    else if (!isHttpsUrl(inline.url)) fragment.append(document.createTextNode(inline.text));
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

function renderBlock(block: ChatBlock, ctx: CodeContext): HTMLElement {
  if (block.kind === "codeBlock") return codeBlock(ctx, block.text);
  if (block.kind === "list") {
    const list = el("div", "agent-chat__list");
    list.setAttribute("role", "list");
    for (const item of block.items) {
      const row = el("div", "agent-chat__item");
      row.setAttribute("role", "listitem");
      row.dir = "auto";
      row.append(el("span", "agent-chat__marker", item.marker), " ");
      row.append(renderInlines(item.inlines, ctx));
      list.append(row);
    }
    return list;
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
