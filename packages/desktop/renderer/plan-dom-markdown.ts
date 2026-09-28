// Converts an edited plan block's DOM back to markdown so an in-place edit
// can be diffed against the source it started from (see isNoopEdit) and
// written back through plansWriteBlock. Pure DOM -> string: no @jarvis/*
// value import, so it can run in the renderer bundle unchanged.
//
// `PlanBlock` (kind/level/source) lives in @jarvis/core; only its shape is
// declared here (`BlockKind`, and the `original` parameter's inline type) to
// keep this module a type-only consumer, per the "renderer imports only
// types from workspace packages" rule.
//
// The DOM this reads is real markdown-it output (`{ html: false, linkify:
// true, typographer: false }` — Task 1's own parse options), not a
// hand-modelled approximation, so every rule below is calibrated against
// what that renderer actually emits: a trailing `\n` inside every `<code>`,
// `<p>` wrapping only on loose list items, and — for task list items —
// Task 1's own post-processing, which replaces a `[ ] `/`[x] ` item prefix
// with a manufactured `<input type="checkbox" disabled>`/`<input
// type="checkbox" checked disabled>` as the `<li>`'s first child, rather
// than leaving the brackets as literal text.

export type BlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "code"
  | "table"
  | "quote"
  | "hr"
  | "other";

const ESCAPABLE_CHARS = ["*", "_", "`", "["] as const;

/**
 * Re-applies markdown escaping to a text node's plain content, but only for
 * what the original source actually escaped. A character is only escaped in
 * the output if the source contains that exact character preceded by a
 * backslash (`\*` in the source means a literal `*` must round-trip back to
 * `\*`); a lone, never-escaped occurrence of the character is left alone,
 * since re-escaping it could diverge from what the user actually typed.
 * `&` follows the same idea for the one HTML entity markdown-it introduces
 * on its own: it stays a literal `&` unless the source spelled it `&amp;`.
 */
function escapeIfNeeded(text: string, source: string): string {
  let result = text;
  for (const ch of ESCAPABLE_CHARS) {
    if (!source.includes(`\\${ch}`)) continue;
    result = result.split(ch).join(`\\${ch}`);
  }
  if (source.includes("&amp;")) {
    result = result.split("&").join("&amp;");
  }
  return result;
}

function codeSpanFence(content: string): string {
  const runs = content.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(longest + 1);
}

