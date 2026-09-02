import type { Rect } from "./browser-host.js";

/**
 * Converts a rectangle the renderer measured into the units a hosted view is
 * positioned in.
 *
 * `getBoundingClientRect` answers in CSS pixels. `WebContentsView.setBounds`
 * places a view in device-independent pixels. Those are the same size right
 * up until the display runs a scaled resolution, at which point the window's
 * web contents is scaled and the two part company. On the display this was
 * found on — devicePixelRatio 2.19 against a display scale factor of 2 — a
 * 1577px-wide slot was handed straight across and placed as 1577 DIP inside
 * a 1728 DIP window: every hosted page sat 9% short, leaving a band of empty
 * window down the right and along the bottom, and covering the bookmarks bar
 * because the same shortfall applied to the offset.
 *
 * The scale is `devicePixelRatio / scaleFactor` — how many device pixels a
 * CSS pixel is worth, over how many a DIP is worth. It is deliberately not
 * derived from the window's own geometry: `getContentBounds()` reports the
 * whole display in full screen while the web contents sits inset below the
 * menu bar, which makes the vertical ratio disagree with the horizontal one
 * and stretches the view past the bottom of the window. This ratio is a
 * property of the display, identical on both axes.
 */
export function toDeviceIndependent(
  rect: Rect,
  devicePixelRatio: number,
  scaleFactor: number,
): Rect {
  const scale = devicePixelRatio / scaleFactor;
  // A renderer that has not reported a ratio yet, or a display that reports
  // a nonsense scale, must leave the rectangle alone rather than move a view
  // to NaN. An unscaled display is the common case and is returned
  // untouched, so it can never pick up rounding drift.
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) return rect;
  return {
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  };
}
