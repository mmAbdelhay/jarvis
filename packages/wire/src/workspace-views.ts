export type TerminalPaneInfo = {
  paneKey: string;
  exited: boolean;
};

export type MobileWorkspaceTabKind =
  | "web"
  | "editor"
  | "database"
  | "terminal"
  | "api"
  | "cluster"
  | "docker"
  | "chat";

export type MobileWorkspaceTab = {
  id: string;
  project: string;
  url: string;
  kind: MobileWorkspaceTabKind;
  title: string;
  detail?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | undefined;
  hasPlayingVideo: boolean;
  pageFullscreen: boolean;
  suspended: boolean;
};

export type MobileWorkspaceSnapshot = {
  tabs: MobileWorkspaceTab[];
  activeTabId: string | undefined;
};
