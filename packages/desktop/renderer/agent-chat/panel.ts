// The side panel (To-do, Sub-agents, Changed files, then Usage limits,
// Context, Session and the raw status rows) and, under 1000px of pane width,
// the chips above the composer that open the same sections in a popover. A
// section with no data is not drawn; the panel can be hidden and that is
// remembered.
import type { ChatAgent, ChatFile, ChatTodo } from "@jarvis/platform";
import { fileIcon } from "../file-icons.js";
import { buildLimitBlock, type ContextInfo, contextValue, type StatusData } from "./status.js";
import { count } from "./tool-row.js";
import {
  basename,
  dirname,
  duration,
  el,
  fmt,
  fmtNode,
  ICONS,
  icon,
  type Translate,
} from "./dom.js";

export type SectionKind = "todo" | "agents" | "files" | "limits" | "context" | "session" | "raw";

export type PanelData = {
  todos?: readonly ChatTodo[];
  agents: readonly ChatAgent[];
  files: readonly ChatFile[];
  context?: ContextInfo;
  /** The agent's usage limits and what its status line says. */
  status?: StatusData;
  /** The whole session is still being read: the lists fill in later. */
  deriving?: boolean;
  now: number;
};

const SESSION_FIELDS = ["account", "folder", "branch", "model"] as const;

export function sectionsOf(data: PanelData): SectionKind[] {
  const kinds: SectionKind[] = [];
  if (data.todos !== undefined && data.todos.length > 0) kinds.push("todo");
  if (data.agents.length > 0) kinds.push("agents");
  if (data.files.length > 0) kinds.push("files");
  if ((data.status?.limits.length ?? 0) > 0) kinds.push("limits");
  if (data.context !== undefined) kinds.push("context");
  if (SESSION_FIELDS.some((field) => data.status?.details?.[field] !== undefined)) {
    kinds.push("session");
  }
  if ((data.status?.lines.length ?? 0) > 0) kinds.push("raw");
  return kinds;
}

/** The kinds that get a chip above the composer in a narrow pane. */
export function chipKinds(kinds: readonly SectionKind[]): SectionKind[] {
  return kinds.filter(
    (kind) => kind === "todo" || kind === "agents" || kind === "files" || kind === "context",
  );
}

/** "To-do, 2 of 4", "Sub-agents": the heading text of a section. */
export function headingOf(kind: SectionKind, data: PanelData, t: Translate): string {
  if (kind === "todo") {
    const todos = data.todos ?? [];
    const done = todos.filter((todo) => todo.state === "done").length;
    return fmt(t("agentChatPanelTodo"), { done, total: todos.length });
  }
  if (kind === "agents") return t("agentChatPanelAgents");
  if (kind === "files") return t("agentChatPanelFiles");
  if (kind === "limits") return t("agentChatPanelLimits");
  if (kind === "session") return t("agentChatPanelSession");
  if (kind === "raw") return t("agentChatPanelRaw");
  return t("agentChatChipContext");
}

/** The short chip: "To-do 2 of 4", "Sub-agents 1", "Changed files 2", "Context 6% used". */
export function chipOf(
  kind: SectionKind,
  data: PanelData,
  t: Translate,
): { name: string; value: string } {
  if (kind === "todo") {
    const todos = data.todos ?? [];
    const done = todos.filter((todo) => todo.state === "done").length;
    return {
      name: t("agentChatChipTodo"),
      value: fmt(t("agentChatChipOf"), { done, total: todos.length }),
    };
  }
  if (kind === "agents") {
    const running = data.agents.filter((agent) => agent.state === "running").length;
    return {
      name: t("agentChatPanelAgents"),
      value: String(running > 0 ? running : data.agents.length),
    };
  }
  if (kind === "files") return { name: t("agentChatPanelFiles"), value: String(data.files.length) };
  return {
    name: headingOf(kind, data, t),
    value: data.context === undefined ? "" : contextValue(data.context, t).text,
  };
}

function agentState(agent: ChatAgent, now: number, t: Translate): string {
  if (agent.state === "running") {
    const spent = agent.startedAt === undefined ? undefined : duration(now - agent.startedAt);
    return spent === undefined
      ? t("agentChatAgentRunning")
      : fmt(t("agentChatAgentRunningFor"), { time: spent });
  }
  if (agent.state === "failed") return t("agentChatAgentFailed");
  return agent.startedAt !== undefined &&
    agent.endedAt !== undefined &&
    agent.endedAt >= agent.startedAt
    ? fmt(t("agentChatAgentDoneIn"), { time: duration(agent.endedAt - agent.startedAt) })
    : t("agentChatAgentDone");
}

