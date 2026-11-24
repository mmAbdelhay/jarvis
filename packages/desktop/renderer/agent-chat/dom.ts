// Small DOM helpers shared by the chat's parts. Text only ever reaches the DOM
// through textContent and text nodes; icons are built with createElementNS.
import type { MessageKey } from "../../src/messages.js";

export type Translate = (key: MessageKey) => string;

const SVG_NS = "http://www.w3.org/2000/svg";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A decorative 16px icon from stroke paths (viewBox 0 0 16 16). */
export function icon(paths: readonly string[], size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export const ICONS = {
  chevron: ["M6 3l5 5-5 5"],
  plus: ["M8 2v12M2 8h12"],
  close: ["M3 3l10 10M13 3L3 13"],
  search: ["M7 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M10 10l4 4"],
  files: ["M2.5 3.5h11v9h-11z", "M6 3.5v9"],
  panel: ["M2.5 3.5h11v9h-11z", "M10 3.5v9"],
  up: ["M8 13V3M4 7l4-4 4 4"],
  down: ["M8 3v10M4 9l4 4 4-4"],
  spinner: ["M8 2a6 6 0 1 1-6 6"],
  check: ["M3.5 8.5l3 3 6-7"],
  todoDone: ["M2.5 2.5h11v11h-11z", "M5 8l2 2 4-4"],
  todoActive: ["M2.5 2.5h11v11h-11z", "M5 8h6"],
  todoOpen: ["M2.5 2.5h11v11h-11z"],
} as const;

/** `{n}` style placeholders from a message. */
export function fmt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

/** 4s, 1m 12s, 2h 05m. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}

export function dirname(path: string): string {
  const cut = path.replace(/[\\/][^\\/]*$/, "");
  return cut === path ? "" : cut;
}

/** A quoted path an agent reads as one token. */
export function quotePath(path: string): string {
  return /[\s"'`$]/.test(path) ? `"${path.replaceAll('"', "")}"` : path;
}

/** 38000 as "38k", 1234 as "1.2k". */
export function tokens(used: number): string {
  if (used < 1000) return String(used);
  const value = used >= 100_000 ? String(Math.round(used / 1000)) : (used / 1000).toFixed(1);
  return `${value.replace(/\.0$/, "")}k`;
}
