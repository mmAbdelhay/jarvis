// The agent's usage limits and what its status line says about the session:
// one quiet row directly under the composer, and the same data in full in the
// panel. Everything the agent drew reaches the DOM as text only. The row keeps
// its nodes between refreshes (one per limit label), so a new number changes
// text and never the layout.
import type { AgentLimit, AgentStatusDetails } from "../../src/agent-status-line.js";
import { basename, el, fmt, tokens, type Translate } from "./dom.js";

export type StatusData = {
  lines: readonly string[];
  limits: readonly AgentLimit[];
  details?: AgentStatusDetails | undefined;
  stale?: boolean | undefined;
};

/** The context as far as it is known: the status line's used percent comes first. */
export type ContextInfo = { used?: number; usedPercent?: number; leftPercent?: number };

export function contextOf(view: {
  context?: { used: number; leftPercent?: number } | undefined;
  status?: StatusData | undefined;
}): ContextInfo | undefined {
  const percent = view.status?.details?.context?.usedPercent;
  if (percent !== undefined) return { usedPercent: percent };
  if (view.context === undefined) return undefined;
  return {
    used: view.context.used,
    ...(view.context.leftPercent === undefined ? {} : { leftPercent: view.context.leftPercent }),
  };
}

/** "6% used", "62% left" or "38k tokens used", and how full the bar is (none for tokens). */
export function contextValue(
  info: ContextInfo,
  t: Translate,
): { text: string; template: string; n: string; fill?: number } {
  if (info.usedPercent !== undefined) {
    const n = `${shown(info.usedPercent)}%`;
    return {
      template: t("agentChatValueUsed"),
      n,
      text: fmt(t("agentChatValueUsed"), { n }),
      fill: shown(info.usedPercent),
    };
  }
  if (info.leftPercent !== undefined) {
    const n = `${info.leftPercent}%`;
    return {
      template: t("agentChatValueLeft"),
      n,
      text: fmt(t("agentChatValueLeft"), { n }),
      fill: shown(info.leftPercent),
    };
  }
  const n = tokens(info.used ?? 0);
  return {
    template: t("agentChatValueTokens"),
    n,
    text: fmt(t("agentChatValueTokens"), { n }),
  };
}

export type Level = "ok" | "warn" | "danger";

/** Warning from 80% used, danger from 95%. */
export function levelOf(percent: number | undefined): Level {
  if (percent === undefined) return "ok";
  return percent >= 95 ? "danger" : percent >= 80 ? "warn" : "ok";
}

const shown = (percent: number): number => Math.round(Math.min(100, Math.max(0, percent)));

/** "Session 13% used, resets 04:20": the tooltip and the spoken form. */
export function limitSummary(limit: AgentLimit, t: Translate): string {
  const parts: string[] = [];
  if (limit.usedPercent !== undefined) {
    parts.push(`${limit.label} ${fmt(t("agentChatLimitUsed"), { n: shown(limit.usedPercent) })}`);
  } else parts.push(limit.label);
  if (limit.detail !== undefined) parts.push(limit.detail);
  if (limit.resets !== undefined) {
    parts.push(fmt(t("agentChatLimitResets"), { when: limit.resets }));
  }
  return parts.join(", ");
}

/** The words that say the level, so colour is never the only signal. */
function levelWord(level: Level, t: Translate): string {
  return level === "danger"
    ? t("agentChatLimitAlmostOut")
    : level === "warn"
      ? t("agentChatLimitHigh")
      : "";
}

function meter(percent: number, t: Translate, wide: boolean): HTMLElement {
  const value = shown(percent);
  const track = el("span", wide ? "ac-meter ac-meter--wide" : "ac-meter ac-meter--mini");
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", String(value));
  track.setAttribute("aria-label", fmt(t("agentChatLimitUsed"), { n: value }));
  const fill = el("span", "ac-meter__fill");
  fill.style.inlineSize = `${value}%`;
  track.append(fill);
  return track;
}

type Chip = {
  root: HTMLButtonElement;
  label: HTMLElement;
  slot: HTMLElement;
  pct: HTMLElement;
  word: HTMLElement;
  resets: HTMLElement;
};

function buildChip(): Chip {
  const root = el("button", "ac-limit");
  root.type = "button";
  const label = el("span", "ac-limit__label");
  label.dir = "auto";
  const slot = el("span", "ac-limit__slot");
  const pct = el("bdi", "ac-limit__pct");
  const word = el("span", "ac-sr-only");
  const resets = el("span", "ac-limit__resets");
  resets.dir = "auto";
  root.append(label, slot, pct, word, resets);
  return { root, label, slot, pct, word, resets };
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
  node.hidden = text === "";
}

