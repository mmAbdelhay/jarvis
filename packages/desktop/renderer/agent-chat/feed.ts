// The conversation: items in their true order, drawn as keyed DOM so an
// unchanged item keeps its node (and with it selection, scroll and what the
// reader opened). Rows use content-visibility so thousands scroll smoothly.
// An update never moves a reader who scrolled up; loading older items keeps
// what they were looking at where it was.
import type { ChatDividerItem, ChatItem, ChatMessageItem, ChatToolItem } from "@jarvis/platform";
import { type CodeContext, copyButton, renderMarkdown } from "./code.js";
import type { MessageKey } from "../../src/messages.js";
import { duration, el, fmt, ICONS, icon, type Translate } from "./dom.js";
import {
  buildGroup,
  buildToolCard,
  groupSig,
  type ToolContext,
  toolKind,
  toolSig,
} from "./tool-row.js";

/** How close to the bottom still counts as "at the bottom", in px. */
const BOTTOM_SLACK_PX = 24;
/** A scroll within this long of a wheel, touch or key is the reader's. */
const USER_SCROLL_MS = 500;
/** A turn shorter than this has no "Worked for" line. */
const MIN_TURN_MS = 10_000;
/** How close to the top asks for the page before. */
const TOP_SLACK_PX = 160;

export type FeedOptions = {
  t: Translate;
  openLink(url: string): void;
  openFile(path: string): void;
  copy(text: string): void;
  /** The reader is near the top and older items exist. */
  loadOlder(): void;
  /** The feed was redrawn (search re-marks its matches). */
  rendered?(): void;
};

export type FeedState = {
  /** Claude's own spinner text, or the generic label. */
  working?: string;
  /** When the running turn began, for the elapsed time. */
  workingSince?: number;
  now: number;
  older: "none" | "more" | "loading";
  /** The new items sit above what was already shown (older pages loaded). */
  prepended?: boolean;
};

type Entry = { key: string; sig: string; build(): HTMLElement };

export type Feed = {
  /** The wrapper: the scroller and the jump button. */
  element: HTMLElement;
  scroller: HTMLElement;
  column: HTMLElement;
  setItems(items: readonly ChatItem[], state: FeedState): void;
  scrollToBottom(): void;
  atBottom(): boolean;
  /** Opens whatever hides the node (a closed group or output) so it can be seen. */
  reveal(node: Node): void;
  /** The ids drawn, in order (for tests and search). */
  ids(): string[];
};

function eventKey(item: ChatDividerItem): MessageKey {
  return item.event === "compacted"
    ? "agentChatEventCompacted"
    : item.event === "interrupted"
      ? "agentChatEventInterrupted"
      : "agentChatEventAgentDone";
}

const isMessage = (item: ChatItem): item is ChatMessageItem =>
  item.kind === "user" || item.kind === "text";

function lastTime(item: ChatItem): number | undefined {
  if (item.kind === "tool") return item.endAt ?? item.at;
  return item.at;
}

