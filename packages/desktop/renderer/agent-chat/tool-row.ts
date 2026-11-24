// A tool call as the feed draws it: Edit/Write and Bash are cards of their
// own; consecutive read/search style tools collapse into one quiet row; any
// other tool is a compact card. A finished state is a neutral mark, never a
// word like "Passed": the transcript knows whether a tool errored, not
// whether what it ran succeeded. A tool with no recorded result ("ended")
// shows no mark at all. Diffs open when short; output shows its last lines.
import type { ChatToolItem } from "@jarvis/platform";
import { type CodeContext, copyButton } from "./code.js";
import { basename, duration, el, fmt, ICONS, icon } from "./dom.js";

export const DIFF_OPEN_MAX_LINES = 12;
export const OUTPUT_TAIL_LINES = 6;

export type ToolContext = CodeContext & {
  openFile(path: string): void;
  /** Open/closed memory that survives a row being rebuilt. */
  isOpen(key: string, fallback: boolean): boolean;
  setOpen(key: string, open: boolean): void;
};

export type ToolKind = "read" | "edit" | "bash" | "other";

const EDIT = /^(edit|write|multiedit|notebookedit|apply_?patch|str_?replace\w*|create_?file)$/i;
const BASH = /^(bash|shell|exec|exec_command|run_?command|powershell|terminal|run_in_terminal)$/i;
const QUIET =
  /^(read|grep|glob|ls|list\w*|search\w*|find\w*|view|open|fetch|web_?search|web_?fetch|notebookread|read_?file|file_?search|codebase_?search)$/i;

export function toolKind(item: ChatToolItem): ToolKind {
  if (EDIT.test(item.tool) || (item.diff !== undefined && item.diff.length > 0)) return "edit";
  if (BASH.test(item.tool) || (item.command !== undefined && !QUIET.test(item.tool))) return "bash";
  if (QUIET.test(item.tool)) return "read";
  return "other";
}

/** Searching tools, as against reading one file. */
function isSearch(item: ChatToolItem): boolean {
  return /grep|glob|search|find|list|ls|fetch/i.test(item.tool);
}

/** Everything that changes how a tool draws, as one comparable string. */
export function toolSig(item: ChatToolItem): string {
  return [
    item.state,
    item.at,
    item.endAt,
    item.target,
    item.command,
    item.diff?.length,
    item.output?.length,
    item.outputCut,
    item.input?.length,
  ].join("|");
}

export function elapsed(item: ChatToolItem): string | undefined {
  if (item.at === undefined || item.endAt === undefined || item.endAt < item.at) return undefined;
  return duration(item.endAt - item.at);
}

/** ok and failed marks; running spins; ended (unknown outcome) has none. */
function mark(item: ChatToolItem, ctx: ToolContext): HTMLElement | undefined {
  if (item.state === "ended") return undefined;
  const node = el("span", `ac-mark ac-mark--${item.state}`);
  if (item.state === "running") {
    node.append(icon(ICONS.spinner, 12));
    node.title = ctx.t("agentChatToolRunning");
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", ctx.t("agentChatToolRunning"));
  } else if (item.state === "ok") {
    node.append(icon(ICONS.check, 12));
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", ctx.t("agentChatToolOk"));
  } else {
    node.append(icon(ICONS.close, 12));
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", ctx.t("agentChatToolFailed"));
  }
  return node;
}

function timeLabel(item: ChatToolItem): HTMLElement | undefined {
  const text = elapsed(item);
  return text === undefined ? undefined : el("span", "ac-time", text);
}

/** A button that opens and closes `body`, remembered under `key`. */
function toggle(
  ctx: ToolContext,
  key: string,
  fallback: boolean,
  body: HTMLElement,
  label: HTMLElement,
): HTMLButtonElement {
  const button = el("button", "ac-toggle");
  button.type = "button";
  button.append(icon(ICONS.chevron, 12), label);
  const apply = (open: boolean): void => {
    button.setAttribute("aria-expanded", String(open));
    body.hidden = !open;
    button.dataset["open"] = String(open);
  };
  apply(ctx.isOpen(key, fallback));
  button.addEventListener("click", () => {
    const next = body.hidden !== false;
    ctx.setOpen(key, next);
    apply(next);
  });
  return button;
}

function diffBody(item: ChatToolItem): HTMLElement {
  const body = el("div", "ac-diff");
  body.setAttribute("role", "group");
  body.dir = "ltr";
  for (const line of item.diff ?? []) {
    const row = el(
      "div",
      `ac-diff__line ac-diff__line--${line.sign === "+" ? "add" : line.sign === "-" ? "del" : "ctx"}`,
    );
    row.append(el("span", "ac-diff__sign", line.sign), document.createTextNode(line.text));
    body.append(row);
  }
  return body;
}

