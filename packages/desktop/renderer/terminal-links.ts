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
 */
export function openTerminalLink(project: string, url: string): void {
  if (openInternally) {
    void window.jarvis.openTab(project, url);
    return;
  }
  void window.jarvis.plansOpenLink(url);
}
