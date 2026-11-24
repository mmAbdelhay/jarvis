// The agent's usage limits and its own status line: a compact strip directly
// under the composer, and the same data in full in the panel's Limits
// section. Everything the agent drew reaches the DOM as text only. The strip
// keeps its nodes between refreshes (one per limit label, one per row), so a
// new number changes text and never the layout.
import type { AgentLimit } from "../../src/agent-status-line.js";
import { el, fmt, type Translate } from "./dom.js";

export type StatusData = {
  lines: readonly string[];
  limits: readonly AgentLimit[];
  stale?: boolean | undefined;
};

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
  root: HTMLElement;
  label: HTMLElement;
  slot: HTMLElement;
  pct: HTMLElement;
  word: HTMLElement;
  resets: HTMLElement;
};

function buildChip(): Chip {
  const root = el("span", "ac-limit");
  root.tabIndex = 0;
  const label = el("span", "ac-limit__label");
  label.dir = "auto";
  const slot = el("span", "ac-limit__slot");
  const pct = el("bdi", "ac-limit__pct");
  const word = el("span", "ac-limit__word");
  const resets = el("span", "ac-limit__resets");
  resets.dir = "auto";
  root.append(label, slot, pct, word, resets);
  return { root, label, slot, pct, word, resets };
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
  node.hidden = text === "";
}

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
    setText(chip.pct, "");
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
  setText(chip.word, percent === undefined ? (limit.detail ?? "") : levelWord(level, t));
  setText(
    chip.resets,
    limit.resets === undefined ? "" : fmt(t("agentChatLimitResets"), { when: limit.resets }),
  );
}

const COLLAPSED_ROWS = 2;

export type StatusStrip = {
  element: HTMLElement;
  update(status: StatusData | undefined): void;
};

export function createStatusStrip(options: { t: Translate }): StatusStrip {
  const { t } = options;
  const element = el("div", "ac-status");
  element.hidden = true;
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", t("agentChatStatusLabel"));
  const limitsRow = el("div", "ac-status__limits");
  const linesBox = el("div", "ac-status__lines");
  const more = el("button", "ac-status__more");
  more.type = "button";
  more.hidden = true;
  element.append(limitsRow, linesBox, more);

  const chips = new Map<string, Chip>();
  const rows: HTMLElement[] = [];
  let expanded = false;
  let lines: readonly string[] = [];

  function paintLines(): void {
    const count = expanded ? lines.length : Math.min(lines.length, COLLAPSED_ROWS);
    while (rows.length < count) {
      const row = el("div", "ac-status__line");
      row.dir = "auto";
      rows.push(row);
      linesBox.append(row);
    }
    while (rows.length > count) rows.pop()?.remove();
    rows.forEach((row, index) => {
      const text = lines[index] ?? "";
      if (row.textContent !== text) row.textContent = text;
      row.title = text;
    });
    more.hidden = lines.length <= COLLAPSED_ROWS;
    more.setAttribute("aria-expanded", String(expanded));
    more.textContent = expanded ? t("agentChatStatusLess") : t("agentChatStatusMore");
  }

  more.addEventListener("click", () => {
    expanded = !expanded;
    paintLines();
  });

  return {
    element,
    update(status) {
      const limits = status?.limits ?? [];
      lines = status?.lines ?? [];
      element.hidden = limits.length === 0 && lines.length === 0;
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
      paintLines();
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
