// Pure view-model helpers for the phone Workspace: what an open-tab row
// shows, which pane the inline file list reads through, and the file
// list's breadcrumb. Layout stays in the screen and components.
import type { MobileWorkspaceTab } from "@jarvis/wire";
import { crumbs } from "./file-browser";
import type { IconName } from "./icon-paths";
import { paneCountText, t, type Language, type MessageKey } from "./i18n";

type TabKind = MobileWorkspaceTab["kind"];

export type TabRowModel = {
  icon: IconName;
  /** Which theme colour tints the icon. */
  tone: "accent" | "success" | "muted";
  /** "Kind · title". */
  title: string;
  subtitle: string;
};

const KIND_LABEL: Record<TabKind, MessageKey> = {
  terminal: "workspace.terminal",
  docker: "docker.title",
  api: "api.title",
  editor: "sidecars.editor",
  database: "sidecars.database",
  cluster: "sidecars.cluster",
  web: "workspace.kindWeb",
  chat: "workspace.chat",
};

const KIND_SUBTITLE: Record<Exclude<TabKind, "terminal">, MessageKey> = {
  docker: "workspace.kindSubtitle.docker",
  api: "workspace.kindSubtitle.api",
  editor: "workspace.kindSubtitle.editor",
  database: "workspace.kindSubtitle.database",
  cluster: "workspace.kindSubtitle.cluster",
  web: "workspace.kindSubtitle.browser",
  chat: "workspace.kindSubtitle.chat",
};

const KIND_ICON: Record<TabKind, IconName> = {
  terminal: "terminal",
  database: "database",
  docker: "workspace",
  api: "branch",
  editor: "file",
  cluster: "workspace",
  web: "search",
  chat: "sessions",
};

/** One open-on-the-laptop row. `paneCount` is known only for the terminal
 *  tab whose panes were read. The tab's title is server text, shown as is. */
export function tabRowModel(
  tab: Pick<MobileWorkspaceTab, "kind" | "title">,
  language: Language,
  paneCount?: number,
): TabRowModel {
  const kind = t(language, KIND_LABEL[tab.kind]);
  let subtitle: string;
  if (tab.kind === "terminal") {
    subtitle =
      paneCount === undefined
        ? t(language, "workspace.kindSubtitle.terminal")
        : paneCountText(language, paneCount);
  } else {
    subtitle = t(language, KIND_SUBTITLE[tab.kind]);
  }
  return {
    icon: KIND_ICON[tab.kind],
    tone: tab.kind === "terminal" ? "accent" : tab.kind === "database" ? "success" : "muted",
    title: tab.title === "" ? kind : `${kind} · ${tab.title}`,
    subtitle,
  };
}

/** The tab whose main pane the inline file list reads through: the first
 *  terminal tab. A tab's main pane key is its own id. */
export function filesPaneFor(
  tabs: readonly Pick<MobileWorkspaceTab, "id" | "kind">[],
): string | undefined {
  return tabs.find((tab) => tab.kind === "terminal")?.id;
}

/** The project the Workspace opens on when none is chosen yet: the first
 *  with a tab open on the laptop, else the first listed. A chosen project
 *  is kept, and an empty list chooses nothing. */
export function defaultWorkspaceProject(
  projects: readonly { name: string; tabs: readonly unknown[] }[],
  selected: string | undefined,
): string | undefined {
  if (selected !== undefined) return undefined;
  return (projects.find((project) => project.tabs.length > 0) ?? projects[0])?.name;
}

/** The project a deep link asks the Workspace to open on: the named one when
 *  it is listed and not already selected, else nothing. */
export function requestedWorkspaceProject(
  projects: readonly { name: string }[],
  requested: string | undefined,
  selected: string | undefined,
): string | undefined {
  if (requested === undefined || requested === selected) return undefined;
  return projects.some((project) => project.name === requested) ? requested : undefined;
}

export type BreadcrumbPart = { name: string; path: string; current: boolean };

/** The root, then each folder step; only the last one is current. */
export function breadcrumbParts(rootLabel: string, path: string): BreadcrumbPart[] {
  const steps = crumbs(path);
  return [
    { name: rootLabel, path: "", current: steps.length === 0 },
    ...steps.map((step, index) => ({ ...step, current: index === steps.length - 1 })),
  ];
}