/** The last lines, the earlier ones in a hidden span until Show all. */
function outputBody(item: ChatToolItem, ctx: ToolContext, key: string): HTMLElement {
  const box = el("div", "ac-output");
  const text = item.output ?? "";
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const pre = el("pre", "ac-output__text");
  pre.dir = "ltr";
  const hiddenCount = Math.max(0, lines.length - OUTPUT_TAIL_LINES);
  if (hiddenCount > 0) {
    const head = el("span", "ac-output__head", `${lines.slice(0, hiddenCount).join("\n")}\n`);
    const open = ctx.isOpen(`${key}:out`, false);
    head.hidden = !open;
    pre.append(head);
    pre.append(document.createTextNode(lines.slice(hiddenCount).join("\n")));
    box.append(pre);
    const button = el("button", "ac-link-button");
    button.type = "button";
    const label = (isOpen: boolean): string =>
      isOpen ? ctx.t("agentChatShowLess") : fmt(ctx.t("agentChatShowAll"), { n: lines.length });
    button.textContent = label(open);
    button.setAttribute("aria-expanded", String(open));
    button.addEventListener("click", () => {
      const next = head.hidden !== false;
      head.hidden = !next;
      ctx.setOpen(`${key}:out`, next);
      button.textContent = label(next);
      button.setAttribute("aria-expanded", String(next));
    });
    box.append(button);
  } else {
    pre.append(document.createTextNode(lines.join("\n")));
    box.append(pre);
  }
  if (item.outputCut === true) box.append(el("p", "ac-output__cut", ctx.t("agentChatOutputCut")));
  return box;
}

function diffCounts(item: ChatToolItem): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of item.diff ?? []) {
    if (line.sign === "+") added++;
    else if (line.sign === "-") removed++;
  }
  return { added, removed };
}

function head(item: ChatToolItem, ctx: ToolContext, target: string | undefined): HTMLElement {
  const bar = el("div", "ac-card__head");
  bar.append(el("strong", "ac-card__name", item.tool));
  if (target !== undefined && target !== "") {
    const node = el("span", "ac-card__target", target);
    node.dir = "auto";
    node.title = target;
    bar.append(node);
  }
  void ctx;
  return bar;
}

function editCard(item: ChatToolItem, ctx: ToolContext): HTMLElement {
  const card = el("div", "ac-card ac-card--edit");
  const path = item.path ?? item.target;
  const bar = head(item, ctx, path === undefined ? undefined : basename(path));
  const { added, removed } = diffCounts(item);
  if (added > 0) bar.append(el("span", "agent-chat__add", `+${added}`));
  if (removed > 0) bar.append(el("span", "agent-chat__del", `−${removed}`));
  bar.append(el("span", "ac-spacer"));
  const state = mark(item, ctx);
  if (state !== undefined) bar.append(state);
  const time = timeLabel(item);
  if (time !== undefined) bar.append(time);
  if (item.path !== undefined && item.path !== "") {
    const open = el("button", "ac-small-button", ctx.t("agentChatOpenFile"));
    open.type = "button";
    open.setAttribute("aria-label", `${ctx.t("agentChatOpenFile")} ${basename(item.path)}`);
    const target = item.path;
    open.addEventListener("click", () => ctx.openFile(target));
    bar.append(open);
  }
  card.append(bar);
  const lines = item.diff?.length ?? 0;
  if (lines > 0) {
    const body = diffBody(item);
    const label = el("span", "ac-toggle__label", fmt(ctx.t("agentChatDiffLines"), { n: lines }));
    bar.prepend(toggle(ctx, `${item.id}:diff`, lines <= DIFF_OPEN_MAX_LINES, body, label));
    card.append(body);
  }
  return card;
}

function commandText(item: ChatToolItem): string {
  return item.command ?? item.target ?? "";
}

function bashCard(item: ChatToolItem, ctx: ToolContext): HTMLElement {
  const card = el("div", "ac-card ac-card--bash");
  const command = commandText(item);
  const firstLine = command.split("\n", 1)[0] ?? "";
  const bar = head(item, ctx, firstLine);
  bar.append(el("span", "ac-spacer"));
  const state = mark(item, ctx);
  if (state !== undefined) bar.append(state);
  const time = timeLabel(item);
  if (time !== undefined) bar.append(time);
  if (command !== "") bar.append(copyButton(ctx, () => command));
  card.append(bar);
  const hasOutput = item.output !== undefined && item.output !== "";
  if (command.includes("\n") || hasOutput) {
    const body = el("div", "ac-card__body");
    if (command.includes("\n")) body.append(el("pre", "ac-cmd", command));
    if (hasOutput) body.append(outputBody(item, ctx, item.id));
    const label = el("span", "ac-toggle__label", ctx.t("agentChatOutput"));
    bar.prepend(toggle(ctx, `${item.id}:body`, true, body, label));
    card.append(body);
  }
  return card;
}

