
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
export type ViewName = "dashboard" | "changes" | "session" | "workspace" | "settings";

const VIEWS: Record<ViewName, string> = {
  dashboard: "view-dashboard",
  changes: "view-changes",
  session: "view-session",
  workspace: "view-workspace",
  settings: "view-settings",
};

const NAV: Record<ViewName, string> = {
  dashboard: "nav-dashboard",
  changes: "nav-changes",
  session: "nav-session",
  workspace: "nav-workspace",
  settings: "nav-settings",
};

let view: ViewName = "dashboard";

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
            ".main:not(.main--changes):not(.main--session):not(.main--workspace):not(.main--settings)",
          )
        : null);
    if (element instanceof HTMLElement) element.hidden = candidate !== name;
  }

  for (const [candidate, id] of Object.entries(NAV) as [ViewName, string][]) {
    document.getElementById(id)?.classList.toggle("nav-btn--on", candidate === name);
  }

  syncHostedView();
}

function syncHostedView(): void {
  // Optional-chained: several renderer test harnesses run with no bridge at
  // all, and a route change must not throw there.
  void window.jarvis?.setWorkspaceVisible?.(view === "workspace");
}
