// Search in the chat: its own field, a count, next and previous, matches
// marked by ranges (the CSS Custom Highlight API where the browser has it,
// <mark> text wrappers where it does not). Button labels (Copy, Show more) are
// not searched, except a file path in a reply: its label is words of the reply.
// Older pages are loaded on demand
// while it searches, with a visible Stop. Text hidden inside a closed row is
// not searched until it is opened.
import { el, fmt, ICONS, icon, type Translate } from "./dom.js";

/** The most older pages one search pulls in. */
export const SEARCH_MAX_PAGES = 25;
const MAX_MATCHES = 2000;

type HighlightApi = {
  set(name: string, value: unknown): void;
  delete(name: string): void;
};

function highlightApi(): { registry: HighlightApi; make(ranges: Range[]): unknown } | undefined {
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightApi } | undefined)
    ?.highlights;
  const ctor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown })
    .Highlight;
  if (registry === undefined || ctor === undefined) return undefined;
  return { registry, make: (ranges) => new ctor(...ranges) };
}

export type SearchOptions = {
  t: Translate;
  /** The element whose text is searched. */
  root: HTMLElement;
  /** Opens whatever hides this node. */
  reveal(node: Node): void;
  hasOlder(): boolean;
  /** Loads one older page; false when nothing more came. */
  loadOlder(): Promise<boolean>;
  onClose(): void;
};

export type Search = {
  element: HTMLElement;
  toggle: HTMLButtonElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** The feed was redrawn: mark the matches again. */
  refresh(): void;
  /** Settles when the older-page loop of the last query ended (tests). */
  idle(): Promise<void>;
};

function textNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (parent === null || node.nodeValue === "" || node.nodeValue === null)
        return NodeFilter.FILTER_REJECT;
      if (parent.closest("[hidden], button:not(.ac-path), .ac-working, .ac-menu") !== null)
        return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
    out.push(node as Text);
  return out;
}

