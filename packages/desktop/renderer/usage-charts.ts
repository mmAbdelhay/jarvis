import type { UsageHistory } from "../src/usage-history.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";

// The Dashboard's two small history charts, drawn as inline SVG built node
// by node (no innerHTML, like every other renderer module). Both are single
// series, so neither has a legend — the panel each sits in names it — and
// both use the app's own accent, so neither adds a colour to the system.
// Every mark carries a <title>: hover shows its value, and the chart as a
// whole carries an aria-label with the same total a reader would want.

const SVG = "http://www.w3.org/2000/svg";
const DAY_MS = 24 * 60 * 60 * 1000;

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

function titled<T extends SVGElement>(element: T, text: string): T {
  const title = svg("title", {});
  title.textContent = text;
  element.append(title);
  return element;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(at: number): string {
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * An account's remaining capacity over the last day: a 2px line over a
 * fixed 0-100% scale (so two accounts' lines compare at a glance), one
 * hoverable point per reading. Undefined with fewer than two readings — a
 * single dot is not a history, and the meter above it already shows it.
 */
export function capacitySparkline(
  points: UsageHistory["capacity"][number]["points"],
  now: number,
): SVGSVGElement | undefined {
  if (points.length < 2) return undefined;
  const width = 200;
  const height = 32;
  const pad = 3;
  const x = (at: number): number => pad + ((at - (now - DAY_MS)) / DAY_MS) * (width - 2 * pad);
  const y = (left: number): number => pad + (1 - left / 100) * (height - 2 * pad);

  const chart = svg("svg", {
    class: "usage-spark",
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: "none",
    role: "img",
    "aria-label": MESSAGES.capacityHistoryLabel(PRIMARY_LANGUAGE),
  });
  chart.append(
    svg("polyline", {
      class: "usage-spark__line",
      points: points
        .map((point) => `${x(point.at).toFixed(1)},${y(point.left).toFixed(1)}`)
        .join(" "),
    }),
  );
  for (const point of points) {
    // The visible marker is small; the hit target around it is not.
    const group = svg("g", { class: "usage-spark__point" });
    group.append(
      svg("circle", { class: "usage-spark__hit", cx: x(point.at), cy: y(point.left), r: 6 }),
      svg("circle", { class: "usage-spark__dot", cx: x(point.at), cy: y(point.left), r: 2 }),
    );
    chart.append(
      titled(
        group,
        MESSAGES.capacityPointLeft(clock(point.at), Math.floor(point.left), PRIMARY_LANGUAGE),
      ),
    );
  }
  return chart;
}

/** Sessions started per day, one bar a day, into #sessions-chart. A day
 *  with none draws a baseline tick rather than nothing, so "none" and "not
 *  drawn" never look the same. */
export function renderSessionsChart(days: UsageHistory["sessionsPerDay"]): void {
  const host = document.getElementById("sessions-chart");
  if (host === null) return;
  if (days.length === 0) {
    host.replaceChildren();
    return;
  }
  const bar = 6;
  const gap = 2;
  const height = 18;
  const max = Math.max(1, ...days.map((day) => day.count));
  const width = days.length * (bar + gap) - gap;
  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, width, height });
  days.forEach((day, index) => {
    const x = index * (bar + gap);
    const h = day.count === 0 ? 1 : Math.max(2, (day.count / max) * height);
    const mark = svg("rect", {
      class: day.count === 0 ? "usage-bars__empty" : "usage-bars__bar",
      x,
      y: height - h,
      width: bar,
      height: h,
      rx: day.count === 0 ? 0 : 1.5,
    });
    // The hit target is the whole column, not just the bar.
    const column = svg("g", {});
    column.append(
      svg("rect", { class: "usage-bars__hit", x, y: 0, width: bar + gap, height }),
      mark,
    );
    chart.append(
      titled(
        column,
        `${dayLabel(day.day)} · ${MESSAGES.sessionsCount(day.count, PRIMARY_LANGUAGE)}`,
      ),
    );
  });
  const total = days.reduce((sum, day) => sum + day.count, 0);
  host.setAttribute("aria-label", MESSAGES.sessionsHistoryLabel(total, PRIMARY_LANGUAGE));
  host.replaceChildren(chart);
}
