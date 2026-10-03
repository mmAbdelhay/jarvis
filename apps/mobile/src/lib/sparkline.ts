// Geometry for the small charts: the capacity sparklines and the plan ring.
export const SPARKLINE_WIDTH = 140;
export const SPARKLINE_HEIGHT = 28;
const INSET = 2;

/**
 * The `points` attribute of a polyline over a 140x28 box: values (0-100,
 * clamped) spread evenly across the width, 100 at the top inset. One value
 * gives a flat line across the whole width.
 */
export function sparklinePoints(values: readonly number[]): string {
  if (values.length === 0) {
    return "";
  }
  const y = (value: number): number => {
    const clamped = Math.min(100, Math.max(0, value));
    return INSET + ((100 - clamped) / 100) * (SPARKLINE_HEIGHT - 2 * INSET);
  };
  if (values.length === 1) {
    const flat = y(values[0] ?? 0);
    return `0,${flat} ${SPARKLINE_WIDTH},${flat}`;
  }
  const step = SPARKLINE_WIDTH / (values.length - 1);
  return values.map((value, index) => `${round(index * step)},${round(y(value))}`).join(" ");
}

export const RING_RADIUS = 15;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** `strokeDasharray` for a ring arc covering `fraction` (clamped to 0-1) of the circle. */
export function ringDash(fraction: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  return `${round(clamped * RING_CIRCUMFERENCE)} ${round(RING_CIRCUMFERENCE)}`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
