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

export type SectionContext = {
  t: Translate;
  openFile(path: string): void;
  /** Whether the raw rows were opened, kept across repaints. */
  raw?: { open(): boolean; set(open: boolean): void };
};

export function buildSection(kind: SectionKind, data: PanelData, ctx: SectionContext): HTMLElement {
  const { t } = ctx;
  if (kind === "raw") {
    const box = el("details", "ac-section ac-raw");
    box.dataset["section"] = kind;
    box.open = ctx.raw?.open() === true;
    box.addEventListener("toggle", () => ctx.raw?.set(box.open));
    box.append(el("summary", "ac-raw__summary", headingOf(kind, data, t)));
    for (const text of data.status?.lines ?? []) {
      const line = el("div", "ac-raw__line", text);
      line.dir = "auto";
      box.append(line);
    }
    return box;
  }
  const section = el("section", "ac-section");
  section.dataset["section"] = kind;
  const title = el("h2", "ac-section__title", headingOf(kind, data, t));
  if (kind === "context" && data.context !== undefined) {
    const value = contextValue(data.context, t);
    const head = el("div", "ac-section__head");
    const text = el("span", "ac-section__value");
    text.append(fmtNode(value.template, { n: value.n }));
    head.append(title, text);
    section.append(head);
  } else section.append(title);
  if (kind === "limits") {
    for (const limit of data.status?.limits ?? []) section.append(buildLimitBlock(limit, t));
  } else if (kind === "session") {
    const details = data.status?.details;
    if (details?.account !== undefined) {
      section.append(keyValue(t("agentChatFieldAccount"), details.account));
    }
    if (details?.folder !== undefined) {
      section.append(
        keyValue(t("agentChatFieldFolder"), shortFolder(details.folder), details.folder),
      );
    }
    if (details?.branch !== undefined) {
      section.append(keyValue(t("agentChatFieldBranch"), details.branch));
    }
    if (details?.model !== undefined) {
      section.append(keyValue(t("agentChatModel"), details.model));
    }
  } else if (kind === "todo") {
    for (const todo of data.todos ?? []) {
      const row = el("div", `ac-todo ac-todo--${todo.state}`);
      const mark = icon(
        todo.state === "done"
          ? ICONS.todoDone
          : todo.state === "active"
            ? ICONS.todoActive
            : ICONS.todoOpen,
      );
      row.append(mark);
      const text = el("span", "ac-todo__text", todo.text);
      text.dir = "auto";
      row.append(text);
      row.setAttribute(
        "aria-label",
        `${todo.text}, ${t(todo.state === "done" ? "agentChatTodoDone" : todo.state === "active" ? "agentChatTodoActive" : "agentChatTodoOpen")}`,
      );
      section.append(row);
    }
  } else if (kind === "agents") {
    for (const agent of data.agents) {
      const row = el("div", "ac-agent");
      row.dataset["agentId"] = agent.id;
      const name = el("span", "ac-agent__name", agent.label);
      name.dir = "auto";
      row.append(
        name,
        el(
          "span",
          `ac-agent__state ac-agent__state--${agent.state}`,
          agentState(agent, data.now, t),
        ),
      );
      section.append(row);
    }
  } else if (kind === "files") {
    for (const file of data.files) {
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
        el("span", "ac-spacer"),
      );
      if (file.added !== undefined && file.added > 0)
        button.append(count("agent-chat__add", `+${file.added}`));
      if (file.removed !== undefined && file.removed > 0) {
        button.append(count("agent-chat__del", `\u2212${file.removed}`));
      }
      button.addEventListener("click", () => ctx.openFile(file.path));
      section.append(button);
    }
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
      section.append(track);
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
  let rawOpen = false;
  const sectionOptions: SectionContext = {
    t,
    openFile: (path) => options.openFile(path),
    raw: {
      open: () => rawOpen,
      set: (open) => {
        rawOpen = open;
      },
    },
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
    popover.replaceChildren(buildSection(kind, data, sectionOptions));
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
    if (data.deriving === true) {
      const line = el("p", "ac-deriving", t("agentChatDeriving"));
      line.setAttribute("role", "status");
      aside.append(line);
    }
    for (const kind of kinds) aside.append(buildSection(kind, data, sectionOptions));
    aside.append(el("span", "ac-spacer"));
    const hide = el("button", "ac-hide-panel", t("agentChatHidePanel"));
    hide.type = "button";
    hide.addEventListener("click", () => {
      options.setHidden(true);
      update(data, narrow);
    });
    aside.append(hide);
  }

  /** The running sub-agents' clocks, in place: a repaint would take the focus. */
  function tickClocks(): void {
    for (const agent of data.agents) {
      const node = document.querySelectorAll<HTMLElement>(".ac-agent[data-agent-id]");
      for (const row of node) {
        if (row.dataset["agentId"] !== agent.id || !(aside.contains(row) || popover.contains(row)))
          continue;
        const state = row.querySelector(".ac-agent__state");
        if (state !== null) state.textContent = agentState(agent, data.now, t);
      }
    }
  }

  function update(next: PanelData, isNarrow: boolean): void {
    const { now: _now, ...stable } = next;
    const sig = JSON.stringify([stable, isNarrow, options.hidden()]);
    data = next;
    narrow = isNarrow;
    if (sig === painted) {
      tickClocks();
      return;
    }
    painted = sig;
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
    if (!aside.hidden) paintAside(kinds);
    else aside.replaceChildren();

    const keep =
      openChip !== undefined && kinds.includes(openChip) && narrow ? openChip : undefined;
    const chipped = chipKinds(kinds);
    chips.hidden = !narrow || (chipped.length === 0 && keep === undefined);
    for (const old of [...chips.querySelectorAll("button")]) old.remove();
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
    if (keep !== undefined) showPopover(keep);
    else closePopover();
  }

  function reveal(kind: SectionKind): void {
    if (!sectionsOf(data).includes(kind)) return;
    if (narrow) {
      chips.hidden = false;
      showPopover(kind);
      return;
    }
    if (options.hidden()) {
      options.setHidden(false);
      update(data, narrow);
    }
    const section = aside.querySelector<HTMLElement>(`[data-section="${kind}"]`);
    section?.scrollIntoView?.({ block: "nearest" });
  }

  return { aside, chips, toggle, update, closePopover, reveal };
}