function imageMarkdown(src: string, alt: string, title: string | null): string {
  return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`;
}

/** The class of the inert element that stands in for a remote image inside
 *  an editable block (see replaceImagesWithPlaceholders). */
export const IMAGE_PLACEHOLDER_CLASS = "plan-block-edit__image";

/**
 * Final fix wave I1: an editable block must keep each image's src so it
 * can be written back, but a live `<img>` with a remote src would fetch it.
 * Every non-`data:` image under `root` is replaced by a non-editable
 * `<span>` that shows the alt text and carries src/alt/title only as data
 * attributes — never a URL attribute the browser acts on — which
 * blockToMarkdown turns back into `![alt](src "title")`. `data:` images
 * stay real `<img>`s, as in read mode.
 */
export function replaceImagesWithPlaceholders(root: ParentNode): void {
  for (const image of Array.from(root.querySelectorAll("img"))) {
    const src = image.getAttribute("src") ?? "";
    if (src.startsWith("data:image/")) continue;
    const placeholder = document.createElement("span");
    placeholder.className = IMAGE_PLACEHOLDER_CLASS;
    placeholder.setAttribute("contenteditable", "false");
    placeholder.dataset.src = src;
    const alt = image.getAttribute("alt") ?? "";
    placeholder.dataset.alt = alt;
    const title = image.getAttribute("title");
    if (title !== null) placeholder.dataset.title = title;
    placeholder.textContent = alt;
    image.replaceWith(placeholder);
  }
}

const INLINE_TAGS = ["strong", "b", "em", "i", "code", "a", "img", "br", "s", "del"];
const RICH_TAGS: Partial<Record<BlockKind, readonly string[]>> = {
  heading: ["h1", "h2", "h3", "h4", "h5", "h6", ...INLINE_TAGS],
  paragraph: ["p", ...INLINE_TAGS],
  list: ["ul", "ol", "li", "p", "input", ...INLINE_TAGS],
  quote: ["blockquote", "p", ...INLINE_TAGS],
};

/**
 * Final fix wave I1 (controller ruling): whether every element under `root`
 * is one `kind`'s rich converter reads back. Anything else (a fenced code
 * block or a heading inside a list, a list or a nested quote inside a
 * quote, …) would be silently dropped on save, so such a block edits as
 * raw markdown text instead. A blockquote nested in a blockquote is
 * refused too, since quoteToMarkdown only reads one level.
 */
export function hasOnlyRichMarkup(root: ParentNode, kind: BlockKind): boolean {
  const allowed = RICH_TAGS[kind];
  if (!allowed) return false;
  for (const element of Array.from(root.querySelectorAll("*"))) {
    const tag = element.tagName.toLowerCase();
    if (!allowed.includes(tag)) return false;
    if (tag === "blockquote" && element.parentElement?.closest("blockquote")) return false;
  }
  return true;
}

function childNodesToMarkdown(nodes: ArrayLike<ChildNode>, source: string): string {
  let out = "";
  let previousWasBr = false;
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i] as ChildNode;
    if (node.nodeType === Node.TEXT_NODE) {
      let text = node.textContent ?? "";
      // markdown-it always emits a literal "\n" right after a <br> in its
      // HTML output (pretty-printing, not user content) — e.g.
      // "<br>\nLine two". Left alone, that would round-trip a hard break
      // as two newlines instead of the one the source actually had.
      if (previousWasBr && text.startsWith("\n")) {
        text = text.slice(1);
      }
      out += escapeIfNeeded(text, source);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      out += elementToMarkdown(node as HTMLElement, source);
    }
    previousWasBr =
      node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName.toLowerCase() === "br";
  }
  return out;
}

function elementToMarkdown(el: HTMLElement, source: string): string {
  switch (el.tagName.toLowerCase()) {
    case "strong":
    case "b":
      return `**${childNodesToMarkdown(el.childNodes, source)}**`;
    case "em":
    case "i":
      return `*${childNodesToMarkdown(el.childNodes, source)}*`;
    case "code": {
      const content = el.textContent ?? "";
      const fence = codeSpanFence(content);
      const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
      return `${fence}${pad}${content}${pad}${fence}`;
    }
    case "a": {
      const href = el.getAttribute("href") ?? "";
      const bareText = el.textContent ?? "";
      const hrefBare = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
      // linkify (autolinked URLs/emails) never appears as `[text](url)` in
      // the source; writing it back that way would introduce syntax the
      // user never typed. Only take this path when the bare text is
      // actually present verbatim in the source, so a manual link whose
      // text happens to equal its href still round-trips as a real link.
      if (bareText.length > 0 && bareText === hrefBare && source.includes(bareText)) {
        return bareText;
      }
      return `[${childNodesToMarkdown(el.childNodes, source)}](${href})`;
    }
    case "s":
    case "del":
      return `~~${childNodesToMarkdown(el.childNodes, source)}~~`;
    case "img":
      return imageMarkdown(
        el.getAttribute("src") ?? "",
        el.getAttribute("alt") ?? "",
        el.getAttribute("title"),
      );
    case "span":
      // replaceImagesWithPlaceholders' own inert stand-in for a remote image.
      if (el.classList.contains(IMAGE_PLACEHOLDER_CLASS)) {
        return imageMarkdown(el.dataset.src ?? "", el.dataset.alt ?? "", el.dataset.title ?? null);
      }
      return escapeIfNeeded(el.textContent ?? "", source);
    case "br":
      return "  \n";
    default:
      return escapeIfNeeded(el.textContent ?? "", source);
  }
}

function inlineToMarkdown(el: Element, source: string): string {
  return childNodesToMarkdown(el.childNodes, source);
}

/**
 * Fix round 1, C1: a live contenteditable can end up holding more than one
 * top-level p/div/h1-6 child — an Enter or paste the edit-mode handlers
 * didn't fully intercept, an IME commit, browser-specific quirks — even
 * though plan-panel.ts's own keydown/paste handlers try to keep a
 * paragraph/heading down to exactly one. `el.querySelector(...)` only ever
 * finds the *first* such node in document order, silently discarding
 * everything after it; this instead collects every top-level text-block
 * child and, when there's more than one, joins them with a hard break
 * rather than keeping only the first.
 */
function topLevelTextBlocks(el: HTMLElement): HTMLElement[] {
  return Array.from(el.children).filter((child): child is HTMLElement => {
    const tag = child.tagName.toLowerCase();
    return tag === "p" || tag === "div" || /^h[1-6]$/.test(tag);
  });
}

function joinedOrSingleInline(
  el: HTMLElement,
  fallback: Element,
  source: string,
  joiner: string,
): string {
  const blocks = topLevelTextBlocks(el);
  if (blocks.length > 1) {
    return blocks.map((block) => inlineToMarkdown(block, source)).join(joiner);
  }
  return inlineToMarkdown(fallback, source);
}

// Fix round 2, item 6 (controller ruling): a heading is single-line — it
// can never legitimately contain a hard break — so its own defensive join
// uses a plain space; paragraph's keeps the hard break, since a paragraph
// genuinely can.
function headingToMarkdown(el: HTMLElement, level: number, source: string): string {
  const heading = el.querySelector("h1,h2,h3,h4,h5,h6") ?? el;
  return `${"#".repeat(Math.max(level, 1))} ${joinedOrSingleInline(el, heading, source, " ")}`;
}

function paragraphToMarkdown(el: HTMLElement, source: string): string {
  const paragraph = el.querySelector("p") ?? el;
  return joinedOrSingleInline(el, paragraph, source, "  \n");
}

function quoteLines(content: string): string {
  return content
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * Fix round 2, item 7: the same category of bug C1 fixed for paragraph/
 * heading — `:scope > p` only ever collected real `<p>` children, silently
 * dropping a stray top-level `<div>` or bare text node beside them (an
 * unintercepted Enter/paste edge case, same as C1's). Collects every
 * top-level node that stands for its own paragraph — `<p>`, `<div>`, or a
 * non-blank text node — in document order, so nothing beside the real
 * paragraphs gets lost.
 */
function quoteParagraphNodes(quote: Element): ChildNode[] {
  return Array.from(quote.childNodes).filter((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = (node as Element).tagName.toLowerCase();
      return tag === "p" || tag === "div";
    }
    return node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "";
  });
}

function quoteParagraphToMarkdown(node: ChildNode, source: string): string {
  return node.nodeType === Node.TEXT_NODE
    ? escapeIfNeeded(node.textContent ?? "", source)
    : inlineToMarkdown(node as Element, source);
}

function quoteToMarkdown(el: HTMLElement, source: string): string {
  const quote = el.querySelector("blockquote") ?? el;
  const paragraphs = quoteParagraphNodes(quote);
  if (paragraphs.length === 0) {
    return quoteLines(inlineToMarkdown(quote, source));
  }
  // Each source paragraph becomes its own `> `-prefixed block; markdown-it
  // separates them with a bare `>` line, which quoteLines only produces
  // *inside* a block (for a `<br>` line break) — so the separator between
  // paragraphs is joined in explicitly here, once, rather than per line.
  return paragraphs.map((node) => quoteLines(quoteParagraphToMarkdown(node, source))).join("\n>\n");
}

function detectBulletMarker(source: string): string {
  const match = source.match(/^[ \t]*([-*+])\s/m);
  return match?.[1] ?? "-";
}

function isListElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  return tag === "ul" || tag === "ol";
}

function isCheckboxElement(node: ChildNode): node is Element {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    (node as Element).tagName.toLowerCase() === "input" &&
    (node as Element).getAttribute("type") === "checkbox"
  );
}

/**
 * Task 1 turns a source `- [ ] text` / `- [x] text` item into an `<li>`
 * whose first child is a manufactured `<input type="checkbox" disabled>` (or
 * `checked disabled`), not literal bracket text. If the item's content
 * starts with one, this pulls it off and turns it back into the `[ ] `/
 * `[x] ` prefix the marker line needs; a plain item (no checkbox) is
 * returned unchanged, so literal `[ ] `/`[x] ` bracket text elsewhere still
 * round-trips as ordinary text.
 */
function extractTaskPrefix(nodes: ChildNode[]): { prefix: string; contentNodes: ChildNode[] } {
  const [first, ...rest] = nodes;
  if (first && isCheckboxElement(first)) {
    const checked = first.hasAttribute("checked");
    return { prefix: `[${checked ? "x" : " "}] `, contentNodes: rest };
  }
  return { prefix: "", contentNodes: nodes };
}

function orderedStart(list: HTMLElement): number {
  // `HTMLOListElement.start` reflects a default of 1 when the attribute is
  // absent, which is indistinguishable from an explicit `start="1"` — but
  // an explicit `start="0"` is a real, meaningful value that `Number(...)
  // || 1` would silently turn back into 1. Reading the attribute directly
  // keeps 0 as 0.
  return list.hasAttribute("start") ? Number(list.getAttribute("start")) : 1;
}

