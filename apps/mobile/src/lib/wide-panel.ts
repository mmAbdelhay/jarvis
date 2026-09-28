// Wide layout (2026-09-28 spec §3): the frame a secondary page or a sign-in
// screen gets on a wide screen. Pure so the widths are unit tested;
// `components/WidePanel.tsx` draws it.

import type { LayoutClass } from "./layout-class";
import { theme } from "./theme";

/** The desktop's content measure (`--measure`). */
export const WIDE_PANEL_MAX_WIDTH = 1180;
/** Unlock and pair: a centred card, not a full-screen page. */
export const AUTH_CARD_MAX_WIDTH = 480;

export type PanelFrame = {
  /** undefined: the page keeps the full window width. */
  maxWidth: number | undefined;
  /** Drawn as a bordered, rounded panel. */
  framed: boolean;
};

export type AuthCardFrame = PanelFrame & {
  /** The card scrolls its content when it is taller than the window (an
   *  iPad in landscape with the pair scanner). A phone page keeps its
   *  own full-screen layout, unscrolled. */
  scrolls: boolean;
};

export function widePanelFrame(kind: LayoutClass): PanelFrame {
  return kind === "wide"
    ? { maxWidth: WIDE_PANEL_MAX_WIDTH, framed: true }
    : { maxWidth: undefined, framed: false };
}

export function authCardFrame(kind: LayoutClass): AuthCardFrame {
  return kind === "wide"
    ? { maxWidth: AUTH_CARD_MAX_WIDTH, framed: true, scrolls: true }
    : { maxWidth: undefined, framed: false, scrolls: false };
}

/** The top padding of an auth page's content. A phone page clears the
 *  status bar (`phoneTop` includes the safe-area inset); a card has no
 *  status bar above it, so it takes one theme step. */
export function authCardContentTop(kind: LayoutClass, phoneTop: number): number {
  return kind === "wide" ? theme.spacing.xl : phoneTop;
}

/** A panel's header title: the one the page set (a transcript's session
 *  summary, once loaded) over the route's own. */
export function panelTitle(routeTitle: string, pageTitle: string | undefined): string {
  return pageTitle ?? routeTitle;
}
