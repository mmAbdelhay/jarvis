export type TabId = string;

/** One browser tab. `project` is fixed at open time: it decides the
 *  session partition, so moving a tab between projects would mean moving it
 *  between cookie jars — a different tab, not the same one relabelled. */
/** "web" is an ordinary page — address bar, back/forward, the page's own
 *  title all apply. "editor" (code-server) and "database" (DbGate) are
 *  hosted apps: the address bar and history controls are meaningless for
 *  them (nobody navigates a code editor or a SQL client like a webpage)
 *  and their titles must stay stable — both change their own document.title
 *  with whatever file, panel or table has focus, which would otherwise make
 *  the tab strip unreadable. "cluster" is a hosted app too: a headlamp-server
 *  instance for the project, showing one of its Kubernetes contexts. Like the
 *  others it renames its own document.title as you move through resources,
 *  which is exactly why a hosted app's title is fixed at open.
 *
 *  "terminal", "api" and "docker" are the odd ones: tabs with no hosted page
 *  at all. A terminal's pty, an api tab's requests and a docker tab's
 *  commands live in the main process while their surfaces are drawn by the
 *  renderer itself, so they have no URL, no view, and nothing for the
 *  address bar or the history controls to act on.
 *
 *  "chat" is a hosted app of the plainest sort — a project's Slack or Teams
 *  on the web, with nothing spawned behind it. It is not "web" because both
 *  providers rewrite their own document.title with the active channel and an
 *  unread count, which is precisely the churn a fixed label keeps out of the
 *  tab strip. */
export type TabKind =
  | "web"
  | "editor"
  | "database"
  | "terminal"
  | "api"
  | "cluster"
  | "docker"
  | "chat";

export type WorkspaceTab = {
  id: TabId;
  project: string;
  url: string;
  kind: TabKind;
  /** The page's own title, or "" until it reports one. Fixed at open time
   *  for a hosted-app tab and never overwritten after that — see TabKind. */
  title: string;
  /** What this hosted-app tab is *of*, when its kind alone does not say:
   *  the editor root a code-server tab is rooted at. Set at open time and
   *  part of the title, but kept as its own field so the renderer can tell
   *  two editors of the same project apart without parsing their titles. */
  detail?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Set by a failed load, cleared by the next successful navigation. */
  error: string | undefined;
  /** Whether the page currently has a <video> that is actually playing —
   *  reported by the page itself, not guessed from the URL. It is the only
   *  thing that puts the Picture-in-Picture button on screen, so that the
   *  button is never a dead control on a page with nothing to float. */
  hasPlayingVideo: boolean;
  /** Whether the page has taken full screen for itself (a video's full
   *  screen button, or any requestFullscreen). The renderer hides its own
   *  chrome and gives the view the whole window while this is true; without
   *  it the page went "full screen" inside the tab slot, which looked like
   *  Jarvis going full screen rather than the video. Only ever true for the
   *  active tab: Chromium drops full screen when a page is hidden. */
  pageFullscreen: boolean;
  /** Whether this tab's hosted view has been reclaimed while it sat hidden
   *  — see BrowserHost.sweepIdle. The tab, its URL and its place in the
   *  strip are all still here; only the Chromium renderer behind it is
   *  gone, and activating the tab builds a new one at the same URL. False
   *  for every tab that never had a view to lose (terminal, api, docker). */
  suspended: boolean;
};

export type WorkspaceState = {
  tabs: WorkspaceTab[];
  activeTabId: TabId | undefined;
};

export type TabPatch = Partial<Omit<WorkspaceTab, "id" | "project" | "kind">>;