function renderListItem(
  li: HTMLElement,
  source: string,
  bullet: string,
  indent: number,
  marker: string,
): string[] {
  // A loose list wraps each item's text in a `<p>`; a tight one doesn't.
  // Either way, a nested sublist is always its own direct child of the
  // `<li>`, alongside (not inside) that `<p>`.
  const paragraph = li.querySelector(":scope > p");
  const nestedLists = Array.from(li.children).filter(isListElement) as HTMLElement[];
  const rawContentNodes = paragraph
    ? Array.from(paragraph.childNodes)
    : Array.from(li.childNodes).filter((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return true;
        return !isListElement(node as Element);
      });

  const { prefix, contentNodes } = extractTaskPrefix(rawContentNodes);
  const inline = childNodesToMarkdown(contentNodes, source).trim();
  const indentStr = " ".repeat(indent);
  const firstLine = `${indentStr}${marker} ${prefix}${inline}`;

  // A nested list's content must indent past this item's own marker plus
  // its trailing space (`"10. "` is 4 columns wide) for markdown-it to
  // parse it back as nested rather than a new sibling block.
  const childIndent = indent + marker.length + 1;
  const nestedLines = nestedLists.flatMap((nested) =>
    renderList(nested, source, bullet, childIndent),
  );

  return [firstLine, ...nestedLines];
}

