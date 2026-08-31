import type { DocBlock, DocInline } from "@jarvis/core";
import { detectLanguage } from "./format.js";

/**
 * A document model to DOM nodes. Every string reaching this file was written
 * by an agent or found in a repository, and this is the process that holds
 * window.jarvis — so text becomes text, via textContent, and nothing here
 * ever parses a string as markup. The document model has no HTML in it by
 * construction (markdown.ts, html: false), which is what makes that
 * possible rather than merely careful.
 */
export function renderDocument(blocks: DocBlock[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const block of blocks) fragment.append(renderBlock(block));
  return fragment;
}

function renderBlock(block: DocBlock): Node {
  switch (block.kind) {
    case "heading": {
      const element = document.createElement(`h${block.level}`);
      element.append(renderInlines(block.children));
      applyDirection(element);
      return element;
    }
    case "paragraph": {
      const element = document.createElement("p");
      element.append(renderInlines(block.children));
      applyDirection(element);
      return element;
    }
    case "code": {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (block.language !== "") code.className = `language-${block.language}`;
      code.textContent = block.text;
      pre.append(code);
      return pre;
    }
    case "rule":
      return document.createElement("hr");
    case "list": {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const li = document.createElement("li");
        for (const child of item) li.append(renderBlock(child));
        list.append(li);
      }
      return list;
    }
    case "quote": {
      const quote = document.createElement("blockquote");
      for (const child of block.children) quote.append(renderBlock(child));
      return quote;
    }
    case "table": {
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const cell of block.head) {
        const th = document.createElement("th");
        th.append(renderInlines(cell));
        headRow.append(th);
      }
      thead.append(headRow);
      const tbody = document.createElement("tbody");
      for (const row of block.rows) {
        const tr = document.createElement("tr");
        for (const cell of row) {
          const td = document.createElement("td");
          td.append(renderInlines(cell));
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(thead, tbody);
      return table;
    }
  }
}

export function renderInlines(nodes: DocInline[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        fragment.append(document.createTextNode(node.text));
        break;
      case "code": {
        const code = document.createElement("code");
        code.textContent = node.text;
        fragment.append(code);
        break;
      }
      case "emphasis": {
        const em = document.createElement("em");
        em.append(renderInlines(node.children));
        fragment.append(em);
        break;
      }
      case "strong": {
        const strong = document.createElement("strong");
        strong.append(renderInlines(node.children));
        fragment.append(strong);
        break;
      }
      case "link": {
        const anchor = document.createElement("a");
        // The scheme was gated in core (Task 3); this is the second half —
        // no referrer and no window.opener handle for the page opened.
        anchor.href = node.href;
        anchor.rel = "noreferrer noopener";
        anchor.append(renderInlines(node.children));
        fragment.append(anchor);
        break;
      }
    }
  }
  return fragment;
}

/** Arabic documents must lay out right-to-left; the same detectLanguage the
 *  Changes view uses decides, so one rule governs both. */
function applyDirection(element: HTMLElement): void {
  const language = detectLanguage(element.textContent ?? "");
  if (language === "ar") {
    element.dir = "rtl";
    element.classList.add("arabic");
  }
}
