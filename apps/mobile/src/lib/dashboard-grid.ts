// Wide layout (2026-09-28 spec §3, Dashboard): how many columns the
// Dashboard's panels take and which panel sits in which column. Pure so the
// breakpoints are unit tested; `DashboardPanels.tsx` renders the result.
// Only consulted on the wide layout class — a phone (including a landscape
// phone wider than 744) always keeps the single stacked column.
import { WIDE_MIN_WIDTH } from "./layout-class";

export type DashboardColumns = 1 | 2 | 3;

export type DashboardPanel = "system" | "sessions" | "projects";

// The desktop's System | core | Providers row fits three panels side by side
// only when each still gets ~340px inside the 1180 measure.
const THREE_COLUMNS_FROM_WIDTH = 1100;

export function dashboardColumns(width: number): DashboardColumns {
  if (width >= THREE_COLUMNS_FROM_WIDTH) return 3;
  if (width >= WIDE_MIN_WIDTH) return 2;
  return 1;
}

/** The panels per column, in reading order (RTL mirroring is the row's job). */
export function dashboardGrid(columns: DashboardColumns): DashboardPanel[][] {
  if (columns === 3) return [["system"], ["sessions"], ["projects"]];
  if (columns === 2) return [["system", "sessions"], ["projects"]];
  return [["system", "sessions", "projects"]];
}