export function createFeed(options: FeedOptions): Feed {
  const { t } = options;
  const element = el("div", "ac-feedwrap");
  const scroller = el("div", "agent-chat__feed");
  scroller.setAttribute("role", "log");
  scroller.setAttribute("aria-label", t("agentChatFeedLabel"));
  scroller.tabIndex = 0;
  const column = el("div", "ac-column");
  scroller.append(column);
  const jump = el("button", "ac-jump", t("agentChatJumpLatest"));
  jump.type = "button";
  jump.hidden = true;
  jump.prepend(icon(ICONS.down, 14));
  element.append(scroller, jump);

  const open = new Map<string, boolean>();
  const toolContext: ToolContext = {
    t,
    openLink: options.openLink,
    copy: options.copy,
    openFile: options.openFile,
    isOpen: (key, fallback) => open.get(key) ?? fallback,
    setOpen: (key, value) => void open.set(key, value),
  };
  const codeContext: CodeContext = toolContext;
  const nodes = new Map<string, { sig: string; node: HTMLElement }>();
  let stuck = true;
  let lastState: FeedState | undefined;

  const distance = (): number => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  const atBottom = (): boolean => distance() <= BOTTOM_SLACK_PX;

  function scrollToBottom(): void {
    scroller.scrollTop = scroller.scrollHeight;
    stuck = true;
    jump.hidden = true;
  }

  // Only the reader moves the feed off the bottom: a wheel, a touch, a key, or a
  // drag of the scrollbar. A scroll the layout causes (rows measured under
  // content-visibility, a card appearing) is not one, and must not unpin.
  let userAt = Number.NEGATIVE_INFINITY;
  let dragging = false;
  const byUser = (): boolean => dragging || Date.now() - userAt < USER_SCROLL_MS;
  const mark = (): void => {
    userAt = Date.now();
  };
  scroller.addEventListener("wheel", mark, { passive: true });
  scroller.addEventListener("touchmove", mark, { passive: true });
  scroller.addEventListener("keydown", (event) => {
    if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(event.key))
      mark();
  });
  scroller.addEventListener("pointerdown", (event) => {
    // A press on the scroller itself (its scrollbar), not on a row's button.
    if (event.target === scroller) dragging = true;
  });
  document.addEventListener("pointerup", () => {
    dragging = false;
  });
  scroller.addEventListener("scroll", () => {
    if (atBottom()) stuck = true;
    else if (byUser()) stuck = false;
    else if (stuck) scrollToBottom();
    jump.hidden = stuck;
    if (scroller.scrollTop <= TOP_SLACK_PX && lastState?.older === "more") options.loadOlder();
  });
  // The feed's box or its content changing size (a card or the drawer appearing
  // below) must not strand a reader who was at the bottom.
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      if (stuck) scrollToBottom();
    });
    observer.observe(scroller);
    observer.observe(column);
  }
  jump.addEventListener("click", () => {
    scrollToBottom();
    scroller.focus({ preventScroll: true });
  });

  function messageRow(item: ChatMessageItem): HTMLElement {
    const user = item.kind === "user";
    const row = el(
      "div",
      `agent-chat__row ac-row agent-chat__row--${user ? "user" : "text"} ac-msg`,
    );
    row.dataset["itemId"] = item.id;
    if (user) {
      const bubble = el("div", "agent-chat__bubble", item.text);
      bubble.dir = "auto";
      row.append(bubble);
      if (item.images !== undefined && item.images > 0) {
        row.append(el("span", "ac-images", fmt(t("agentChatImages"), { n: item.images })));
      }
    } else {
      for (const block of renderMarkdown(item.text, codeContext)) row.append(block);
    }
    const actions = el("div", "ac-msg__actions");
    actions.append(copyButton(codeContext, () => item.text, "ac-copy ac-copy--message"));
    row.append(actions);
    return row;
  }

  function dividerRow(item: ChatDividerItem): HTMLElement {
    const text =
      item.event === "agentDone" && item.label !== undefined
        ? fmt(t("agentChatEventAgentDoneNamed"), { label: item.label })
        : t(eventKey(item));
    const row = el("div", "ac-divider ac-row", text);
    row.dataset["itemId"] = item.id;
    return row;
  }

  function turnRow(id: string, text: string): HTMLElement {
    const row = el("div", "ac-turn", text);
    row.dataset["itemId"] = id;
    return row;
  }

  function workingRow(state: FeedState): HTMLElement {
    const row = el("div", "ac-working");
    row.setAttribute("role", "status");
    row.append(icon(ICONS.spinner, 16));
    const label =
      state.working !== undefined && state.working.trim() !== ""
        ? state.working
        : t("agentChatWorking");
    row.append(el("span", "ac-working__label", label));
    if (state.workingSince !== undefined && !/\d\s*[smh]\b/.test(label)) {
      const spent = state.now - state.workingSince;
      if (spent >= 0) row.append(el("span", "ac-working__time", duration(spent)));
    }
    return row;
  }

  function entriesOf(items: readonly ChatItem[], state: FeedState): Entry[] {
    const entries: Entry[] = [];
    let turnStart: ChatItem | undefined;
    let turnLast: number | undefined;
    const closeTurn = (finished: boolean): void => {
      if (turnStart === undefined || turnStart.at === undefined || turnLast === undefined) return;
      // Only a turn that took a while is worth saying so about.
      if (!finished || turnLast - turnStart.at < MIN_TURN_MS) return;
      const id = `turn:${turnStart.id}`;
      const text = fmt(t("agentChatWorkedFor"), { time: duration(turnLast - turnStart.at) });
      entries.push({ key: id, sig: text, build: () => turnRow(id, text) });
    };
    for (let at = 0; at < items.length; at++) {
      const item = items[at];
      if (item === undefined) continue;
      if (item.kind === "user") {
        closeTurn(true);
        turnStart = item;
        turnLast = undefined;
      }
      const time = lastTime(item);
      if (time !== undefined && (turnLast === undefined || time > turnLast)) turnLast = time;
      if (isMessage(item)) {
        if (item.text.trim() === "" && !(item.kind === "user" && (item.images ?? 0) > 0)) continue;
        entries.push({
          key: item.id,
          sig: `${item.kind}:${item.text}:${item.images ?? 0}`,
          build: () => messageRow(item),
        });
        continue;
      }
      if (item.kind === "divider") {
        entries.push({
          key: item.id,
          sig: `${item.event}:${item.label ?? ""}`,
          build: () => dividerRow(item),
        });
        continue;
      }
      if (toolKind(item) === "read") {
        const group: ChatToolItem[] = [item];
        while (at + 1 < items.length) {
          const next = items[at + 1];
          if (next?.kind !== "tool" || toolKind(next) !== "read") break;
          group.push(next);
          const nextTime = lastTime(next);
          if (nextTime !== undefined && (turnLast === undefined || nextTime > turnLast))
            turnLast = nextTime;
          at++;
        }
        entries.push({
          key: `g:${item.id}`,
          sig: groupSig(group),
          build: () => buildGroup(group, toolContext),
        });
      } else {
        entries.push({
          key: item.id,
          sig: toolSig(item),
          build: () => buildToolCard(item, toolContext),
        });
      }
    }
    // The running turn is closed only when the agent is idle.
    closeTurn(state.working === undefined);
    return entries;
  }

  function setItems(items: readonly ChatItem[], state: FeedState): void {
    lastState = state;
    const wasStuck = stuck && atBottom();
    const height = scroller.scrollHeight;
    const top = scroller.scrollTop;
    const entries = entriesOf(items, state);
    if (state.older !== "none") {
      entries.unshift({
        key: "older",
        sig: state.older,
        build: () => {
          const row = el("div", "ac-older");
          if (state.older === "loading") {
            row.append(el("span", undefined, t("agentChatLoadingOlder")));
            row.setAttribute("role", "status");
          } else {
            const button = el("button", "ac-link-button", t("agentChatLoadOlder"));
            button.type = "button";
            button.addEventListener("click", () => options.loadOlder());
            row.append(button);
          }
          return row;
        },
      });
    }
    if (state.working !== undefined) {
      const label = state.working;
      const spent =
        state.workingSince === undefined
          ? ""
          : duration(Math.max(0, state.now - state.workingSince));
      entries.push({ key: "working", sig: `${label}|${spent}`, build: () => workingRow(state) });
    }
    if (items.length === 0 && state.working === undefined) {
      entries.push({
        key: "empty",
        sig: "empty",
        build: () => el("p", "agent-chat__empty", t("agentChatEmpty")),
      });
    }

    const wanted = new Set(entries.map((entry) => entry.key));
    for (const [key, held] of nodes) {
      if (!wanted.has(key)) {
        held.node.remove();
        nodes.delete(key);
      }
    }
    let cursor: ChildNode | null = column.firstChild;
    for (const entry of entries) {
      let held = nodes.get(entry.key);
      if (held === undefined || held.sig !== entry.sig) {
        if (held !== undefined && held.node === cursor) cursor = cursor.nextSibling;
        held?.node.remove();
        held = { sig: entry.sig, node: entry.build() };
        nodes.set(entry.key, held);
      }
      if (held.node === cursor) cursor = cursor.nextSibling;
      else column.insertBefore(held.node, cursor);
    }

    if (state.prepended === true) {
      scroller.scrollTop = top + (scroller.scrollHeight - height);
    } else if (wasStuck) {
      scrollToBottom();
    } else {
      // The reader scrolled up: leave them exactly there, offer the way back.
      jump.hidden = false;
    }
    options.rendered?.();
  }

  return {
    element,
    scroller,
    column,
    setItems,
    scrollToBottom,
    atBottom,
    reveal(node) {
      for (let at: Node | null = node; at !== null && at !== column; at = at.parentNode) {
        if (at instanceof HTMLElement && at.hidden) {
          const toggleButton = at.parentElement?.querySelector<HTMLElement>(
            ":scope > .ac-card__head .ac-toggle, :scope > .ac-toggle, :scope > .ac-link-button",
          );
          if (toggleButton !== null && toggleButton !== undefined) toggleButton.click();
          else at.hidden = false;
        }
      }
    },
    ids: () =>
      [...column.querySelectorAll<HTMLElement>("[data-item-id]")].map(
        (n) => n.dataset["itemId"] ?? "",
      ),
  };
}
