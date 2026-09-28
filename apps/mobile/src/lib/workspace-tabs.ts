// Wide layout (2026-09-28 spec §3): the desktop-style Workspace. A tab
// strip of the laptop's open terminal/Docker/API tabs for the selected
// project, then the tools the user opened here (Docker, API, Changes),
// with the active one rendered inline. The selection is the `?tab=`
// search param (and `?pane=` for a terminal tab's pane). A phone keeps
// pushing each view's own full-screen route. Pure so the rules are unit
// tested.

import type { MobileWorkspaceTab, TerminalPaneInfo } from "@jarvis/wire";
import { t, type Language } from "./i18n";
import type { LayoutClass } from "./layout-class";

export type WorkspaceTabKind = "terminal" | "docker" | "api" | "changes";
export type WorkspaceToolKind = "docker" | "api" | "changes";

export type WorkspaceTabItem = {
  id: string;
  kind: WorkspaceTabKind;
  title: string;
  /** Tools opened here can be closed; the laptop's own tabs cannot (a
   *  phone never rearranges the laptop's window). */
  closable: boolean;
};

const TOOL_PREFIX = "tool:";
const TOOL_KINDS: readonly WorkspaceToolKind[] = ["docker", "api", "changes"];
const TOOL_TITLE_KEYS = {
  docker: "docker.title",
  api: "api.title",
  changes: "dashboard.changes",
} as const;

/** The laptop tab kinds a wide screen renders inline. Sidecars, web pages
 *  and chats keep their own routes (a new browser tab on web). */
function inlineKind(kind: MobileWorkspaceTab["kind"]): kind is "terminal" | "docker" | "api" {
  return kind === "terminal" || kind === "docker" || kind === "api";
}

export function toolTabId(kind: WorkspaceToolKind): string {
  return `${TOOL_PREFIX}${kind}`;
}

function toolFromTabId(id: string | undefined): WorkspaceToolKind | undefined {
  if (id === undefined || !id.startsWith(TOOL_PREFIX)) return undefined;
  const kind = id.slice(TOOL_PREFIX.length);
  return TOOL_KINDS.find((tool) => tool === kind);
}

/** The strip: the snapshot's inline tabs in its own order, then the open
 *  tools in the order they were opened. */
export function workspaceTabsFrom(
  snapshot: { tabs: readonly MobileWorkspaceTab[] },
  openTools: readonly WorkspaceToolKind[],
  language: Language,
): WorkspaceTabItem[] {
  const tabs: WorkspaceTabItem[] = [];
  for (const tab of snapshot.tabs) {
    if (!inlineKind(tab.kind)) continue;
    // Server-originated text: shown verbatim.
    tabs.push({ id: tab.id, kind: tab.kind, title: tab.title, closable: false });
  }
  for (const tool of new Set(openTools)) {
    tabs.push({
      id: toolTabId(tool),
      kind: tool,
      title: t(language, TOOL_TITLE_KEYS[tool]),
      closable: true,
    });
  }
  return tabs;
}

/** The open tools, plus the one a `?tab=` param names (a reload or a
 *  shared link keeps its tool open). */
export function openToolsWith(
  openTools: readonly WorkspaceToolKind[],
  param: string | undefined,
): WorkspaceToolKind[] {
  const tool = toolFromTabId(param);
  if (tool === undefined || openTools.includes(tool)) return [...openTools];
  return [...openTools, tool];
}

export function withoutTool(
  openTools: readonly WorkspaceToolKind[],
  id: string,
): WorkspaceToolKind[] {
  const tool = toolFromTabId(id);
  return openTools.filter((open) => open !== tool);
}

/** The selected tab: the param when it names one, otherwise the first. */
export function activeTab(tabs: readonly WorkspaceTabItem[], param?: string): string | undefined {
  if (param !== undefined && tabs.some((tab) => tab.id === param)) return param;
  return tabs[0]?.id;
}

export type WorkspaceTargetTab = {
  id: string;
  kind: WorkspaceTabKind;
  project?: string;
  paneKey?: string;
};