function renderList(list: HTMLElement, source: string, bullet: string, indent: number): string[] {
  const isOrdered = list.tagName.toLowerCase() === "ol";
  const start = isOrdered ? orderedStart(list) : 0;
  const items = Array.from(list.children).filter(
    (child) => child.tagName.toLowerCase() === "li",
  ) as HTMLElement[];

  // Looseness (a blank line between source items) is per-list, not global:
  // a tight top-level list can contain a loose nested one and vice versa.
  // markdown-it's own signal for it is exactly this — an item's text
  // wrapped in a `<p>` rather than sitting directly in the `<li>`.
  const loose = items.some((li) => li.querySelector(":scope > p") !== null);

  const blocks = items.map((li, index) =>
    renderListItem(li, source, bullet, indent, isOrdered ? `${start + index}.` : bullet),
  );

  const lines: string[] = [];
  blocks.forEach((block, index) => {
    if (index > 0 && loose) lines.push("");
    lines.push(...block);
  });
  return lines;
}

function listToMarkdown(el: HTMLElement, source: string): string {
  const list = (el.querySelector("ul,ol") ?? el) as HTMLElement;
  const bullet = detectBulletMarker(source);
  return renderList(list, source, bullet, 0).join("\n");
}

function codeToMarkdown(el: HTMLElement, source: string): string {
  const codeEl = el.querySelector("code") ?? el;
  const rawBody = codeEl.textContent ?? "";
  // markdown-it always terminates a code block's content with a `\n`
  // (fenced or indented) that isn't part of the block's last line.
  const body = rawBody.endsWith("\n") ? rawBody.slice(0, -1) : rawBody;
  const bodyLines = body === "" ? [] : body.split("\n");

  const firstSourceLine = source.split("\n")[0] ?? "";
  const isFenced = /^(`{3,}|~{3,})/.test(firstSourceLine);
  if (isFenced) {
    // The fence lines (with any info string) are never edited as text —
    // only the body is — so they're carried over from the source verbatim.
    const sourceLines = source.split("\n");
    const openFence = sourceLines[0] ?? "```";
    const closeFence = sourceLines.length > 1 ? sourceLines[sourceLines.length - 1] : openFence;
    return [openFence, ...bodyLines, closeFence].join("\n");
  }

  // Task 1 maps an indented code_block to the same "code" kind; it has no
  // fence to preserve, just the 4-space indent markdown-it stripped off
  // when it built the DOM.
  return bodyLines.map((line) => `    ${line}`).join("\n");
}

