/**
 * Route switching for the whole window, and — the part that matters — the
 * single place that tells the main process whether the hosted browser view
 * may be on screen.
 *
 * A WebContentsView is a native child of the window, painted above the
 * renderer and positioned in window pixels. Nothing about CSS reaches it:
 * hiding #view-workspace leaves the page floating over the dashboard, the
 * Changes view and every overlay. So the visibility call lives *inside*
 * showView rather than beside its call sites, where the next route added
 * would forget it.
 */
export type ViewName =
  | "dashboard"
  | "changes"
  | "reviews"
  | "session"
  | "workspace"
  | "office"
  | "settings";

const VIEWS: Record<ViewName, string> = {
  dashboard: "view-dashboard",
  changes: "view-changes",
  reviews: "view-reviews",
  session: "view-session",
  workspace: "view-workspace",
  office: "view-office",
  settings: "view-settings",
};

const NAV: Record<ViewName, string> = {
  dashboard: "nav-dashboard",
  changes: "nav-changes",
  reviews: "nav-reviews",
  session: "nav-session",
  // The Office is reached from the Workspace button's menu, so Workspace
  // stays highlighted while it is on screen.
  workspace: "nav-workspace",
  office: "nav-workspace",
  settings: "nav-settings",
};

let view: ViewName = "dashboard";

const viewListeners = new Set<(name: ViewName) => void>();

/** Runs `listener` after every route change. Returns its removal. */
export function onViewChange(listener: (name: ViewName) => void): () => void {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
}

export function currentView(): ViewName {
  return view;
}

export function showView(name: ViewName): void {
  view = name;

  for (const [candidate, id] of Object.entries(VIEWS) as [ViewName, string][]) {
    // The dashboard's fallback selector is kept from the original showView:
    // the smallest test harnesses lay down a .main without the id.
    const element =
      document.getElementById(id) ??
      (candidate === "dashboard"
        ? document.querySelector(
            ".main:not(.main--changes):not(.main--reviews):not(.main--session):not(.main--workspace):not(.main--office):not(.main--settings)",
          )
        : null);
    if (element instanceof HTMLElement) element.hidden = candidate !== name;
  }

  // Two routes may share one nav button (Workspace and Office), so a button
  // is on when any route that names it is the current one.
  const on = new Set<string>();
  for (const [candidate, id] of Object.entries(NAV) as [ViewName, string][]) {
    if (candidate === name) on.add(id);
  }
  for (const id of new Set(Object.values(NAV))) {
    document.getElementById(id)?.classList.toggle("nav-btn--on", on.has(id));
  }

  syncHostedView();
  for (const listener of [...viewListeners]) {
    try {
      listener(name);
    } catch {
      // A listener's failure must not undo the route change.
    }
  }
}

/** Set while another tailnet machine covers the window (machine-switcher.ts):
 *  its view sits over the whole area below the topbar, so a workspace page
 *  must not show through whatever route is current. */
let machineShown = false;

export function setMachineShown(shown: boolean): void {
  machineShown = shown;
  syncHostedView();
}

/** Set while the Workspace button's menu is open: a native page would paint
 *  over its lower rows, so it stays off screen until the menu closes. */
let workspaceMenuOpen = false;

export function setWorkspaceMenuOpen(open: boolean): void {
  workspaceMenuOpen = open;
  syncHostedView();
}

export function syncHostedView(): void {
  // Optional-chained: several renderer test harnesses run with no bridge at
  // all, and a route change must not throw there.
  const historyOpen = document.getElementById("history-overlay")?.hasAttribute("hidden") === false;
  void window.jarvis?.setWorkspaceVisible?.(
    view === "workspace" && !historyOpen && !machineShown && !workspaceMenuOpen,
  );
}