/** The short time at the end of a sub-agent row: "41h 30m", "Failed", or nothing. */
function agentTime(agent: ChatAgent, now: number, t: Translate): string {
  if (agent.state === "running") {
    return agent.startedAt === undefined ? "" : duration(now - agent.startedAt);
  }
  if (agent.state === "failed") return t("agentChatAgentFailed");
  return agent.startedAt !== undefined &&
    agent.endedAt !== undefined &&
    agent.endedAt >= agent.startedAt
    ? duration(agent.endedAt - agent.startedAt)
    : "";
}

const NEVER = Number.NEGATIVE_INFINITY;

/** Running first (newest start first), then failed, then done (newest end first). */
export function orderAgents(agents: readonly ChatAgent[]): ChatAgent[] {
  const rank = { running: 0, failed: 1, done: 2 } as const;
  const when = (agent: ChatAgent): number =>
    agent.state === "running"
      ? (agent.startedAt ?? NEVER)
      : (agent.endedAt ?? agent.startedAt ?? NEVER);
  return [...agents].sort((a, b) => rank[a.state] - rank[b.state] || when(b) - when(a));
}

/** The last two parts of a path: "/home/me/code/app" is "code/app". */
function shortFolder(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts.length <= 2 ? path : parts.slice(-2).join("/");
}

function keyValue(label: string, value: string, title?: string): HTMLElement {
  const row = el("div", "ac-kv");
  const node = el("span", "ac-kv__value", value);
  node.dir = "auto";
  node.title = title ?? value;
  row.append(el("span", "ac-kv__key", label), node);
  return row;
}

/** The lists that can be cut short and then shown in full. */
export type ListKind = "agents" | "files" | "done";

/** Sections in the scrolling part of the panel, the ones that collapse. */
export const COLLAPSIBLE: readonly SectionKind[] = ["todo", "agents", "files", "session", "raw"];
const DEFAULT_OPEN: Record<string, boolean> = { todo: true, agents: true, files: true };

const FILE_CAP = 6;
const AGENT_CAP = 5;
const AGENT_RUNNING_CAP = 8;
const DONE_TODO_CAP = 3;

let nextSectionId = 0;

export type SectionContext = {
  t: Translate;
  openFile(path: string): void;
  /** Present in the side panel: the sections collapse. Absent in the popover. */
  collapse?: { open(kind: SectionKind): boolean; toggle(kind: SectionKind): void };
  /** Whether a capped list is shown in full. */
  expanded(list: ListKind): boolean;
  toggleList(list: ListKind): void;
};

function moreButton(list: ListKind, label: string, shown: boolean, ctx: SectionContext) {
  const button = el("button", "ac-more", label);
  button.type = "button";
  button.dataset["key"] = `more:${list}`;
  button.setAttribute("aria-expanded", String(shown));
  button.addEventListener("click", () => ctx.toggleList(list));
  return button;
}

function appendCapped<T>(
  body: HTMLElement,
  items: readonly T[],
  cap: number,
  list: ListKind,
  ctx: SectionContext,
  row: (item: T) => HTMLElement,
): void {
  const all = ctx.expanded(list);
  for (const item of all ? items : items.slice(0, cap)) body.append(row(item));
  if (items.length > cap) {
    const label = all
      ? ctx.t("agentChatShowFewer")
      : fmt(ctx.t("agentChatListShowAll"), { n: items.length });
    body.append(moreButton(list, label, all, ctx));
  }
}

function agentRow(agent: ChatAgent, data: PanelData, t: Translate): HTMLElement {
  const row = el("div", "ac-agent");
  row.dataset["agentId"] = agent.id;
  const phrase = agentState(agent, data.now, t);
  row.title = phrase;
  const mark = el(
    "span",
    `ac-mark ac-agent__mark ac-mark--${agent.state === "failed" ? "error" : agent.state}`,
  );
  mark.setAttribute("aria-hidden", "true");
  mark.append(
    icon(
      agent.state === "running"
        ? ICONS.spinner
        : agent.state === "failed"
          ? ICONS.close
          : ICONS.check,
      12,
    ),
  );
  const name = el("span", "ac-agent__name", agent.label);
  name.dir = "auto";
  name.title = agent.label;
  const time = el(
    "span",
    `ac-agent__time ac-agent__time--${agent.state}`,
    agentTime(agent, data.now, t),
  );
  time.setAttribute("aria-hidden", "true");
  const spoken = el("span", "ac-sr-only ac-agent__state", phrase);
  row.append(mark, name, time, spoken);
  return row;
}

