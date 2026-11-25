// Where a URL clicked in a terminal goes. Both terminals (the Workspace's
// terminal tabs and the agent Session view) call this, so one switch,
// `browser.openTerminalLinksInternally`, decides for both.
//
// The flag is mirrored here the same way workspace.ts mirrors the rest of
// the `browser:` section: set at load and again after every Settings save
// (app.ts), so a change applies to the next click without a restart.

let openInternally = true;

export function setTerminalLinksInternal(value: boolean): void {
  openInternally = value;
}

/**
 * On (the default): a Workspace tab in `project`, which puts the URL through
 * normalizeInput and the app's navigation rules. Off: the system browser,
 * via plans:openLink, whose main-side gate allows http, https and mailto only
 * and drops anything else rather than handing it to the OS.
 *
 * A click must never silently do nothing: no project to open a tab in, or an
 * openTab that throws or rejects, falls back to the system browser.
 */
export function openTerminalLink(project: string | undefined, url: string): void {
  const external = (): void => {
    try {
      void window.jarvis.plansOpenLink(url).catch(() => {});
    } catch {
      // Nothing further to fall back to.
    }
  };
  if (!openInternally || project === undefined || project === "") {
    external();
    return;
  }
  try {
    void window.jarvis.openTab(project, url).then(showMainFromPopout).catch(external);
  } catch {
    external();
  }
}

/** A pop-out shows only its own tab, so the tab a link opened is in the main
 *  window, out of sight. Main ignores this from any window but a pop-out, so
 *  it is called unconditionally and never steals focus from the main window. */
function showMainFromPopout(): void {
  try {
    void window.jarvis.popoutShowMain?.()?.catch(() => {});
  } catch {
    // Best effort: the tab is open either way.
  }
}