/** A limit's reset time is shown only once it matters: from 80% used. */
function paintChip(chip: Chip, limit: AgentLimit, t: Translate): void {
  const level = levelOf(limit.usedPercent);
  const summary = limitSummary(limit, t);
  chip.root.dataset["level"] = level;
  chip.root.title = summary;
  chip.root.setAttribute("aria-label", summary);
  if (chip.label.textContent !== limit.label) chip.label.textContent = limit.label;
  const percent = limit.usedPercent;
  chip.slot.hidden = percent === undefined;
  if (percent === undefined) {
    setText(chip.pct, limit.detail ?? "");
  } else {
    const next = meter(percent, t, false);
    const old = chip.slot.firstElementChild;
    if (old === null) chip.slot.append(next);
    else {
      old.setAttribute("aria-valuenow", next.getAttribute("aria-valuenow") ?? "0");
      old.setAttribute("aria-label", next.getAttribute("aria-label") ?? "");
      const fill = old.firstElementChild as HTMLElement | null;
      if (fill !== null) fill.style.inlineSize = `${shown(percent)}%`;
    }
    setText(chip.pct, `${shown(percent)}%`);
  }
  setText(chip.word, levelWord(level, t));
  setText(
    chip.resets,
    level === "ok" || limit.resets === undefined
      ? ""
      : fmt(t("agentChatLimitResets"), { when: limit.resets }),
  );
}

/** "someone@example.com" is named "someone"; any other account as it was written. */
function shortAccount(account: string): string {
  const at = account.indexOf("@");
  return at > 0 ? account.slice(0, at) : account;
}

/** The left of the row: the account, then the branch (the folder only without one). */
export function whoOf(details: AgentStatusDetails | undefined): { text: string; title: string } {
  const parts: string[] = [];
  if (details?.account !== undefined) parts.push(shortAccount(details.account));
  if (details?.branch !== undefined) parts.push(details.branch);
  else if (details?.folder !== undefined) parts.push(basename(details.folder));
  const full = [details?.account, details?.folder, details?.branch].filter(
    (part): part is string => part !== undefined,
  );
  return { text: parts.join(" · "), title: full.join(" · ") };
}

export type StatusStrip = {
  element: HTMLElement;
  update(status: StatusData | undefined): void;
};

/** One row: who on the left, the limits on the right. A limit opens the panel. */
export function createStatusStrip(options: {
  t: Translate;
  /** A limit was clicked or entered: show the panel's Usage limits. */
  open(): void;
  /** Escape on a limit: close what it opened. */
  close(): void;
}): StatusStrip {
  const { t } = options;
  const element = el("div", "ac-status");
  element.hidden = true;
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", t("agentChatStatusLabel"));
  const who = el("span", "ac-status__who");
  who.dir = "auto";
  const limitsRow = el("span", "ac-status__limits");
  element.append(who, limitsRow);
  element.addEventListener("click", (event) => {
    if ((event.target as Element | null)?.closest(".ac-limit") !== null) options.open();
  });
  element.addEventListener("keydown", (event) => {
    if (event.key === "Escape") options.close();
  });

  const chips = new Map<string, Chip>();

  return {
    element,
    update(status) {
      const limits = status?.limits ?? [];
      const left = whoOf(status?.details);
      setText(who, left.text);
      who.title = left.title;
      if (status?.stale === true) element.dataset["stale"] = "true";
      else delete element.dataset["stale"];
      const wanted = new Set<string>();
      let previous: Element | null = null;
      for (const limit of limits) {
        const key = limit.label.toLowerCase();
        if (wanted.has(key)) continue;
        wanted.add(key);
        let chip = chips.get(key);
        if (chip === undefined) {
          chip = buildChip();
          chips.set(key, chip);
        }
        paintChip(chip, limit, t);
        // Only a node out of place is moved; a node in place is never touched.
        const expectedAt: Element | null =
          previous === null ? limitsRow.firstElementChild : previous.nextElementSibling;
        if (expectedAt !== chip.root) limitsRow.insertBefore(chip.root, expectedAt);
        previous = chip.root;
      }
      for (const [key, chip] of chips) {
        if (!wanted.has(key)) {
          chip.root.remove();
          chips.delete(key);
        }
      }
      limitsRow.hidden = wanted.size === 0;
      element.hidden = wanted.size === 0 && left.text === "";
    },
  };
}

/** One limit in full, for the panel: label and percent, the meter, the reset. */
export function buildLimitBlock(limit: AgentLimit, t: Translate): HTMLElement {
  const level = levelOf(limit.usedPercent);
  const block = el("div", "ac-limit-full");
  block.dataset["level"] = level;
  const head = el("div", "ac-limit-full__head");
  const label = el("span", "ac-limit-full__label", limit.label);
  label.dir = "auto";
  head.append(label);
  if (limit.usedPercent !== undefined) {
    head.append(
      el("span", "ac-spacer"),
      el(
        "bdi",
        "ac-limit-full__pct",
        fmt(t("agentChatLimitUsed"), { n: shown(limit.usedPercent) }),
      ),
    );
  }
  block.append(head);
  if (limit.usedPercent !== undefined) block.append(meter(limit.usedPercent, t, true));
  const notes = [
    levelWord(level, t),
    limit.detail,
    limit.resets === undefined ? undefined : fmt(t("agentChatLimitResets"), { when: limit.resets }),
  ].filter((part): part is string => part !== undefined && part !== "");
  if (notes.length > 0) {
    const note = el("div", "ac-limit-full__note", notes.join(" · "));
    note.dir = "auto";
    block.append(note);
  }
  return block;
}