function fileRow(file: ChatFile, ctx: SectionContext): HTMLElement {
  const { t } = ctx;
  const button = el("button", "ac-file");
  button.type = "button";
  button.title = file.path;
  button.setAttribute("aria-label", `${t("agentChatOpenFile")} ${file.path}`);
  const name = el("span", "ac-file__name", basename(file.path));
  name.dir = "ltr";
  const folder = dirname(file.path);
  button.append(
    fileIcon(
      basename(file.path),
      folder === "" || folder === "/" ? {} : { parent: basename(folder) },
    ),
    name,
  );
  if (folder !== "" && folder !== "/") {
    const dir = el("span", "ac-file__dir", shortFolder(folder));
    dir.dir = "ltr";
    button.append(dir);
  }
  const counts = el("span", "ac-file__counts");
  if (file.added !== undefined && file.added > 0) {
    counts.append(count("agent-chat__add", `+${file.added}`));
  }
  if (file.removed !== undefined && file.removed > 0) {
    counts.append(count("agent-chat__del", `\u2212${file.removed}`));
  }
  button.append(counts);
  button.addEventListener("click", () => ctx.openFile(file.path));
  return button;
}

function todoRow(todo: ChatTodo, t: Translate): HTMLElement {
  const row = el("div", `ac-todo ac-todo--${todo.state}`);
  row.append(
    icon(
      todo.state === "done"
        ? ICONS.todoDone
        : todo.state === "active"
          ? ICONS.todoActive
          : ICONS.todoOpen,
    ),
  );
  const text = el("span", "ac-todo__text", todo.text);
  text.dir = "auto";
  row.append(text);
  row.setAttribute(
    "aria-label",
    `${todo.text}, ${t(todo.state === "done" ? "agentChatTodoDone" : todo.state === "active" ? "agentChatTodoActive" : "agentChatTodoOpen")}`,
  );
  return row;
}

/** The muted one-line summary at the end of a collapsible header. */
function summaryOf(kind: SectionKind, data: PanelData, t: Translate): (Node | string)[] {
  if (kind === "todo") {
    const todos = data.todos ?? [];
    const done = todos.filter((todo) => todo.state === "done").length;
    return [fmt(t("agentChatChipOf"), { done, total: todos.length })];
  }
  if (kind === "agents") {
    const n = (state: ChatAgent["state"]): number =>
      data.agents.filter((agent) => agent.state === state).length;
    const out: (Node | string)[] = [];
    const parts: [number, "agentChatSummaryRunning" | "agentChatSummaryDone"][] = [
      [n("running"), "agentChatSummaryRunning"],
      [n("done"), "agentChatSummaryDone"],
    ];
    for (const [value, key] of parts) {
      if (value > 0) out.push(fmt(t(key), { n: value }));
    }
    const failed = n("failed");
    if (failed > 0) {
      const bad = el("span", "ac-section__bad", fmt(t("agentChatSummaryFailed"), { n: failed }));
      out.push(bad);
    }
    // Joined with a middle dot between parts.
    return out.flatMap((part, index) => (index === 0 ? [part] : [" \u00b7 ", part]));
  }
  if (kind === "files") {
    const added = data.files.reduce((sum, file) => sum + (file.added ?? 0), 0);
    const removed = data.files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
    const delta = [added > 0 ? `+${added}` : "", removed > 0 ? `\u2212${removed}` : ""]
      .filter((part) => part !== "")
      .join(" ");
    const text = [String(data.files.length), delta].filter((part) => part !== "").join(" \u00b7 ");
    const counts = el("bdi", undefined, text);
    counts.dir = "ltr"; // Signs stay before their numbers in Arabic too.
    return [counts];
  }
  return [];
}

