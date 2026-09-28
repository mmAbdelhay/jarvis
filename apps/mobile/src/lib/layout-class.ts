// Wide layout (2026-09-28 spec §1): which shell the app draws. A phone —
// portrait or landscape, native or in a browser — keeps the phone tabs; a
// tablet or a desktop browser window gets the desktop-style WideShell.
// Pure so the breakpoints are unit tested; `use-layout-class.ts` is the
// hook that feeds it the live window size.

export type LayoutClass = "phone" | "wide";

export type LayoutInfo = { kind: LayoutClass; compact: boolean };

// The short side keeps a landscape phone (e.g. 915×412) on the phone
// layout. The width floor is the narrowest iPad in portrait (iPad mini,
// 744pt), which the spec requires to be wide.
export const WIDE_MIN_SHORT_SIDE = 600;
export const WIDE_MIN_WIDTH = 744;
// The desktop's `@container topbar (max-width: 899px)` rule: below this the
// top bar drops its metrics readout.
const COMPACT_BELOW_WIDTH = 900;

export function layoutClassFor(size: { width: number; height: number }): LayoutInfo {
  const wide =
    Math.min(size.width, size.height) >= WIDE_MIN_SHORT_SIDE && size.width >= WIDE_MIN_WIDTH;
  if (!wide) return { kind: "phone", compact: false };
  return { kind: "wide", compact: size.width < COMPACT_BELOW_WIDTH };
}
