// The topbar never wraps and never scrolls, so anything wider than the
// window used to be clipped off the inline-end edge — the history button
// first, since it is last. Fixed container-query breakpoints guessed at the
// width; this measures it instead: show everything, then hide the least
// important pieces one at a time until the bar fits. The nav, the clock's
// time and the keep-awake/history buttons are never in the list, so they
// always stay.

/** Hidden first to last. A selector may match more than one element (the
 *  net readout and its separator go together). */
export const TOPBAR_COLLAPSE_ORDER: readonly string[] = [
  "#clock-date",
  "#remote-pill-text",
  "#topbar-metrics .metric-net",
  "#header-prayer",
  "#topbar-metrics",
  "#battery-text",
  ".brand",
  // Last resort, on a window narrower than the nav plus the pills: the
  // running count (the Dashboard lists sessions too), then the connection
  // pill's word — its dot stays.
  "#running-pill",
  "#voice-state",
];

export const TOPBAR_COLLAPSED_CLASS = "topbar-collapsed";

/** Re-fits `bar` from scratch. `overflows` is the measurement (injected so
 *  tests need no layout engine); it is read after every step. Returns how
 *  many steps were hidden. */
export function fitTopbar(
  bar: HTMLElement,
  overflows: () => boolean = () => bar.scrollWidth > bar.clientWidth,
): number {
  for (const el of bar.querySelectorAll(`.${TOPBAR_COLLAPSED_CLASS}`)) {
    el.classList.remove(TOPBAR_COLLAPSED_CLASS);
  }
  let steps = 0;
  for (const selector of TOPBAR_COLLAPSE_ORDER) {
    if (!overflows()) break;
    for (const el of bar.querySelectorAll(selector)) el.classList.add(TOPBAR_COLLAPSED_CLASS);
    steps += 1;
  }
  return steps;
}

/** Keeps the topbar fitted as the window resizes and as its text changes
 *  (metrics tick, the prayer label counts down, a pill appears). */
export function initTopbarFit(bar: HTMLElement | null): void {
  if (bar === null || typeof ResizeObserver === "undefined") return;
  let queued = false;
  const refit = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fitTopbar(bar);
    });
  };
  new ResizeObserver(refit).observe(bar);
  // `hidden` only: fitTopbar's own class changes must not re-trigger it.
  new MutationObserver(refit).observe(bar, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["hidden"],
  });
  refit();
}