export function buildSection(kind: SectionKind, data: PanelData, ctx: SectionContext): HTMLElement {
  const { t } = ctx;
  const section = el("section", "ac-section");
  section.dataset["section"] = kind;
  const body = el("div", "ac-section__body");
  const collapse = COLLAPSIBLE.includes(kind) ? ctx.collapse : undefined;

  if (collapse !== undefined) {
    const open = collapse.open(kind);
    nextSectionId += 1;
    const id = `ac-section-${nextSectionId}`;
    const title = el("h2", "ac-section__title");
    const button = el("button", "ac-section__toggle");
    button.type = "button";
    button.dataset["key"] = `toggle:${kind}`;
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-controls", id);
    const name = el(
      "span",
      "ac-section__name",
      kind === "todo" ? t("agentChatChipTodo") : headingOf(kind, data, t),
    );
    const summary = el("span", "ac-section__summary");
    summary.dir = "auto";
    summary.append(...summaryOf(kind, data, t));
    button.append(icon(open ? ICONS.chevronDown : ICONS.chevron, 12), name, summary);
    button.addEventListener("click", () => collapse.toggle(kind));
    title.append(button);
    body.id = id;
    body.hidden = !open;
    section.append(title, body);
  } else {
    const title = el("h2", "ac-section__title", headingOf(kind, data, t));
    if (kind === "context" && data.context !== undefined) {
      const value = contextValue(data.context, t);
      const head = el("div", "ac-section__head");
      const text = el("span", "ac-section__value");
      text.append(fmtNode(value.template, { n: value.n }));
      head.append(title, text);
      section.append(head, body);
    } else section.append(title, body);
  }

  if (kind === "raw") {
    for (const text of data.status?.lines ?? []) {
      const line = el("div", "ac-raw__line", text);
      line.dir = "auto";
      body.append(line);
    }
  } else if (kind === "limits") {
    for (const limit of data.status?.limits ?? []) body.append(buildLimitBlock(limit, t));
  } else if (kind === "session") {
    const details = data.status?.details;
    if (details?.account !== undefined) {
      body.append(keyValue(t("agentChatFieldAccount"), details.account));
    }
    if (details?.folder !== undefined) {
      body.append(keyValue(t("agentChatFieldFolder"), shortFolder(details.folder), details.folder));
    }
    if (details?.branch !== undefined) {
      body.append(keyValue(t("agentChatFieldBranch"), details.branch));
    }
    if (details?.model !== undefined) {
      body.append(keyValue(t("agentChatModel"), details.model));
    }
  } else if (kind === "todo") {
    const todos = data.todos ?? [];
    const done = todos.filter((todo) => todo.state === "done").length;
    const collapsed = done > DONE_TODO_CAP && !ctx.expanded("done");
    for (const todo of todos) {
      if (collapsed && todo.state === "done") continue;
      body.append(todoRow(todo, t));
    }
    if (done > DONE_TODO_CAP) {
      const label = collapsed ? fmt(t("agentChatShowDone"), { n: done }) : t("agentChatShowFewer");
      body.append(moreButton("done", label, !collapsed, ctx));
    }
  } else if (kind === "agents") {
    const ordered = orderAgents(data.agents);
    const running = ordered.filter((agent) => agent.state === "running").length;
    const cap = running > AGENT_CAP ? Math.min(running, AGENT_RUNNING_CAP) : AGENT_CAP;
    appendCapped(body, ordered, cap, "agents", ctx, (agent) => agentRow(agent, data, t));
  } else if (kind === "files") {
    appendCapped(body, data.files, FILE_CAP, "files", ctx, (file) => fileRow(file, ctx));
  } else if (kind === "context" && data.context !== undefined) {
    const fill = contextValue(data.context, t).fill;
    if (fill !== undefined) {
      // The value says what is used (or what is left), and the fill is the same number.
      const track = el("div", "ac-meter");
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", String(fill));
      track.setAttribute("aria-label", contextValue(data.context, t).text);
      const bar = el("div", "ac-meter__fill");
      bar.style.inlineSize = `${fill}%`;
      track.append(bar);
      body.append(track);
    }
  }
  return section;
}

export type PanelOptions = {
  t: Translate;
  openFile(path: string): void;
  /** Whether the user hid the panel (remembered). */
  hidden(): boolean;
  setHidden(hidden: boolean): void;
  /** Whether a collapsible section was left open or closed (remembered); undefined = default. */
  sectionOpen?(kind: SectionKind): boolean | undefined;
  setSectionOpen?(kind: SectionKind, open: boolean): void;
};

export type Panel = {
  aside: HTMLElement;
  chips: HTMLElement;
  /** The header's show/hide button. */
  toggle: HTMLButtonElement;
  update(data: PanelData, narrow: boolean): void;
  closePopover(): void;
  /** Bring a section into view: the side panel (shown if it was hidden), or the popover. */
  reveal(kind: SectionKind): void;
};

