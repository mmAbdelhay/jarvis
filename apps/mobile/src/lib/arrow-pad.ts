// The arrow pad's gesture arithmetic, kept apart from the view so it is
// tested without one.

/** How far a finger travels for one arrow key. */
export const ARROW_STEP_PX = 18;

export type Arrow = "left" | "right" | "up" | "down";

/**
 * Arrow keys sent for a drag of (dx, dy) from where the last keys were
 * sent: one per ARROW_STEP_PX along the axis that moved more, and the
 * distance those keys used up, so the rest carries into the next move.
 */
export function arrowsFor(
  dx: number,
  dy: number,
): { arrows: Arrow[]; used: { x: number; y: number } } {
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const distance = horizontal ? dx : dy;
  const steps = Math.trunc(Math.abs(distance) / ARROW_STEP_PX);
  if (steps === 0) return { arrows: [], used: { x: 0, y: 0 } };
  const arrow: Arrow = horizontal ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
  const usedDistance = Math.sign(distance) * steps * ARROW_STEP_PX;
  return {
    arrows: Array.from({ length: steps }, () => arrow),
    used: horizontal ? { x: usedDistance, y: 0 } : { x: 0, y: usedDistance },
  };
}