function rawToMarkdown(el: HTMLElement): string {
  return el.textContent ?? "";
}

/**
 * Converts a plan block's editable DOM back to its markdown form, so an
 * edit can be compared against (and, if unchanged, dropped without a write
 * against) the block's original source.
 *
 * `el` is the block's wrapper element, containing whatever markdown-it
 * rendered for that block (an `h1`-`h6`, `p`, `ul`/`ol`, or `blockquote` for
 * the editable kinds; raw markdown text for `code`/`table`/`hr`/`other`,
 * which edit as plain text rather than rendered HTML).
 */
export function blockToMarkdown(
  el: HTMLElement,
  original: { kind: BlockKind; level?: number; source: string },
): string {
  switch (original.kind) {
    case "heading":
      return headingToMarkdown(el, original.level ?? 1, original.source);
    case "paragraph":
      return paragraphToMarkdown(el, original.source);
    case "list":
      return listToMarkdown(el, original.source);
    case "quote":
      return quoteToMarkdown(el, original.source);
    case "code":
      return codeToMarkdown(el, original.source);
    default:
      // "table" | "hr" | "other": these edit as raw markdown text, so the
      // block's DOM already holds the source verbatim.
      return rawToMarkdown(el);
  }
}

function trimTrailingPerLine(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

// Drops wholly-blank lines off the end of `text`. A block's own `source`
// can end with one or more blank lines it never actually "owns" — parsePlan
// gives a list immediately followed by another block a range that absorbs
// the blank separator line between them (see blocks.ts's replaceBlock doc
// comment) — while a reconstruction built from that block's own rendered
// content (listToMarkdown, in particular) has no reason to reproduce a
// separator belonging to the next block. That mismatch must not itself read
// as an edit.
function trimTrailingBlankLines(text: string): string {
  const lines = text.split("\n");
  while (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

/**
 * The no-op rule: an edit that reduces to the original source once each
 * line's trailing whitespace, then any wholly-blank trailing lines, are
 * trimmed from both sides is not a real edit, and should not trigger a
 * write.
 */
export function isNoopEdit(next: string, source: string): boolean {
  const normalize = (text: string) => trimTrailingBlankLines(trimTrailingPerLine(text));
  return normalize(next) === normalize(source);
}