/** The sections drawn in the pinned top of the panel. */
const PINNED: readonly SectionKind[] = ["context", "limits"];

export function createPanel(options: PanelOptions): Panel {
  const { t } = options;
  const aside = el("aside", "ac-side");
  aside.setAttribute("aria-label", t("agentChatPanelLabel"));
  aside.hidden = true;
  const chips = el("div", "ac-chips");
  chips.hidden = true;
  const popover = el("div", "ac-popover");
  popover.hidden = true;
  popover.setAttribute("role", "group");
  chips.append(popover);
  const toggle = el("button", "ac-iconbutton ac-panel-toggle");
  toggle.type = "button";
  toggle.append(icon(ICONS.panel));
  toggle.hidden = true;

  let data: PanelData = { agents: [], files: [], now: 0 };
  /** What the last full paint was made from: the same again repaints only the clocks. */
  let painted = "";
  let narrow = false;
  /** Section open states chosen in this panel; the stored ones are the fallback. */
  const localOpen = new Map<SectionKind, boolean>();
  const isOpen = (kind: SectionKind): boolean =>
    localOpen.get(kind) ?? options.sectionOpen?.(kind) ?? DEFAULT_OPEN[kind] ?? false;
  const setOpen = (kind: SectionKind, open: boolean): void => {
    localOpen.set(kind, open);
    try {
      options.setSectionOpen?.(kind, open);
    } catch {
      // Only a convenience.
    }
  };
  /** Lists shown in full; kept only for the life of this panel. */
  const shownAll = new Set<ListKind>();
  const lists = {
    expanded: (list: ListKind) => shownAll.has(list),
    toggleList: (list: ListKind) => {
      if (!shownAll.delete(list)) shownAll.add(list);
      update(data, narrow);
    },
  };
  const asideContext: SectionContext = {
    t,
    openFile: (path) => options.openFile(path),
    collapse: {
      open: isOpen,
      toggle: (kind) => {
        setOpen(kind, !isOpen(kind));
        update(data, narrow);
      },
    },
    ...lists,
  };
  const popoverContext: SectionContext = {
    t,
    openFile: (path) => options.openFile(path),
    ...lists,
  };
  let openChip: SectionKind | undefined;
  let outside: ((event: Event) => void) | undefined;

  function closePopover(): void {
    openChip = undefined;
    popover.hidden = true;
    popover.replaceChildren();
    for (const chip of chips.querySelectorAll("button"))
      chip.setAttribute("aria-expanded", "false");
    if (outside !== undefined) document.removeEventListener("pointerdown", outside, true);
    outside = undefined;
  }

  function showPopover(kind: SectionKind): void {
    openChip = kind;
    popover.replaceChildren(buildSection(kind, data, popoverContext));
    popover.hidden = false;
    popover.setAttribute("aria-label", headingOf(kind, data, t));
    for (const chip of chips.querySelectorAll<HTMLButtonElement>("button")) {
      chip.setAttribute("aria-expanded", String(chip.dataset["section"] === kind));
    }
    if (outside === undefined) {
      outside = (event) => {
        if (!chips.contains(event.target as Node | null)) closePopover();
      };
      document.addEventListener("pointerdown", outside, true);
    }
  }

  chips.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && openChip !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      const chip = chips.querySelector<HTMLElement>(`button[data-section="${openChip}"]`);
      closePopover();
      chip?.focus();
    }
  });

  function paintAside(kinds: SectionKind[]): void {
    aside.replaceChildren();
    const pin = el("div", "ac-side__pin");
    const bar = el("div", "ac-side__bar");
    const hide = el("button", "ac-hide-panel");
    hide.type = "button";
    hide.setAttribute("aria-label", t("agentChatHidePanel"));
    hide.title = t("agentChatHidePanel");
    hide.append(icon(ICONS.panel, 14));
    hide.addEventListener("click", () => {
      options.setHidden(true);
      update(data, narrow);
    });
    bar.append(el("span", "ac-spacer"), hide);
    pin.append(bar);
    for (const kind of PINNED) {
      if (kinds.includes(kind)) pin.append(buildSection(kind, data, asideContext));
    }
    const scroll = el("div", "ac-side__scroll");
    if (data.deriving === true) {
      const line = el("p", "ac-deriving", t("agentChatDeriving"));
      line.setAttribute("role", "status");
      scroll.append(line);
    }
    for (const kind of kinds) {
      if (!PINNED.includes(kind)) scroll.append(buildSection(kind, data, asideContext));
    }
    aside.append(pin, scroll);
  }

  /** The sub-agents' clocks, in place: a repaint would take the focus. */
  function tickClocks(): void {
    const byId = new Map(data.agents.map((agent) => [agent.id, agent]));
    for (const row of [
      ...aside.querySelectorAll<HTMLElement>(".ac-agent[data-agent-id]"),
      ...popover.querySelectorAll<HTMLElement>(".ac-agent[data-agent-id]"),
    ]) {
      const agent = byId.get(row.dataset["agentId"] ?? "");
      if (agent === undefined) continue;
      const phrase = agentState(agent, data.now, t);
      row.title = phrase;
      const state = row.querySelector(".ac-agent__state");
      if (state !== null) state.textContent = phrase;
      const time = row.querySelector(".ac-agent__time");
      if (time !== null) time.textContent = agentTime(agent, data.now, t);
    }
  }

  function update(next: PanelData, isNarrow: boolean): void {
    const { now: _now, ...stable } = next;
    const sig = JSON.stringify([
      stable,
      isNarrow,
      options.hidden(),
      COLLAPSIBLE.map(isOpen),
      [...shownAll],
    ]);
    data = next;
    narrow = isNarrow;
    if (sig === painted) {
      tickClocks();
      return;
    }
    painted = sig;
    // What a repaint must give back: the focused control and the scroll positions.
    const active = document.activeElement;
    const focusKey =
      active instanceof HTMLElement && (aside.contains(active) || popover.contains(active))
        ? active.dataset["key"]
        : undefined;
    const asideScroll = aside.querySelector<HTMLElement>(".ac-side__scroll")?.scrollTop ?? 0;
    const popoverScroll = popover.scrollTop;
    const kinds = sectionsOf(data);
    const anything = kinds.length > 0 || data.deriving === true;
    const hidden = options.hidden();

    toggle.hidden = !anything || narrow;
    toggle.setAttribute("aria-pressed", String(!hidden));
    toggle.setAttribute("aria-label", hidden ? t("agentChatShowPanel") : t("agentChatHidePanel"));
    toggle.title = hidden ? t("agentChatShowPanel") : t("agentChatHidePanel");
    toggle.onclick = () => {
      options.setHidden(!options.hidden());
      update(data, narrow);
    };

    aside.hidden = !anything || narrow || hidden;
    if (!aside.hidden) {
      paintAside(kinds);
      const scroll = aside.querySelector<HTMLElement>(".ac-side__scroll");
      if (scroll !== null) scroll.scrollTop = asideScroll;
    } else aside.replaceChildren();

    const keep =
      openChip !== undefined && kinds.includes(openChip) && narrow ? openChip : undefined;
    const chipped = chipKinds(kinds);
    chips.hidden = !narrow || (chipped.length === 0 && keep === undefined);
    for (const old of [...chips.querySelectorAll(":scope > button")]) old.remove();
    if (!chips.hidden) {
      for (const kind of chipped) {
        const chip = chipOf(kind, data, t);
        const button = el("button", "ac-chip");
        button.type = "button";
        button.dataset["section"] = kind;
        button.setAttribute("aria-expanded", "false");
        button.append(
          document.createTextNode(`${chip.name} `),
          el("strong", undefined, chip.value),
        );
        button.addEventListener("click", () => {
          if (openChip === kind) closePopover();
          else showPopover(kind);
        });
        chips.insertBefore(button, popover);
      }
    }
    if (keep !== undefined) {
      showPopover(keep);
      popover.scrollTop = popoverScroll;
    } else closePopover();
    if (focusKey !== undefined) {
      const again = (aside.hidden ? popover : aside).querySelector<HTMLElement>(
        `[data-key="${focusKey}"]`,
      );
      again?.focus();
    }
  }

  function reveal(kind: SectionKind): void {
    if (!sectionsOf(data).includes(kind)) return;
    if (narrow) {
      chips.hidden = false;
      showPopover(kind);
      return;
    }
    // Context and limits are pinned, always in view once the panel is shown.
    if (options.hidden()) options.setHidden(false);
    if (COLLAPSIBLE.includes(kind) && !isOpen(kind)) setOpen(kind, true);
    update(data, narrow);
    const section = aside.querySelector<HTMLElement>(`[data-section="${kind}"]`);
    section?.scrollIntoView?.({ block: "nearest" });
  }

  return { aside, chips, toggle, update, closePopover, reveal };
}