export type WorkspaceTarget =
  | {
      action: "push";
      href: "/terminal/[paneKey]";
      params: { paneKey: string; tabId: string };
    }
  | { action: "push"; href: "/docker/[project]" | "/api/[project]"; params: { project: string } }
  | { action: "push"; href: "/changes"; params: Record<string, never> }
  | { action: "setParams"; params: { tab: string; pane: string | undefined } };

/** Where opening a workspace tab goes: a phone pushes the view's own
 *  route; a wide screen selects the tab in place. */
export function workspaceTarget(kind: LayoutClass, tab: WorkspaceTargetTab): WorkspaceTarget {
  if (kind === "wide") return { action: "setParams", params: { tab: tab.id, pane: tab.paneKey } };
  switch (tab.kind) {
    case "terminal":
      return {
        action: "push",
        href: "/terminal/[paneKey]",
        params: { paneKey: tab.paneKey ?? tab.id, tabId: tab.id },
      };
    case "docker":
      return { action: "push", href: "/docker/[project]", params: { project: tab.project ?? "" } };
    case "api":
      return { action: "push", href: "/api/[project]", params: { project: tab.project ?? "" } };
    case "changes":
      return { action: "push", href: "/changes", params: {} };
  }
}

export type WorkspaceRouter = {
  push(href: { pathname: string; params: Record<string, string> }): void;
  setParams(params: { tab: string; pane: string | undefined }): void;
};

export function openWorkspaceTab(router: WorkspaceRouter, target: WorkspaceTarget): void {
  if (target.action === "push") router.push({ pathname: target.href, params: target.params });
  else router.setParams(target.params);
}

/** The `/terminal/[paneKey]` route on a wide screen shows the pane inline
 *  in the Workspace instead (left by `dismissTo`, as the session route
 *  does). A fresh tab's main pane key is its own tab id. */
export function workspaceRedirectFor(
  kind: LayoutClass,
  tabId: string | undefined,
  paneKey: string | undefined,
): string | undefined {
  if (kind !== "wide") return undefined;
  const tab = tabId ?? paneKey;
  if (tab === undefined) return "/workspace";
  const pane = paneKey ?? tab;
  return `/workspace?tab=${encodeURIComponent(tab)}&pane=${encodeURIComponent(pane)}`;
}

/** Which pane of a terminal tab is shown: the `?pane=` param when the
 *  tab's inventory has it, else the tab's main pane, else its first.
 *  Undefined until that tab's own inventory has been read. */
export function terminalPaneFor(input: {
  tabId: string;
  panes: readonly TerminalPaneInfo[];
  panesTabId: string | undefined;
  pane?: string;
}): string | undefined {
  if (input.panesTabId !== input.tabId) return undefined;
  const has = (key: string | undefined) =>
    key !== undefined && input.panes.some((pane) => pane.paneKey === key);
  if (has(input.pane)) return input.pane;
  if (has(input.tabId)) return input.tabId;
  return input.panes[0]?.paneKey;
}

export type WorkspaceLayout = {
  /** Wide: the project picker, tool buttons and the tab strip. */
  showTools: boolean;
  /** A phone showing a tab it inherited from a wide layout: a way back. */
  showBack: boolean;
  /** The phone's own Workspace list. */
  showList: boolean;
  /** The React key of the inline pane: the pane (or tab) alone, never the
   *  layout, so crossing the breakpoint keeps the same mounted pane and
   *  its one `terminal:attach`. */
  paneKey: string | undefined;
  /** Wide with nothing to show. */
  showEmpty: boolean;
};

export function workspaceLayout(kind: LayoutClass, paneKey: string | undefined): WorkspaceLayout {
  const wide = kind === "wide";
  return {
    showTools: wide,
    showBack: !wide && paneKey !== undefined,
    showList: !wide && paneKey === undefined,
    paneKey,
    showEmpty: wide && paneKey === undefined,
  };
}
