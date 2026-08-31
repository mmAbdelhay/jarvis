export type TabId = string;

/** One browser tab. `project` is fixed at open time: it decides the
 *  session partition, so moving a tab between projects would mean moving it
 *  between cookie jars — a different tab, not the same one relabelled. */
/** "web" is an ordinary page — address bar, back/forward, the page's own
 *  title all apply. "editor" is a code-server session: the address bar and
 *  history controls are meaningless for it (nobody navigates a code editor
 *  like a webpage) and its title must stay stable — code-server's own
 *  document.title changes with whatever file or panel has focus, which
 *  would otherwise make the tab strip unreadable. */
export type TabKind = "web" | "editor";

export type WorkspaceTab = {
  id: TabId;
  project: string;
  url: string;
  kind: TabKind;
  /** The page's own title, or "" until it reports one. Fixed at open time
   *  for an "editor" tab and never overwritten after that — see TabKind. */
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Set by a failed load, cleared by the next successful navigation. */
  error: string | undefined;
};

export type WorkspaceState = {
  tabs: WorkspaceTab[];
  activeTabId: TabId | undefined;
};

export type TabPatch = Partial<Omit<WorkspaceTab, "id" | "project" | "kind">>;