export function createSearch(options: SearchOptions): Search {
  const { t, root } = options;
  const element = el("div", "ac-search");
  element.hidden = true;
  element.setAttribute("role", "search");
  const input = el("input", "ac-search__input");
  input.type = "search";
  input.setAttribute("aria-label", t("agentChatSearchLabel"));
  input.placeholder = t("agentChatSearchPlaceholder");
  input.spellcheck = false;
  input.dir = "auto";
  const count = el("span", "ac-search__count");
  count.setAttribute("role", "status");
  const previous = el("button", "ac-iconbutton");
  previous.type = "button";
  previous.append(icon(ICONS.up, 14));
  previous.setAttribute("aria-label", t("agentChatSearchPrevious"));
  const next = el("button", "ac-iconbutton");
  next.type = "button";
  next.append(icon(ICONS.down, 14));
  next.setAttribute("aria-label", t("agentChatSearchNext"));
  const stop = el("button", "ac-link-button", t("agentChatSearchStop"));
  stop.type = "button";
  stop.hidden = true;
  const progress = el("span", "ac-search__progress");
  progress.setAttribute("role", "status");
  const closeButton = el("button", "ac-iconbutton");
  closeButton.type = "button";
  closeButton.append(icon(ICONS.close, 14));
  closeButton.setAttribute("aria-label", t("agentChatSearchClose"));
  element.append(input, count, previous, next, progress, stop, closeButton);

  const toggle = el("button", "ac-iconbutton");
  toggle.type = "button";
  toggle.append(icon(ICONS.search));
  toggle.setAttribute("aria-label", t("agentChatSearchOpen"));
  toggle.title = t("agentChatSearchOpen");
  toggle.setAttribute("aria-expanded", "false");

  let ranges: Range[] = [];
  let current = 0;
  let marks: HTMLElement[] = [];
  let looping: Promise<void> = Promise.resolve();
  let stopped = false;
  let generation = 0;

  function clearMarks(): void {
    const api = highlightApi();
    api?.registry.delete("ac-search");
    api?.registry.delete("ac-search-current");
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (parent === null) continue;
      parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
      parent.normalize();
    }
    marks = [];
  }

  function paintCurrent(scroll: boolean): void {
    const api = highlightApi();
    const range = ranges[current];
    if (api !== undefined) {
      if (range === undefined) api.registry.delete("ac-search-current");
      else api.registry.set("ac-search-current", api.make([range]));
    } else {
      for (const [at, mark] of marks.entries())
        mark.classList.toggle("ac-hit--current", at === current);
    }
    count.textContent =
      ranges.length === 0
        ? input.value === ""
          ? ""
          : t("agentChatSearchNone")
        : fmt(t("agentChatSearchCount"), { n: current + 1, total: ranges.length });
    if (scroll && range !== undefined) {
      const target = marks[current] ?? range.startContainer.parentElement;
      options.reveal(marks[current] ?? range.startContainer);
      target?.scrollIntoView?.({ block: "center" });
    }
  }

  function mark(scroll: boolean): void {
    clearMarks();
    ranges = [];
    const query = input.value.trim().toLowerCase();
    if (query !== "" && !element.hidden) {
      for (const node of textNodes(root)) {
        const text = (node.nodeValue ?? "").toLowerCase();
        for (
          let at = text.indexOf(query);
          at !== -1 && ranges.length < MAX_MATCHES;
          at = text.indexOf(query, at + query.length)
        ) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + query.length);
          ranges.push(range);
        }
        if (ranges.length >= MAX_MATCHES) break;
      }
    }
    const api = highlightApi();
    if (api !== undefined) {
      if (ranges.length > 0) api.registry.set("ac-search", api.make(ranges));
    } else {
      // Wrapping splits text nodes: the later ranges of a node go first.
      marks = [...ranges]
        .reverse()
        .map((range) => {
          const wrap = el("mark", "ac-hit");
          range.surroundContents(wrap);
          return wrap;
        })
        .reverse();
    }
    current = Math.min(current, Math.max(0, ranges.length - 1));
    paintCurrent(scroll);
  }

  function step(delta: number): void {
    if (ranges.length === 0) return;
    current = (current + delta + ranges.length) % ranges.length;
    paintCurrent(true);
  }

  async function loadLoop(token: number): Promise<void> {
    let pages = 0;
    stopped = false;
    while (token === generation && !stopped && options.hasOlder() && pages < SEARCH_MAX_PAGES) {
      progress.textContent = t("agentChatSearchLoading");
      stop.hidden = false;
      const more = await options.loadOlder();
      pages++;
      if (!more) break;
    }
    if (token !== generation) return;
    stop.hidden = true;
    progress.textContent = stopped && options.hasOlder() ? t("agentChatSearchStopped") : "";
  }

  function query(): void {
    generation++;
    current = 0;
    mark(true);
    if (input.value.trim() !== "" && options.hasOlder()) looping = loadLoop(generation);
    else {
      stop.hidden = true;
      progress.textContent = "";
    }
  }

  input.addEventListener("input", query);
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  });
  previous.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  stop.addEventListener("click", () => {
    stopped = true;
    stop.hidden = true;
    progress.textContent = options.hasOlder() ? t("agentChatSearchStopped") : "";
  });
  closeButton.addEventListener("click", () => close());
  element.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  toggle.addEventListener("click", () => (element.hidden ? open() : close()));

  function open(): void {
    element.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    input.focus();
    input.select();
    if (input.value !== "") query();
  }

  function close(): void {
    generation++;
    stopped = true;
    element.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    clearMarks();
    ranges = [];
    stop.hidden = true;
    progress.textContent = "";
    options.onClose();
  }

  return {
    element,
    toggle,
    open,
    close,
    isOpen: () => !element.hidden,
    refresh() {
      if (!element.hidden && input.value.trim() !== "") mark(false);
    },
    idle: () => looping,
  };
}
