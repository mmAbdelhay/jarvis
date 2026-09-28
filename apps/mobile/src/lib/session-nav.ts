// Sessions split view (2026-09-28 spec §3): where opening a session goes.
// A phone pushes the full-screen session route; a wide screen selects the
// session in place, as the `?id=` search param of the sessions split.
// Pure so the routing rules are unit tested.

import type { Language } from "./i18n";
import type { LayoutClass } from "./layout-class";

export type SessionTarget =
  | { action: "push"; href: "/session/[id]"; params: { id: string } }
  | { action: "setParams"; params: { id: string } }
  | { action: "navigate"; href: "/sessions"; params: { id: string } };

/** Where a session row press goes. `from` is the screen holding the row:
 *  the sessions split selects in place, any other wide screen (the
 *  Dashboard) goes to the split with the id. */
export function sessionTarget(
  kind: LayoutClass,
  id: string,
  from: "sessions" | "elsewhere" = "sessions",
): SessionTarget {
  if (kind === "phone") return { action: "push", href: "/session/[id]", params: { id } };
  if (from === "sessions") return { action: "setParams", params: { id } };
  return { action: "navigate", href: "/sessions", params: { id } };
}

export type SessionRouter = {
  push(href: { pathname: "/session/[id]"; params: { id: string } }): void;
  setParams(params: { id: string }): void;
  navigate(href: { pathname: "/sessions"; params: { id: string } }): void;
};

export function openSession(router: SessionRouter, target: SessionTarget): void {
  if (target.action === "push") router.push({ pathname: target.href, params: target.params });
  else if (target.action === "setParams") router.setParams(target.params);
  else router.navigate({ pathname: target.href, params: target.params });
}

/** The `/session/[id]` route on a wide screen shows the split instead. */
export function wideRedirectFor(kind: LayoutClass, id: string): string | undefined {
  return kind === "wide" ? `/sessions?id=${encodeURIComponent(id)}` : undefined;
}

/** How the route performs that redirect. `dismissTo` replaces the session
 *  screen (never pushes), so Back can't land on it and bounce forward again;
 *  when the tabs already sit under it (a phone push, then a rotation) it
 *  returns to them rather than stacking a second tabs navigator. */
export const WIDE_REDIRECT_METHOD = "dismissTo";

export type SessionsSplit = {
  showList: boolean;
  /** The React key of the detail pane: the id alone, never the layout, so a
   *  rotation keeps the same mounted detail and its one subscription. */
  detailKey: string | undefined;
  /** Wide with nothing selected: the "pick a session" pane. */
  showEmpty: boolean;
  /** A phone showing a selection it inherited from a wide layout: a way
   *  back to the list. */
  showBack: boolean;
};

export function sessionsSplit(kind: LayoutClass, id: string | undefined): SessionsSplit {
  const wide = kind === "wide";
  return {
    showList: wide || id === undefined,
    detailKey: id,
    showEmpty: wide && id === undefined,
    showBack: !wide && id !== undefined,
  };
}

/** The list pane is first in reading order: left in English, right in
 *  Arabic. Only the pane order flips, so the panes' own content keeps the
 *  phone's direction. `divider` is the side of the list pane facing the
 *  detail. */
export function splitDirection(language: Language): {
  flexDirection: "row" | "row-reverse";
  divider: "left" | "right";
} {
  return language === "ar"
    ? { flexDirection: "row-reverse", divider: "left" }
    : { flexDirection: "row", divider: "right" };
}

export const SESSIONS_LIST_WIDTH = 360;
