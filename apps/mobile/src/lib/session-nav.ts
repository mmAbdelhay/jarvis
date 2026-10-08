// Sessions split view (2026-09-28 spec §3): where opening a session goes.
// A phone pushes the full-screen session route; a wide screen selects the
// session in place, as the `?id=` search param of the sessions split.
// Pure so the routing rules are unit tested.

import type { Language } from "./i18n";
import type { LayoutClass } from "./layout-class";

export type SessionTarget =
  | { action: "push"; href: "/session/[id]" | "/transcript/[id]"; params: { id: string } }
  | { action: "setParams"; params: { id: string } }
  | { action: "navigate"; href: "/sessions"; params: { id: string } };

/** Where a session row press goes. `from` is the screen holding the row:
 *  the sessions split selects in place, any other wide screen (the
 *  Dashboard) goes to the split with the id. A session that exists only in
 *  the saved history has no live screen: a phone opens its transcript (a
 *  wide split shows the transcript in its detail pane). */
export function sessionTarget(
  kind: LayoutClass,
  id: string,
  from: "sessions" | "elsewhere" = "sessions",
  source: "live" | "history" = "live",
): SessionTarget {
  if (kind === "phone") {
    const href = source === "history" ? "/transcript/[id]" : "/session/[id]";
    return { action: "push", href, params: { id } };
  }
  if (from === "sessions") return { action: "setParams", params: { id } };
  return { action: "navigate", href: "/sessions", params: { id } };
}

export type SessionRouter = {
  push(href: { pathname: "/session/[id]" | "/transcript/[id]"; params: { id: string } }): void;
  setParams(params: { id: string }): void;
  navigate(href: { pathname: "/sessions"; params: { id: string } }): void;
};

export function openSession(router: SessionRouter, target: SessionTarget): void {
  if (target.action === "push") router.push({ pathname: target.href, params: target.params });
  else if (target.action === "setParams") router.setParams(target.params);
  else router.navigate({ pathname: target.href, params: target.params });
}

/** The `/session/[id]` route on a wide screen shows the split instead; an
 *  invalid id goes to the split with nothing selected, never a dead page
 *  (this route has no header and no shell on wide). */
export function wideRedirectFor(kind: LayoutClass, id: string | undefined): string | undefined {
  if (kind !== "wide") return undefined;
  return id === undefined ? "/sessions" : `/sessions?id=${encodeURIComponent(id)}`;
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

/** Whether the selected id is in the laptop's session list: "unknown"
 *  while the list is loading or failed to load. */
export type SessionPresence = "found" | "missing" | "unknown";

export function sessionPresence(input: {
  /** A `sessions:list` has answered since the screen mounted. */
  listed: boolean;
  loading: boolean;
  failed: boolean;
  found: boolean;
}): SessionPresence {
  if (input.found) return "found";
  if (!input.listed || input.loading || input.failed) return "unknown";
  return "missing";
}

export function sessionsSplit(
  kind: LayoutClass,
  selected: string | undefined,
  presence: SessionPresence = "unknown",
): SessionsSplit {
  const wide = kind === "wide";
  // Wide: a session the list no longer has falls back to the empty pane,
  // with the list beside it to pick another.
  const id = wide && presence === "missing" ? undefined : selected;
  return {
    showList: wide || id === undefined,
    detailKey: id,
    showEmpty: wide && id === undefined,
    showBack: !wide && id !== undefined,
  };
}

export type SplitLayout = {
  /** The split container's layout direction: the reading direction, so
   *  the list (its first child) sits on the reading-start side. */
  direction: "rtl" | "ltr";
  /** Each pane's own direction: what the platform already lays out, so
   *  the panes' content matches the phone screens. */
  paneDirection: "rtl" | "ltr";
};

/** The split mirrors like the top bar: `direction`, never `row-reverse`.
 *  `platformRtl` is `I18nManager.getConstants().isRTL`: true on native once
 *  _layout.tsx has forced RTL for Arabic, always false on web (where
 *  react-native-web ignores forceRTL). A reversed row would flip twice on
 *  native. */
export function splitLayout(input: { language: Language; platformRtl: boolean }): SplitLayout {
  return {
    direction: input.language === "ar" ? "rtl" : "ltr",
    paneDirection: input.platformRtl ? "rtl" : "ltr",
  };
}

/** Where a `flexDirection: "row"` container in `direction` puts its first
 *  child (Yoga and the browser agree): the physical side the list lands on. */
export function firstChildSide(direction: "rtl" | "ltr"): "left" | "right" {
  return direction === "rtl" ? "right" : "left";
}