function otherCard(item: ChatToolItem, ctx: ToolContext): HTMLElement {
  const card = el("div", "ac-card ac-card--other");
  const bar = head(item, ctx, item.target ?? item.command);
  bar.append(el("span", "ac-spacer"));
  const state = mark(item, ctx);
  if (state !== undefined) bar.append(state);
  const time = timeLabel(item);
  if (time !== undefined) bar.append(time);
  card.append(bar);
  const hasInput = item.input !== undefined && item.input.length > 0;
  const hasOutput = item.output !== undefined && item.output !== "";
  if (hasInput || hasOutput) {
    const body = el("div", "ac-card__body");
    if (hasInput) {
      const list = el("dl", "ac-pairs");
      for (const pair of item.input ?? []) {
        list.append(el("dt", undefined, pair.key), el("dd", undefined, pair.value));
      }
      body.append(list);
    }
    if (hasOutput) body.append(outputBody(item, ctx, item.id));
    const label = el("span", "ac-toggle__label", ctx.t("agentChatDetails"));
    bar.prepend(toggle(ctx, `${item.id}:body`, false, body, label));
    card.append(body);
  }
  return card;
}

export function buildToolCard(item: ChatToolItem, ctx: ToolContext): HTMLElement {
  const kind = toolKind(item);
  const card =
    kind === "edit"
      ? editCard(item, ctx)
      : kind === "bash"
        ? bashCard(item, ctx)
        : otherCard(item, ctx);
  card.classList.add("agent-chat__row", "ac-row");
  card.dataset["itemId"] = item.id;
  return card;
}

/** Read and search tools in a row, as "Read 2 files, searched once" and a total time. */
export function groupSummary(items: readonly ChatToolItem[], ctx: ToolContext): string {
  const searches = items.filter(isSearch).length;
  const reads = items.length - searches;
  const parts: string[] = [];
  if (reads > 0) {
    parts.push(
      reads === 1 ? ctx.t("agentChatGroupRead1") : fmt(ctx.t("agentChatGroupReadN"), { n: reads }),
    );
  }
  if (searches > 0) {
    parts.push(
      searches === 1
        ? ctx.t("agentChatGroupSearch1")
        : fmt(ctx.t("agentChatGroupSearchN"), { n: searches }),
    );
  }
  return parts.join(", ");
}

export function groupSig(items: readonly ChatToolItem[]): string {
  return items.map(toolSig).join("#");
}

export function buildGroup(items: readonly ChatToolItem[], ctx: ToolContext): HTMLElement {
  const first = items[0];
  const row = el("div", "ac-group agent-chat__row ac-row");
  if (first !== undefined) row.dataset["itemId"] = first.id;
  const list = el("ul", "ac-group__list");
  for (const item of items) {
    const line = el("li", "ac-group__item");
    line.append(el("strong", undefined, item.tool));
    const target = el("span", "ac-card__target", item.target ?? item.command ?? "");
    target.dir = "auto";
    line.append(target);
    const state = mark(item, ctx);
    if (state !== undefined) line.append(state);
    const time = timeLabel(item);
    if (time !== undefined) line.append(time);
    list.append(line);
  }
  const label = el("span", "ac-toggle__label", groupSummary(items, ctx));
  const total = totalTime(items);
  const button = toggle(ctx, `${first?.id ?? ""}:group`, false, list, label);
  button.classList.add("ac-group__toggle");
  if (total !== undefined) button.append(el("span", "ac-time", total));
  const running = items.some((item) => item.state === "running");
  if (running) button.append(icon(ICONS.spinner, 12));
  row.append(button, list);
  return row;
}

function totalTime(items: readonly ChatToolItem[]): string | undefined {
  const starts = items.map((item) => item.at).filter((at): at is number => at !== undefined);
  const ends = items.map((item) => item.endAt).filter((at): at is number => at !== undefined);
  if (starts.length === 0 || ends.length === 0) return undefined;
  const span = Math.max(...ends) - Math.min(...starts);
  return span >= 0 ? duration(span) : undefined;
}
