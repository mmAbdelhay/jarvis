// The glowing threads tying the core to its projects: one curved SVG path
// from the trunk's tip down to each visible first-row project card. The
// user asked for the connection to be *seen* — the earlier straight bus +
// stubs read as a divider and were removed — so these are drawn as light,
// individually-animated curves instead of box borders. Geometry is pure
// here; app.ts measures the DOM, hands rects in, and writes the `d`
// strings out (layoutLinks).

export type Point = { x: number; y: number };
export type Rect = { top: number; left: number; width: number; height: number };

/**
 * The cards a thread should reach: those whose top edge sits in the grid's
 * first visible row band (the grid scrolls its own overflow, so a scrolled
 * second row can occupy the band and the threads follow it — the threads
 * always end at whatever row is showing under the core).
 */
export function firstRowTargets(cards: readonly Rect[], gridTop: number): Point[] {
  const inBand = cards.filter(
    (card) => card.top >= gridTop - 2 && card.top <= gridTop + card.height,
  );
  return inBand.map((card) => ({ x: card.left + card.width / 2, y: card.top }));
}

/**
 * Where one thread leaves the orb: not the single trunk point — a fan
 * pinched into one point read as whiskers — but a spot on the orb's lower
 * arc offset toward its own card, so the threads leave as rays. `radius`
 * is the orb's, `centre` its middle, and the origin drops slightly as it
 * moves off-centre, following the arc.
 */
export function threadOrigin(centre: Point, radius: number, target: Point): Point {
  const lean = Math.max(-0.55, Math.min(0.55, (target.x - centre.x) / (radius * 6)));
  const angle = Math.PI / 2 + lean; // straight down, leaning toward the card
  return {
    x: centre.x + Math.cos(Math.PI - angle) * radius,
    y: centre.y + Math.sin(angle) * radius,
  };
}

/**
 * A cubic bézier from an origin on the orb's arc to one card's top-centre:
 * leaves along the arc's outward normal (mostly downward), arrives at the
 * card straight up. Values are rounded to keep the attribute strings short.
 */
export function threadPath(from: Point, to: Point): string {
  const bend = Math.max(24, (to.y - from.y) * 0.55);
  const drift = (to.x - from.x) * 0.12;
  const r = (value: number): number => Math.round(value * 10) / 10;
  return `M ${r(from.x)} ${r(from.y)} C ${r(from.x + drift)} ${r(from.y + bend)}, ${r(to.x)} ${r(to.y - bend)}, ${r(to.x)} ${r(to.y)}`;
}

/** Every thread for one layout pass, fanned off the orb's lower arc. */
export function threadPaths(
  orb: { centre: Point; radius: number },
  cards: readonly Rect[],
  gridTop: number,
): string[] {
  return firstRowTargets(cards, gridTop).map((target) =>
    threadPath(threadOrigin(orb.centre, orb.radius, target), target),
  );
}
