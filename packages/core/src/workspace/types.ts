export type TabId = string;

/** One browser tab. `project` is fixed at open time: it decides the
 *  session partition, so moving a tab between projects would mean moving it
 *  between cookie jars — a different tab, not the same one relabelled. */
export type WorkspaceTab = {
  id: TabId;
  project: string;
  url: string;
  /** The page's own title, or "" until it reports one. */
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

export type TabPatch = Partial<Omit<WorkspaceTab, "id" | "project">>;

/** One markdown file under a project root; `path` is relative to that root
 *  and is the only path the renderer ever handles. */
export type DocEntry = { path: string; name: string };
