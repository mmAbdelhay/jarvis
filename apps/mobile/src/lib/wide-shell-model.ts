// The WideShell sidebar's logic, kept out of `WideShell.tsx` so it is unit
// testable without a renderer: the nav list, which section is active, full
// sidebar or icon rail, the waiting badge and the capacity card.

import type { SessionState } from "@jarvis/core";
import { type CapacityCard, capacityTone } from "./home-capacity";
import type { Language } from "./i18n";
import { t } from "./i18n";
import type { IconName } from "./icon-paths";

export type WideNavKey =
  | "dashboard"
  | "sessions"
  | "workspace"
  | "changes"
  | "history"
  | "voice"
  | "settings";

export type WideNavItem = { key: WideNavKey; label: string; href: string; icon: IconName };

const NAV_ORDER: readonly WideNavKey[] = [
  "dashboard",
  "sessions",
  "workspace",
  "changes",
  "history",
  "voice",
  "settings",
];

/** Each section's icon: drawn alone in the rail, not drawn in the full
 *  sidebar (the mockup's items are text only). */
const NAV_ICONS: Record<WideNavKey, IconName> = {
  dashboard: "home",
  sessions: "sessions",
  workspace: "workspace",
  changes: "changes",
  history: "history",
  voice: "mic",
  settings: "settings",
};

/** The nav items in the desktop's order. RTL mirroring is the component's
 *  job (it lays the bar out right-to-left), not this list's. */
export function wideNavItems(language: Language): WideNavItem[] {
  return NAV_ORDER.map((key) => ({
    key,
    label: t(language, `nav.${key}`),
    href: `/${key}`,
    icon: NAV_ICONS[key],
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

/** Sessions waiting on the user, for the sidebar badge. Sessions found on
 *  disk (origin "external") are not Jarvis's and are not counted. */
export function waitingCountOf(
  sessions: readonly { state: SessionState; origin?: string }[],
): number {
  return sessions.filter((session) => session.state === "waiting" && session.origin !== "external")
    .length;
}

/** The sidebar is an icon rail when the window is compact and always in the
 *  Workspace section (the terminal wants the width). */
export function sidebarMode(input: {
  compact: boolean;
  section: WideNavKey | undefined;
}): "full" | "rail" {
  return input.compact || input.section === "workspace" ? "rail" : "full";
}

/** The number beside a nav item: only Sessions, only above zero. */
export function navBadge(key: WideNavKey, waitingCount: number): number | undefined {
  return key === "sessions" && waitingCount > 0 ? waitingCount : undefined;
}

/** The card above Settings in the full sidebar: the CAPACITY card on every
 *  section but Home (whose tiles show capacity), once capacity is known. */
export function sidebarCard(
  section: WideNavKey | undefined,
  capacity: readonly CapacityCard[],
): "capacity" | undefined {
  return section !== "dashboard" && capacity.length > 0 ? "capacity" : undefined;
}

export type CapacityRow = {
  id: string;
  label: string;
  /** What is left, 0-100. */
  percent: number;
  tone: ReturnType<typeof capacityTone>;
};

const WINDOW_KEYS = {
  "5h": "home.window5h",
  month: "home.windowMonth",
  window: "home.windowOther",
} as const;

/** One row per account: "Claude 5h", what is left, and the bar's tone. */
export function capacityRows(capacity: readonly CapacityCard[], language: Language): CapacityRow[] {
  return capacity.map((card) => ({
    id: card.id,
    label: `${card.id} ${t(language, WINDOW_KEYS[card.window])}`,
    percent: card.left,
    tone: capacityTone(card),
  }));
}
