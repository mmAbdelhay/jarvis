// The WideShell top bar's logic (2026-09-28 wide layout, Task 1), kept out
// of `WideShell.tsx` so it is unit testable without a renderer. Mirrors the
// desktop topbar (packages/desktop/renderer): brand, nav, metrics readout,
// "N running" pill, connection pill, clock.

import type { SessionState, SystemMetrics } from "@jarvis/core";
import type { ConnectionPillModel } from "./connection-pill";
import { connectionPillModel } from "./connection-pill";
import type { ConnectionView } from "./connection-store";
import { formatPercent } from "./format";
import type { Language } from "./i18n";
import { t } from "./i18n";

export type WideNavKey =
  | "dashboard"
  | "sessions"
  | "workspace"
  | "changes"
  | "history"
  | "voice"
  | "settings";

export type WideNavItem = { key: WideNavKey; label: string; href: string; glyph: string };

const NAV_ORDER: readonly WideNavKey[] = [
  "dashboard",
  "sessions",
  "workspace",
  "changes",
  "history",
  "voice",
  "settings",
];

/** Each section's mark in the sidebar, alone when the sidebar is a rail. */
const NAV_GLYPHS: Record<WideNavKey, string> = {
  dashboard: "⌂",
  sessions: "≡",
  workspace: "⊞",
  changes: "±",
  history: "◷",
  voice: "◉",
  settings: "⚙",
};

/** The nav items in the desktop's order. RTL mirroring is the component's
 *  job (it lays the bar out right-to-left), not this list's. */
export function wideNavItems(language: Language): WideNavItem[] {
  return NAV_ORDER.map((key) => ({
    key,
    label: t(language, `nav.${key}`),
    href: `/${key}`,
    glyph: NAV_GLYPHS[key],
  }));
}

// Detail routes belong to the section they are opened from.
const SECTION_OF: Record<string, WideNavKey> = {
  dashboard: "dashboard",
  history: "history",
  transcript: "history",
  sessions: "sessions",
  session: "sessions",
  workspace: "workspace",
  terminal: "workspace",
  docker: "workspace",
  api: "workspace",
  changes: "changes",
  sidecars: "workspace",
  "sidecar-view": "workspace",
  voice: "voice",
  settings: "settings",
};

export function activeNavKey(pathname: string): WideNavKey | undefined {
  const path = pathname.split(/[?#]/, 1)[0] ?? "";
  const first = path.split("/").find((segment) => segment.length > 0);
  if (first === undefined || !Object.hasOwn(SECTION_OF, first)) return undefined;
  return SECTION_OF[first];
}

// The desktop's LIVE_STATES (renderer/app.ts): what the "N running" pill counts.
const LIVE_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  "starting",
  "running",
  "waiting",
]);

export function runningCountOf(sessions: readonly { state: SessionState }[]): number {
  return sessions.filter((session) => LIVE_STATES.has(session.state)).length;
}

export type TopBarReadout = { cpu: string; ram: string; disk: string; net: string };

export type TopBarModel = {
  showMetrics: boolean;
  // Compact widths (744–899) can't fit the full connection text beside the
  // nav; the dot (with the text as its accessibility label) stays.
  showPillLabel: boolean;
  readout: TopBarReadout;
  running: { count: number; idle: boolean };
  pill: ConnectionPillModel;
  /** The paired laptop's display name beside the connection pill (the
   *  phone shows it in the Dashboard header), truncated to its slot. */
  laptopName: string | undefined;
  laptopNameMaxWidth: number;
};

function ratioPercent(used: number, total: number): string {
  return total > 0 ? formatPercent((used / total) * 100) : "--%";
}

function mbps(value: number): string {
  return (Number.isFinite(value) && value > 0 ? value : 0).toFixed(1);
}

function readoutOf(metrics: SystemMetrics | undefined): TopBarReadout {
  if (metrics === undefined) {
    return { cpu: "--%", ram: "--%", disk: "--%", net: "↓0.0 ↑0.0 Mbps" };
  }
  return {
    cpu: formatPercent(metrics.cpuPercent),
    ram: ratioPercent(metrics.memoryUsedBytes, metrics.memoryTotalBytes),
    disk: ratioPercent(metrics.diskUsedBytes, metrics.diskTotalBytes),
    net: `↓${mbps(metrics.networkDownMbps)} ↑${mbps(metrics.networkUpMbps)} Mbps`,
  };
}

export function topBarModel(input: {
  metrics?: SystemMetrics;
  runningCount: number;
  connection: ConnectionView;
  compact: boolean;
  laptopName?: string;
}): TopBarModel {
  const name = input.laptopName?.trim();
  return {
    showMetrics: !input.compact,
    showPillLabel: !input.compact,
    readout: readoutOf(input.metrics),
    running: { count: input.runningCount, idle: input.runningCount === 0 },
    pill: connectionPillModel(input.connection),
    laptopName: name === undefined || name.length === 0 ? undefined : name,
    laptopNameMaxWidth: input.compact ? 96 : 180,
  };
}

/** The laptop name beside the connection pill: the record's display name,
 *  else the machine label of the certificate name a system-trust pairing
 *  dials (`studio` of `studio.tail1.ts.net`; no current pairing flow
 *  stores a display name). A pinned IP pairing has neither. */
export function shellLaptopName(
  record: { laptopName?: string; name?: string } | undefined,
): string | undefined {
  const display = record?.laptopName?.trim();
  if (display !== undefined && display.length > 0) return display;
  const label = record?.name?.split(".")[0]?.trim();
  return label === undefined || label.length === 0 ? undefined : label;
}

/** The desktop clock: 24-hour HH:MM, Latin digits in both languages. */
export function clockText(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
