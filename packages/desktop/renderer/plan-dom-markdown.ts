// Converts an edited plan block's DOM back to markdown so an in-place edit
// can be diffed against the source it started from (see isNoopEdit) and
// written back through plansWriteBlock. Pure DOM -> string: no @jarvis/*
// value import, so it can run in the renderer bundle unchanged.
//
// `PlanBlock` (kind/level/source) lives in @jarvis/core; only its shape is
// declared here (`BlockKind`, and the `original` parameter's inline type) to
// keep this module a type-only consumer, per the "renderer imports only
// types from workspace packages" rule.

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
 * Escapes markdown-significant characters in plain text, but only the ones
 * that don't already appear anywhere in the block's original source. If the
 * source already used a character (as markdown syntax or literal text), a
 * fresh occurrence typed during editing is left alone rather than risking a
 * double-escape; a character the source never used gets escaped so it can't
 * accidentally form new markdown syntax.
 */
function escapeIfNeeded(text: string, source: string): string {
  let result = text;
  for (const ch of ESCAPABLE_CHARS) {
    if (source.includes(ch)) continue;
    result = result.split(ch).join(`\\${ch}`);
  }
  return result;
}

function childNodesToMarkdown(nodes: ArrayLike<ChildNode>, source: string): string {
  let out = "";
  for (let i = 0; i < nodes.length; i += 1) {
    out += nodeToMarkdown(nodes[i] as ChildNode, source);
  }
  return out;
}

function nodeToMarkdown(node: ChildNode, source: string): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeIfNeeded(node.textContent ?? "", source);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }
  const el = node as HTMLElement;
  switch (el.tagName.toLowerCase()) {
    case "strong":
    case "b":
      return `**${childNodesToMarkdown(el.childNodes, source)}**`;
    case "em":
    case "i":
      return `*${childNodesToMarkdown(el.childNodes, source)}*`;
    case "code":
      return `\`${el.textContent ?? ""}\``;
    case "a": {
      const href = el.getAttribute("href") ?? "";
      return `[${childNodesToMarkdown(el.childNodes, source)}](${href})`;
    }
    case "br":
      return "  \n";
    default:
      return escapeIfNeeded(el.textContent ?? "", source);
  }
}

function inlineToMarkdown(el: Element, source: string): string {
  return childNodesToMarkdown(el.childNodes, source);
}

function headingToMarkdown(el: HTMLElement, level: number, source: string): string {
  const heading = el.querySelector("h1,h2,h3,h4,h5,h6") ?? el;
  return `${"#".repeat(Math.max(level, 1))} ${inlineToMarkdown(heading, source)}`;
}

function paragraphToMarkdown(el: HTMLElement, source: string): string {
  const paragraph = el.querySelector("p") ?? el;
  return inlineToMarkdown(paragraph, source);
}

function quoteToMarkdown(el: HTMLElement, source: string): string {
  const quote = el.querySelector("blockquote") ?? el;
  const paragraphs = Array.from(quote.querySelectorAll("p"));
  const content =
    paragraphs.length > 0
      ? paragraphs.map((p) => inlineToMarkdown(p, source)).join("\n>\n")
      : inlineToMarkdown(quote, source);
  return content
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

function detectBulletMarker(source: string): string {
  const match = source.match(/^[ \t]*([-*+])\s/m);
  return match?.[1] ?? "-";
}

function isListElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  return tag === "ul" || tag === "ol";
}

function isCheckbox(el: Element): boolean {
  return el.tagName.toLowerCase() === "input" && el.getAttribute("type") === "checkbox";
}

function renderList(list: HTMLElement, source: string, bullet: string, indent: number): string[] {
  const isOrdered = list.tagName.toLowerCase() === "ol";
  const start = isOrdered ? Number((list as HTMLOListElement).start) || 1 : 0;
  const items = Array.from(list.children).filter(
    (child) => child.tagName.toLowerCase() === "li",
  ) as HTMLElement[];

  const indentStr = " ".repeat(indent);
  const lines: string[] = [];

  items.forEach((li, index) => {
    const marker = isOrdered ? `${start + index}.` : bullet;
    const checkbox = Array.from(li.children).find(isCheckbox) as HTMLInputElement | undefined;
    const taskPrefix = checkbox ? `[${checkbox.checked ? "x" : " "}] ` : "";

    const nestedLists = Array.from(li.children).filter(isListElement) as HTMLElement[];
    const contentNodes = Array.from(li.childNodes).filter((node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return true;
      const child = node as Element;
      return !isListElement(child) && !isCheckbox(child);
    });

    const inline = childNodesToMarkdown(contentNodes, source).trim();
    lines.push(`${indentStr}${marker} ${taskPrefix}${inline}`);

    const childIndent = indent + (isOrdered ? 3 : 2);
    nestedLists.forEach((nested) => {
      lines.push(...renderList(nested, source, bullet, childIndent));
    });
  });

  return lines;
}

function listToMarkdown(el: HTMLElement, source: string): string {
  const list = (el.querySelector("ul,ol") ?? el) as HTMLElement;
  const bullet = detectBulletMarker(source);
  return renderList(list, source, bullet, 0).join("\n");
}

function codeToMarkdown(el: HTMLElement, source: string): string {
  const lines = source.split("\n");
  const openFence = lines[0] ?? "```";
  const closeFence = lines.length > 1 ? lines[lines.length - 1] : "```";
  const body = el.textContent ?? "";
  const bodyLines = body === "" ? [] : body.split("\n");
  return [openFence, ...bodyLines, closeFence].join("\n");
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

/**
 * The no-op rule: an edit that reduces to the original source once each
 * line's trailing whitespace is trimmed is not a real edit, and should not
 * trigger a write.
 */
export function isNoopEdit(next: string, source: string): boolean {
  return trimTrailingPerLine(next) === trimTrailingPerLine(source);
}
