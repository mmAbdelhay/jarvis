// Every width rule of the wide (browser and tablet) layout in one table, so
// the screens read the same numbers and the numbers are unit tested.
// "Content" is the window width minus the sidebar (or rail) beside it.

export const SIDEBAR_FULL_WIDTH = 240;
export const SIDEBAR_RAIL_WIDTH = 64;

/** The width of the routed content beside the sidebar or rail. */
export function contentWidth(windowWidth: number, sidebar: "full" | "rail"): number {
  return windowWidth - (sidebar === "full" ? SIDEBAR_FULL_WIDTH : SIDEBAR_RAIL_WIDTH);
}

/** Home: four tiles per row, otherwise two. */
export function homeTileColumns(content: number): 2 | 4 {
  return content >= 1000 ? 4 : 2;
}

/** Home: Active and Projects side by side (flex 3/2), otherwise stacked. */
export function homeSideBySide(content: number): boolean {
  return content >= 780;
}

export function sessionsListWidth(content: number): 340 | 400 {
  return content >= 1100 ? 400 : 340;
}

export function historyListWidth(content: number): 380 | 460 {
  return content >= 1100 ? 460 : 380;
}

export function changesLeftWidth(content: number): 360 | 400 {
  return content >= 1100 ? 400 : 360;
}

/** Changes: one column, with the diff under the files. */
export function changesOneColumn(content: number): boolean {
  return content < 900;
}

/** Workspace: the Files aside (otherwise the header Files button). */
export function workspaceShowsFilesAside(content: number): boolean {
  return content >= 900;
}

/** Workspace: the Plan dock (otherwise PlanStrip and PlanSheet). */
export function workspaceShowsPlanDock(content: number): boolean {
  return content >= 1100;
}

/** Settings: the cards sit side by side. */
export function settingsSideBySide(content: number): boolean {
  return content >= 820;
}
