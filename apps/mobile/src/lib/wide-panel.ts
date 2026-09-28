// Wide layout (2026-09-28 spec §3): the frame a secondary page or a sign-in
// screen gets on a wide screen. Pure so the widths are unit tested;
// `components/WidePanel.tsx` draws it.

import type { LayoutClass } from "./layout-class";

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

export function widePanelFrame(kind: LayoutClass): PanelFrame {
  return kind === "wide"
    ? { maxWidth: WIDE_PANEL_MAX_WIDTH, framed: true }
    : { maxWidth: undefined, framed: false };
}

export function authCardFrame(kind: LayoutClass): PanelFrame {
  return kind === "wide"
    ? { maxWidth: AUTH_CARD_MAX_WIDTH, framed: true }
    : { maxWidth: undefined, framed: false };
}
