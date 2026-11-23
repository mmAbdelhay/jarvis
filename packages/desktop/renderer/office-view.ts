// The Office: a DOM and SVG world drawn with CSS transforms — one isometric
// room per project, one cubicle and one employee per tab, a sidebar of
// projects, a minimap once zoomed in, and a hover card for whoever is there.
// Reached from the Workspace button's menu (workspace-menu.ts).
//
// Everything a tab, an agent or a person wrote reaches the DOM through
// textContent or setAttribute — never innerHTML. Employees are reconciled by
// key, so an unchanged employee keeps its node (its animation and focus).
// Motion is CSS only (transform and opacity), paused while the route or the
// document is hidden, and still under prefers-reduced-motion. While the route
// is hidden `update` only remembers the model: no DOM work at all.

import type { Session, WorkspaceState } from "@jarvis/core";
import type { RendererApi } from "../src/ipc.js";
import { EMPTY_OFFICE_ACTIVITY, type OfficeActivity } from "../src/office-activity.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { formatAgo } from "./format.js";
import {
  buildOffice,
  isoPoint,
  type OfficeEmployee,
  type OfficeModel,
  type OfficePose,
  type OfficeRoom,
  type OfficeTarget,
  seatPoint,
  worldLayout,
} from "./office-model.js";

const SVG_NS = "http://www.w3.org/2000/svg";
/** How long a leaver walks out, and a newcomer walks in. */
export const OFFICE_WALK_MS = 400;
const POSE_FADE_MS = 300;
const NEAR_K = 0.7;
const K_MAX = 2;
const K_MIN_FLOOR = 0.02;
const DRAG_PX = 4;
const MARGIN = 12;
const ROOM_FOCUS_K = 1.35;
const SEAT_W = 200;
const SEAT_H = 150;
const MINIMAP_W = 216;
const MINIMAP_H = 156;
const MINIMAP_PAD = 8;
const CARD_W = 290;

export type OfficeViewOptions = {
  /** #view-office, with the skeleton from index.html in it. */
  root: HTMLElement;
  open(target: OfficeTarget): void;
  /** An employee's context menu (right click, the Menu key, Shift+F10), at a
   *  point in the window. Only for an employee with a tab. */
  employeeMenu?(tabId: string, x: number, y: number): void;
  /** The empty state's "Open a tab". */
  openTab(): void;
  language?: "ar" | "en";
  /** Whether the route is on screen. Default: the root is not hidden. */
  visible?(): boolean;
  /** The stage's size in px. Default: its own box. */
  measure?(): { width: number; height: number };
  now?(): number;
};

export type OfficeViewState = { k: number; tx: number; ty: number; fit: boolean };

export type OfficeView = {
  /** The latest model. No DOM work while the route is hidden. */
  update(model: OfficeModel): void;
  /** The route became visible: draw what was held back. */
  show(): void;
  fitAll(): void;
  zoomIn(): void;
  zoomOut(): void;
  view(): OfficeViewState;
  dispose(): void;
};

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  className?: string,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  if (className !== undefined) node.setAttribute("class", className);
  return node;
}

function html<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function hashOf(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash;
}

/** One of the four room tints, stable for a project name. */
function tintOf(id: string): number {
  return Math.imul(hashOf(id), 2654435761) >>> 30;
}

const points = (list: readonly { x: number; y: number }[]): string =>
  list.map((point) => `${point.x},${point.y}`).join(" ");

// ---- the employee ---------------------------------------------------------

const ARMS: Record<OfficePose, [string, number, number, string, number, number]> = {
  typing: ["M26 60 L24 74 L34 80", 34, 80, "M54 60 L56 74 L46 80", 46, 80],
  hand: ["M26 60 L24 74 L34 80", 34, 80, "M55 58 L62 38 L60 10", 60, 6],
  idle: ["M26 60 L17 72", 17, 72, "M54 60 L60 76", 60, 78],
  done: ["M26 60 L20 70 L26 78", 26, 78, "M54 60 L60 70 L54 78", 54, 78],
  walking: ["M26 60 L20 76", 20, 78, "M54 60 L60 74", 60, 76],
  dead: ["M26 62 L20 82", 20, 84, "M54 62 L60 82", 60, 84],
  asleep: ["M26 64 L24 78 L38 82", 38, 82, "M54 64 L56 78 L44 82", 44, 82],
};

/** One pose of the employee, front view. Colours come from CSS classes and
 *  the seat's --ow-* custom properties. */
function workerSvg(pose: OfficePose): SVGSVGElement {
  const typing = pose === "typing";
  const hand = pose === "hand";
  const slump = pose === "dead" || pose === "asleep";
  const standing = pose === "walking" || pose === "done";
  const arms = ARMS[pose];
  const root = svg(
    "svg",
    { width: 80, height: 96, viewBox: "0 0 80 96", "aria-hidden": "true" },
    `office-pose ow-svg${pose === "walking" ? " ow-walk" : ""}`,
  );
  root.append(
    svg(
      "rect",
      { x: 20, y: 46, width: 40, height: 46, rx: 12, opacity: standing ? 0 : 1 },
      "ow-chair",
    ),
  );
  const legs = svg("g", { opacity: standing ? 1 : 0 }, "ow-legs");
  legs.append(svg("path", { d: "M34 78V92" }), svg("path", { d: "M46 78V92" }));
  root.append(legs);

  const body = svg("g", {}, pose === "walking" ? "ow-step" : pose === "dead" ? "" : "ow-breathe");
  const lean = svg("g", {
    transform: pose === "idle" ? "rotate(-7 40 84)" : slump ? "translate(0 5)" : "",
  });
  lean.append(
    svg("path", { d: "M22 84V60c0-10 7-15 18-15s18 5 18 15v24z" }, "ow-shirt"),
    svg("path", { d: "M34 45l6 8 6-8z" }, "ow-skin"),
  );
  const arm = (path: string, hx: number, hy: number, className: string): SVGGElement => {
    const group = svg("g", {}, className);
    group.append(
      svg(
        "path",
        {
          d: path,
          "stroke-width": 8,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
          fill: "none",
        },
        "ow-arm",
      ),
      svg("circle", { cx: hx, cy: hy, r: 4.5 }, "ow-skin"),
    );
    return group;
  };
  lean.append(arm(arms[0], arms[1], arms[2], typing ? "ow-type" : ""));
  const tilt =
    pose === "dead"
      ? "rotate(22 40 44) translate(0 5)"
      : pose === "asleep"
        ? "rotate(-18 40 44) translate(0 6)"
        : "";
  const head = svg("g", { transform: tilt });
  head.append(
    svg("circle", { cx: 40, cy: 30, r: 14 }, "ow-skin"),
    svg("path", { d: "M26 30c-2-13 6-19 14-19s16 6 14 19c-3-7-8-9-14-9s-11 2-14 9z" }, "ow-hair"),
    svg(
      "path",
      {
        d: slump ? "M33 33h5M43 33h5" : "M35 31v1.5M45 31v1.5",
        fill: "none",
        "stroke-width": 2.4,
        "stroke-linecap": "round",
      },
      "ow-ink",
    ),
    svg(
      "path",
      {
        d: pose === "dead" ? "M36 40q4-3 8 0" : hand ? "M38 38h4" : "M36 37q4 3 8 0",
        fill: "none",
        "stroke-width": 1.8,
        "stroke-linecap": "round",
      },
      "ow-ink",
    ),
  );
  lean.append(head, arm(arms[3], arms[4], arms[5], typing ? "ow-type-b" : hand ? "ow-wave" : ""));
  body.append(lean);
  root.append(body);

  const cup = svg("g", { opacity: pose === "idle" ? 1 : 0 });
  cup.append(
    svg("rect", { x: 10, y: 62, width: 10, height: 11, rx: 2 }, "ow-cup"),
    svg("path", { d: "M10 65h-3v5h3", fill: "none", "stroke-width": 1.6 }, "ow-cup-line"),
  );
  const check = svg("g", { opacity: pose === "done" ? 1 : 0 });
  check.append(
    svg("circle", { cx: 64, cy: 14, r: 9 }, "ow-check-bg"),
    svg(
      "path",
      { d: "M60 14l3 3 5-6", fill: "none", "stroke-width": 2, "stroke-linecap": "round" },
      "ow-check",
    ),
  );
  const zed = svg("g", { opacity: pose === "asleep" ? 1 : 0 });
  const zedInner = svg("g", {}, "ow-zed");
  zedInner.append(
    svg(
      "path",
      {
        d: "M58 14h8l-8 9h8M69 4h6l-6 7h6",
        fill: "none",
        "stroke-width": 2,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
      "ow-zed-line",
    ),
  );
  zed.append(zedInner);
  root.append(cup, check, zed);
  return root;
}

type SeatNode = {
  key: string;
  element: HTMLButtonElement;
  worker: HTMLElement;
  glyph: HTMLElement;
  /** The seat's name tag, hand badge and bubble, drawn in the world's label
   *  layer (above every room), not inside the seat. */
  labels: HTMLElement;
  tag: HTMLElement;
  handBadge: HTMLElement | undefined;
  bubble: HTMLElement | undefined;
  pose: OfficePose;
  sig: string;
  employee: OfficeEmployee;
  /** Where its seat centre is, in world px. */
  world: { x: number; y: number };
};

type RoomNode = {
  id: string;
  element: HTMLElement;
  sign: HTMLButtonElement;
  signName: HTMLElement;
  signCount: HTMLElement;
  signHands: HTMLElement;
  floorKey: string;
  floor: SVGSVGElement;
  seats: Map<string, SeatNode>;
  room: OfficeRoom;
  x: number;
  y: number;
  width: number;
  height: number;
};

type RowNode = {
  element: HTMLButtonElement;
  swatch: HTMLElement;
  name: HTMLElement;
  count: HTMLElement;
  hands: HTMLElement;
};

export function createOfficeView(options: OfficeViewOptions): OfficeView {
  const { root, open } = options;
  const L = options.language ?? PRIMARY_LANGUAGE;
  const now = options.now ?? (() => Date.now());
  const $ = <T extends HTMLElement>(id: string): T => {
    const found = root.querySelector<T>(`#${id}`);
    if (found === null) throw new Error(`The Office skeleton has no #${id}`);
    return found;
  };
  const stage = $("office-stage");
  const world = $("office-world");
  // One layer after every room: a name tag, hand badge or bubble is never
  // covered by a neighbouring cubicle or room, however the rooms overlap.
  const labelLayer = html("div", "office-labels");
  labelLayer.setAttribute("aria-hidden", "true");
  world.append(labelLayer);
  const list = $("office-list");
  const empty = $("office-empty");
  const minimap = $("office-minimap");
  const minimapView = $("office-minimap-view");
  const card = $("office-card");
  const isVisible = options.visible ?? (() => !root.hidden);
  const measure =
    options.measure ??
    (() => {
      const rect = stage.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });

  // Static labels: the skeleton carries English defaults.
  $("office-title").textContent = MESSAGES.officeTitle(L);
  $("office-home").textContent = MESSAGES.officeShowAll(L);
  $("office-side-hint").textContent = MESSAGES.officeProjectsHint(L);
  $("office-empty-title").textContent = MESSAGES.officeEmptyTitle(L);
  $("office-empty-open").textContent = MESSAGES.officeEmptyAction(L);
  $("office-zoom-in").setAttribute("aria-label", MESSAGES.officeZoomIn(L));
  $("office-zoom-out").setAttribute("aria-label", MESSAGES.officeZoomOut(L));
  $("office-side").setAttribute("aria-label", MESSAGES.officeSidebarLabel(L));
  stage.setAttribute("aria-label", MESSAGES.officeStageLabel(L));
  minimap.setAttribute("aria-label", MESSAGES.officeMinimapLabel(L));
  // The world's transform is physical, so the stage stays left-to-right even
  // in a right-to-left window; the sidebar and bar follow the document.
  stage.dir = "ltr";

  let model: OfficeModel | undefined;
  let held = false;
  let drawn = false;
  let disposed = false;
  let k = 1;
  let tx = 0;
  let ty = 0;
  let fit = true;
  let focusRoom: string | undefined;
  let layoutSize = { width: 0, height: 0 };
  let hover: SeatNode | undefined;
  const rooms = new Map<string, RoomNode>();
  const rows = new Map<string, RowNode>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  }

  const roomName = (room: OfficeRoom): string =>
    room.lounge ? MESSAGES.officeLounge(L) : room.name;

  // ---- the camera ---------------------------------------------------------

  function stageSize(): { width: number; height: number } {
    return measure();
  }

  function fitK(size: { width: number; height: number }): number {
    if (layoutSize.width === 0 || layoutSize.height === 0) return 1;
    return Math.min(
      (size.width - 2 * MARGIN) / layoutSize.width,
      (size.height - 2 * MARGIN) / layoutSize.height,
    );
  }

  function kMin(size: { width: number; height: number }): number {
    return Math.max(K_MIN_FLOOR, Math.min(0.3, fitK(size)));
  }

  function applyCamera(): void {
    world.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
    world.style.setProperty("--office-inv", String(1 / k));
    const near = k > NEAR_K;
    root.classList.toggle("office--near", near);
    const showMap = near && (model?.totals.employees ?? 0) > 0;
    minimap.hidden = !showMap;
    if (showMap) drawMinimap();
    if (hover !== undefined) placeCard(hover);
  }

  function fitAll(): void {
    const size = stageSize();
    if (size.width <= 0 || size.height <= 0 || layoutSize.width === 0) {
      fit = true;
      focusRoom = undefined;
      return;
    }
    k = Math.max(kMin(size), Math.min(K_MAX, fitK(size)));
    tx = Math.round((size.width - layoutSize.width * k) / 2);
    ty = Math.round((size.height - layoutSize.height * k) / 2);
    fit = true;
    focusRoom = undefined;
    markDim();
    applyCamera();
  }

  function zoomAt(factor: number, px: number, py: number): void {
    const size = stageSize();
    const next = Math.max(kMin(size), Math.min(K_MAX, k * factor));
    const q = next / k;
    tx = px - (px - tx) * q;
    ty = py - (py - ty) * q;
    k = next;
    fit = false;
    focusRoom = undefined;
    markDim();
    applyCamera();
  }

  function zoomCentre(factor: number): void {
    const size = stageSize();
    zoomAt(factor, size.width / 2, size.height / 2);
  }

  function goToRoom(id: string): void {
    const node = rooms.get(id);
    if (node === undefined) return;
    const size = stageSize();
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    const roomK =
      size.width > 0 && size.height > 0
        ? Math.min(
            ROOM_FOCUS_K,
            (size.width / node.width) * 0.95,
            (size.height / node.height) * 0.95,
          )
        : ROOM_FOCUS_K;
    k = Math.max(kMin(size), Math.min(K_MAX, roomK));
    tx = Math.round(size.width / 2 - cx * k);
    ty = Math.round(size.height / 2 - cy * k);
    fit = false;
    focusRoom = id;
    markDim();
    applyCamera();
  }

  function markDim(): void {
    for (const node of rooms.values()) {
      const dim = focusRoom !== undefined && focusRoom !== node.id;
      node.element.classList.toggle("office-room--dim", dim);
      for (const seat of node.seats.values()) {
        seat.labels.classList.toggle("office-seat-labels--dim", dim);
      }
    }
    for (const [id, row] of rows) {
      row.element.classList.toggle("office-row--on", focusRoom === id);
    }
  }

  function ensureVisible(seat: SeatNode): void {
    const size = stageSize();
    if (size.width <= 0) return;
    const px = tx + seat.world.x * k;
    const py = ty + seat.world.y * k;
    const margin = 90;
    let dx = 0;
    let dy = 0;
    if (px < margin) dx = margin - px;
    else if (px > size.width - margin) dx = size.width - margin - px;
    if (py < margin) dy = margin - py;
    else if (py > size.height - margin) dy = size.height - margin - py;
    if (dx === 0 && dy === 0) return;
    tx += dx;
    ty += dy;
    fit = false;
    applyCamera();
  }

  // ---- the minimap --------------------------------------------------------

  function drawMinimap(): void {
    if (model === undefined || layoutSize.width === 0) return;
    const scale = Math.min(
      (MINIMAP_W - 2 * MINIMAP_PAD) / layoutSize.width,
      (MINIMAP_H - 2 * MINIMAP_PAD) / layoutSize.height,
    );
    for (const child of [...minimap.children]) {
      if (child !== minimapView && !rooms.has((child as HTMLElement).dataset["room"] ?? "")) {
        child.remove();
      }
    }
    for (const node of rooms.values()) {
      let tile = minimap.querySelector<HTMLElement>(`[data-room="${CSS.escape(node.id)}"]`);
      if (tile === null) {
        tile = html("div", "office-minimap__room");
        tile.dataset["room"] = node.id;
        minimap.insertBefore(tile, minimapView);
      }
      tile.style.left = `${MINIMAP_PAD + node.x * scale}px`;
      tile.style.top = `${MINIMAP_PAD + node.y * scale}px`;
      tile.style.width = `${node.width * scale}px`;
      tile.style.height = `${node.height * scale}px`;
      tile.classList.toggle("office-minimap__room--hand", node.room.hands > 0);
      tile.dataset["tint"] = String(tintOf(node.id));
    }
    const size = stageSize();
    minimapView.style.left = `${MINIMAP_PAD + (-tx / k) * scale}px`;
    minimapView.style.top = `${MINIMAP_PAD + (-ty / k) * scale}px`;
    minimapView.style.width = `${(size.width / k) * scale}px`;
    minimapView.style.height = `${(size.height / k) * scale}px`;
  }

  // ---- rooms and seats ----------------------------------------------------

  function floorSvg(room: OfficeRoom): SVGSVGElement {
    const g = room.geometry;
    const a = isoPoint(g, 0, 0);
    const b = isoPoint(g, g.cols, 0);
    const c = isoPoint(g, g.cols, g.rows);
    const d = isoPoint(g, 0, g.rows);
    const down = (p: { x: number; y: number }, h: number) => ({ x: p.x, y: p.y + h });
    const drawing = svg(
      "svg",
      {
        width: g.width,
        height: g.height,
        viewBox: `0 0 ${g.width} ${g.height}`,
        "aria-hidden": "true",
      },
      "office-floor",
    );
    drawing.append(
      svg(
        "polygon",
        { points: points([d, c, b, down(b, 14), down(c, 14), down(d, 14)]) },
        "of-base",
      ),
      svg("polygon", { points: points([a, b, c, d]) }, "of-floor"),
      svg("polygon", { points: points([d, a, down(a, -78), down(d, -78)]) }, "of-wall-a"),
      svg("polygon", { points: points([a, b, down(b, -78), down(a, -78)]) }, "of-wall-b"),
    );
    return drawing;
  }

  function seatCube(): SVGSVGElement {
    const drawing = svg(
      "svg",
      { width: SEAT_W, height: SEAT_H, viewBox: "0 0 200 150", "aria-hidden": "true" },
      "office-seat__cube",
    );
    drawing.append(
      svg("polygon", { points: "100,53 184,95 100,137 16,95" }, "os-mat"),
      svg("polygon", { points: "16,95 100,53 100,23 16,65" }, "os-wall-a"),
      svg("polygon", { points: "100,53 184,95 184,65 100,23" }, "os-wall-b"),
    );
    return drawing;
  }

  function seatDesk(): SVGSVGElement {
    const drawing = svg(
      "svg",
      { width: SEAT_W, height: SEAT_H, viewBox: "0 0 200 150", "aria-hidden": "true" },
      "office-seat__desk",
    );
    drawing.append(
      svg("polygon", { points: "100,89 146,112 100,135 54,112" }, "os-desk-top"),
      svg("polygon", { points: "54,112 100,135 100,149 54,126" }, "os-desk-a"),
      svg("polygon", { points: "100,135 146,112 146,126 100,149" }, "os-desk-b"),
      svg("rect", { x: 76, y: 90, width: 48, height: 26, rx: 4, "stroke-width": 1.5 }, "os-screen"),
    );
    return drawing;
  }

  function buildSeat(employee: OfficeEmployee, animateIn: boolean): SeatNode {
    const element = html("button", "office-seat");
    element.type = "button";
    element.dataset["key"] = employee.key;
    const hit = html("span", "office-seat__hit");
    hit.setAttribute("aria-hidden", "true");
    const worker = html("div", "office-seat__worker");
    const glyph = html("span", "office-seat__glyph mono");
    glyph.setAttribute("aria-hidden", "true");
    const labels = html("div", "office-seat-labels");
    const tag = html("span", "office-tag");
    labels.append(tag);
    element.append(hit, seatCube(), worker, seatDesk(), glyph);
    labelLayer.append(labels);
    const hash = hashOf(employee.key);
    element.style.setProperty("--ow-shirt", `var(--office-shirt-${hash % 6})`);
    element.style.setProperty("--ow-skin", `var(--office-skin-${(hash >>> 3) % 4})`);
    element.style.setProperty("--ow-hair", `var(--office-hair-${(hash >>> 5) % 4})`);
    if (animateIn) {
      element.classList.add("office-seat--in");
      labels.classList.add("office-seat-labels--in");
      later(() => {
        element.classList.remove("office-seat--in");
        labels.classList.remove("office-seat-labels--in");
      }, OFFICE_WALK_MS);
    }
    const node: SeatNode = {
      key: employee.key,
      element,
      worker,
      glyph,
      labels,
      tag,
      handBadge: undefined,
      bubble: undefined,
      pose: employee.pose,
      sig: "",
      employee,
      world: { x: 0, y: 0 },
    };
    worker.append(workerSvg(employee.pose));
    element.addEventListener("click", () => {
      if (suppressClick) return;
      open(node.employee.target);
    });
    // "Open in new window" / "Return to main window": a native menu, drawn by
    // the host, for an employee that is a tab (or a pane of one).
    const menuTab = (): string | undefined => {
      const target = node.employee.target;
      return target.type === "session" ? undefined : target.tabId;
    };
    element.addEventListener("contextmenu", (event) => {
      const tabId = menuTab();
      if (tabId === undefined || options.employeeMenu === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      options.employeeMenu(tabId, event.clientX, event.clientY);
    });
    element.addEventListener("keydown", (event) => {
      const tabId = menuTab();
      if (tabId === undefined || options.employeeMenu === undefined) return;
      const menuKey = event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
      if (!menuKey) return;
      event.preventDefault();
      event.stopPropagation();
      const box = element.getBoundingClientRect();
      options.employeeMenu(
        tabId,
        Math.round(box.left + box.width / 2),
        Math.round(box.top + box.height / 2),
      );
    });
    const show = (): void => showCard(node);
    const hide = (): void => hideCard(node);
    element.addEventListener("mouseenter", show);
    element.addEventListener("mouseleave", hide);
    element.addEventListener("focus", () => {
      show();
      ensureVisible(node);
    });
    element.addEventListener("blur", hide);
    return node;
  }

  function setPose(seat: SeatNode, pose: OfficePose): void {
    if (seat.pose === pose) return;
    for (const layer of seat.worker.querySelectorAll(".office-pose")) {
      layer.classList.add("office-pose--out");
      later(() => layer.remove(), POSE_FADE_MS);
    }
    const next = workerSvg(pose);
    next.classList.add("office-pose--in");
    seat.worker.append(next);
    later(() => next.classList.remove("office-pose--in"), POSE_FADE_MS);
    seat.pose = pose;
  }

  function updateSeat(
    node: RoomNode,
    seat: SeatNode,
    employee: OfficeEmployee,
    index: number,
  ): void {
    seat.employee = employee;
    const point = seatPoint(node.room.geometry, index);
    seat.world = { x: node.x + point.x, y: node.y + point.y };
    // The labels live in world coordinates, so they follow their room.
    seat.labels.style.left = `${seat.world.x - SEAT_W / 2}px`;
    seat.labels.style.top = `${seat.world.y - 95}px`;
    const sig = JSON.stringify([
      index,
      employee.pose,
      employee.kind,
      employee.label,
      employee.question,
      roomName(node.room),
      employee.glyph,
    ]);
    if (sig === seat.sig) return;
    seat.sig = sig;
    seat.element.style.left = `${point.x - SEAT_W / 2}px`;
    seat.element.style.top = `${point.y - 95}px`;
    seat.element.style.zIndex = String(Math.round(point.y / 4));
    seat.element.dataset["pose"] = employee.pose;
    seat.labels.dataset["pose"] = employee.pose;
    seat.element.setAttribute(
      "aria-label",
      MESSAGES.officeSeatLabel(
        employee.kind,
        employee.label,
        roomName(node.room),
        employee.pose,
        L,
      ),
    );
    seat.glyph.textContent = employee.glyph;
    seat.tag.textContent = `${MESSAGES.officeKind(employee.kind, L)}, ${MESSAGES.officePose(employee.pose, L)}`;
    setPose(seat, employee.pose);
    seat.element.classList.toggle("office-seat--hand", employee.pose === "hand");
    if (employee.pose === "hand") {
      if (seat.handBadge === undefined) {
        seat.handBadge = html("span", "office-hand");
        seat.bubble = html("span", "office-bubble");
        seat.handBadge.append(
          html("span", "office-hand__text", MESSAGES.officePose("hand", L)),
          seat.bubble,
        );
        seat.labels.append(seat.handBadge);
      }
      if (seat.bubble !== undefined) {
        seat.bubble.textContent = employee.question ?? "";
        seat.bubble.classList.toggle(
          "office-bubble--on",
          employee.question !== undefined && employee.question !== "",
        );
        seat.bubble.dir = "auto";
      }
    } else if (seat.handBadge !== undefined) {
      seat.handBadge.remove();
      seat.handBadge = undefined;
      seat.bubble = undefined;
    }
  }

  function buildRoom(room: OfficeRoom): RoomNode {
    const element = html("div", "office-room");
    element.dataset["room"] = room.id;
    const sign = html("button", "office-sign");
    sign.type = "button";
    const signLabel = html("span", "office-sign__label");
    const signName = html("span", "office-sign__name");
    signName.dir = "auto";
    const signCount = html("span", "office-sign__count mono");
    signLabel.append(signName, " ", signCount);
    const signHands = html("span", "office-sign__hands");
    sign.append(signLabel, signHands);
    const floor = floorSvg(room);
    element.append(floor, sign);
    const node: RoomNode = {
      id: room.id,
      element,
      sign,
      signName,
      signCount,
      signHands,
      floorKey: `${room.geometry.cols}x${room.geometry.rows}`,
      floor,
      seats: new Map(),
      room,
      x: 0,
      y: 0,
      width: room.geometry.width,
      height: room.geometry.height,
    };
    sign.addEventListener("click", () => goToRoom(room.id));
    world.insertBefore(element, labelLayer);
    return node;
  }

  function reconcile(next: OfficeModel, animate: boolean): void {
    const placed = worldLayout(next.rooms.map((room) => room.geometry));
    layoutSize = { width: placed.width, height: placed.height };
    world.style.width = `${placed.width}px`;
    world.style.height = `${placed.height}px`;
    const wanted = new Set(next.rooms.map((room) => room.id));
    for (const [id, node] of [...rooms]) {
      if (wanted.has(id)) continue;
      rooms.delete(id);
      node.element.classList.add("office-room--out");
      for (const seat of node.seats.values()) {
        seat.element.classList.add("office-seat--out");
        seat.labels.classList.add("office-seat-labels--out");
        later(() => seat.labels.remove(), OFFICE_WALK_MS);
      }
      later(() => node.element.remove(), OFFICE_WALK_MS);
    }
    next.rooms.forEach((room, roomIndex) => {
      let node = rooms.get(room.id);
      if (node === undefined) {
        node = buildRoom(room);
        rooms.set(room.id, node);
      }
      const place = placed.rooms[roomIndex];
      node.room = room;
      node.x = place?.x ?? 0;
      node.y = place?.y ?? 0;
      node.width = room.geometry.width;
      node.height = room.geometry.height;
      node.element.style.left = `${node.x}px`;
      node.element.style.top = `${node.y}px`;
      node.element.style.width = `${node.width}px`;
      node.element.style.height = `${node.height}px`;
      node.element.dataset["tint"] = String(tintOf(room.id));
      const floorKey = `${room.geometry.cols}x${room.geometry.rows}`;
      if (floorKey !== node.floorKey) {
        const floor = floorSvg(room);
        node.floor.replaceWith(floor);
        node.floor = floor;
        node.floorKey = floorKey;
      }
      const a = isoPoint(room.geometry, 0, 0);
      node.sign.style.left = `${a.x}px`;
      node.sign.style.top = `${a.y - 84}px`;
      node.signName.textContent = roomName(room);
      node.signCount.textContent = String(room.employees.length);
      node.signHands.textContent = room.hands > 0 ? MESSAGES.officeHandsText(room.hands, L) : "";
      node.signHands.hidden = room.hands === 0;
      node.sign.setAttribute(
        "aria-label",
        MESSAGES.officeRoomLabel(roomName(room), room.employees.length, room.hands, L),
      );

      const keep = new Set(room.employees.map((employee) => employee.key));
      for (const [key, seat] of [...node.seats]) {
        if (keep.has(key)) continue;
        node.seats.delete(key);
        if (hover === seat) hideCard(seat);
        seat.element.classList.add("office-seat--out");
        seat.element.disabled = true;
        seat.labels.classList.add("office-seat-labels--out");
        later(() => {
          seat.element.remove();
          seat.labels.remove();
        }, OFFICE_WALK_MS);
      }
      room.employees.forEach((employee, index) => {
        let seat = node.seats.get(employee.key);
        if (seat === undefined) {
          seat = buildSeat(employee, animate);
          node.seats.set(employee.key, seat);
        }
        updateSeat(node, seat, employee, index);
      });
      // DOM order is tab order: the sign, then the room's employees in order.
      let cursor: ChildNode | null = node.sign.nextSibling;
      for (const employee of room.employees) {
        const seat = node.seats.get(employee.key);
        if (seat === undefined) continue;
        if (seat.element === cursor) cursor = cursor.nextSibling;
        else node.element.insertBefore(seat.element, cursor);
      }
    });
    // Rooms in model order.
    let cursor: ChildNode | null = world.firstChild;
    for (const room of next.rooms) {
      const node = rooms.get(room.id);
      if (node === undefined) continue;
      if (node.element === cursor) cursor = cursor.nextSibling;
      else world.insertBefore(node.element, cursor);
    }
    if (hover !== undefined) {
      hover = [...rooms.values()].flatMap((r) => [...r.seats.values()]).find((s) => s === hover);
      if (hover === undefined) hideCard(undefined);
    }
  }

  // ---- the sidebar and the bar --------------------------------------------

  function rowFor(id: string, closed: boolean): RowNode {
    let row = rows.get(id);
    if (row === undefined) {
      const element = html("button", "office-row");
      element.type = "button";
      const swatch = html("span", "office-row__swatch");
      const name = html("span", "office-row__name");
      name.dir = "auto";
      const count = html("span", "office-row__count mono");
      const hands = html("span", "office-row__hands");
      element.append(swatch, name, count, hands);
      row = { element, swatch, name, count, hands };
      rows.set(id, row);
      element.addEventListener("click", () => {
        if (!closed) goToRoom(id);
      });
    }
    return row;
  }

  function renderSidebar(next: OfficeModel): void {
    const order = [...next.rooms]
      .map((room, index) => ({ room, index }))
      .sort(
        (a, b) =>
          b.room.hands - a.room.hands ||
          b.room.employees.length - a.room.employees.length ||
          a.index - b.index,
      );
    const wanted = new Set<string>();
    const sequence: HTMLElement[] = [];
    for (const { room } of order) {
      wanted.add(room.id);
      const row = rowFor(room.id, false);
      row.element.disabled = false;
      row.element.classList.remove("office-row--closed");
      row.element.dataset["tint"] = String(tintOf(room.id));
      row.name.textContent = roomName(room);
      row.count.textContent = String(room.employees.length);
      row.hands.textContent = room.hands > 0 ? MESSAGES.officeHandsText(room.hands, L) : "";
      row.hands.hidden = room.hands === 0;
      sequence.push(row.element);
    }
    for (const name of next.closed) {
      const id = `closed:${name}`;
      wanted.add(id);
      const row = rowFor(id, true);
      row.element.disabled = true;
      row.element.classList.add("office-row--closed");
      row.element.dataset["tint"] = "closed";
      row.name.textContent = name;
      row.count.textContent = MESSAGES.officeClosedWord(L);
      row.hands.textContent = "";
      row.hands.hidden = true;
      sequence.push(row.element);
    }
    for (const [id, row] of [...rows]) {
      if (wanted.has(id)) continue;
      row.element.remove();
      rows.delete(id);
    }
    let cursor: ChildNode | null = list.firstChild;
    for (const element of sequence) {
      if (element === cursor) cursor = cursor.nextSibling;
      else list.insertBefore(element, cursor);
    }
  }

  function renderBar(next: OfficeModel): void {
    $("office-summary").textContent = MESSAGES.officeSummary(
      next.totals.employees,
      next.totals.open,
      next.totals.closed,
      L,
    );
    const pill = $("office-hands");
    pill.textContent = next.totals.hands > 0 ? MESSAGES.officeHandsPill(next.totals.hands, L) : "";
    pill.hidden = next.totals.hands === 0;
  }

  // ---- the hover card -----------------------------------------------------

  function cardRow(label: string, value: string, className?: string): HTMLElement {
    const row = html("div", "office-card__row");
    row.append(html("span", "office-card__label", label));
    const text = html("span", className ?? "office-card__value", value);
    text.dir = "auto";
    row.append(text);
    return row;
  }

  function showCard(seat: SeatNode): void {
    hover = seat;
    const employee = seat.employee;
    const project = employee.project === null ? MESSAGES.officeLounge(L) : employee.project;
    card.replaceChildren();
    const head = html("div", "office-card__head");
    head.append(html("strong", "office-card__name", MESSAGES.officeKind(employee.kind, L)));
    const state = html(
      "span",
      `office-card__state office-card__state--${employee.pose}`,
      MESSAGES.officePose(employee.pose, L),
    );
    head.append(state);
    card.append(head);
    const label = html("div", "office-card__title", employee.label);
    label.dir = "auto";
    card.append(label);
    if (employee.doing !== undefined && employee.doing !== "") {
      // The line is the agent's current work only while it is busy; once it
      // is idle (or asking) it is just the last thing it did.
      const doingLabel =
        employee.pose === "typing" ? MESSAGES.officeCardDoing(L) : MESSAGES.officeCardLast(L);
      card.append(cardRow(doingLabel, employee.doing, "office-card__doing mono"));
    }
    if (employee.question !== undefined && employee.question !== "") {
      card.append(
        cardRow(MESSAGES.officeCardQuestion(L), employee.question, "office-card__question"),
      );
    }
    card.append(cardRow(MESSAGES.officeCardProject(L), project));
    const who = [employee.agent, employee.model].filter(
      (part) => part !== undefined && part !== "",
    );
    if (who.length > 0) card.append(cardRow(MESSAGES.officeCardAgent(L), who.join(" · ")));
    if (employee.branch !== undefined) {
      card.append(
        cardRow(MESSAGES.officeCardBranch(L), employee.branch, "office-card__value mono"),
      );
    }
    if (employee.diff !== undefined) {
      const files = employee.diff.files === undefined ? "" : `, ${employee.diff.files}`;
      card.append(
        cardRow(
          MESSAGES.officeCardChanges(L),
          `+${employee.diff.added} −${employee.diff.removed}${files}`,
          "office-card__value mono",
        ),
      );
    }
    if (employee.lastActivityAt !== undefined) {
      card.append(
        cardRow(MESSAGES.officeCardLastActive(L), formatAgo(employee.lastActivityAt, now(), L)),
      );
    }
    const hint =
      employee.target.type === "session"
        ? MESSAGES.officeCardOpenSession(L)
        : employee.target.type === "pane"
          ? MESSAGES.officeCardOpenPane(L)
          : MESSAGES.officeCardOpenTab(L);
    card.append(html("span", "office-card__hint", hint));
    card.hidden = false;
    card.id = "office-card";
    seat.element.setAttribute("aria-describedby", "office-card");
    placeCard(seat);
  }

  function placeCard(seat: SeatNode): void {
    const size = stageSize();
    const sx = tx + seat.world.x * k;
    const sy = ty + seat.world.y * k;
    const off = (SEAT_W / 2) * k * 0.9 + 10;
    const flip = sx + off + CARD_W > size.width - 8;
    const left = flip ? sx - off - CARD_W : sx + off;
    const top = Math.max(8, Math.min(sy - 70, Math.max(8, size.height - 200)));
    card.style.left = `${Math.max(8, left)}px`;
    card.style.top = `${top}px`;
  }

  function hideCard(seat: SeatNode | undefined): void {
    if (seat !== undefined && hover !== undefined && hover !== seat) return;
    seat?.element.removeAttribute("aria-describedby");
    hover = undefined;
    card.hidden = true;
  }

  // ---- drawing ------------------------------------------------------------

  function draw(next: OfficeModel): void {
    renderBar(next);
    renderSidebar(next);
    const none = next.totals.employees === 0;
    empty.hidden = !none;
    world.hidden = none;
    zoomBox.hidden = none;
    reconcile(next, drawn);
    drawn = true;
    markDim();
    if (fit) fitAll();
    else applyCamera();
  }

  const zoomBox = $("office-zoom");

  function update(next: OfficeModel): void {
    model = next;
    if (disposed) return;
    if (!isVisible()) {
      held = true;
      return;
    }
    held = false;
    draw(next);
  }

  function show(): void {
    if (disposed || model === undefined) return;
    if (held || !drawn) {
      held = false;
      draw(model);
      return;
    }
    // The stage had no size while hidden: fit again once it has one.
    if (fit) fitAll();
    else applyCamera();
  }

  // ---- input --------------------------------------------------------------

  let suppressClick = false;
  const pointers = new Map<number, { x: number; y: number }>();
  let drag:
    | { x: number; y: number; tx: number; ty: number; moved: boolean; id: number }
    | undefined;
  let pinch: { distance: number } | undefined;

  function localPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function pinchDistance(): { distance: number; x: number; y: number } | undefined {
    const [a, b] = [...pointers.values()];
    if (a === undefined || b === undefined) return undefined;
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  stage.addEventListener("pointerdown", (event) => {
    const id = (event as PointerEvent).pointerId ?? 0;
    pointers.set(id, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      drag = undefined;
      const now2 = pinchDistance();
      pinch = now2 === undefined ? undefined : { distance: now2.distance };
      return;
    }
    if (event.button !== undefined && event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, tx, ty, moved: false, id };
  });
  stage.addEventListener("pointermove", (event) => {
    const id = (event as PointerEvent).pointerId ?? 0;
    if (pointers.has(id)) pointers.set(id, { x: event.clientX, y: event.clientY });
    if (pinch !== undefined) {
      const next = pinchDistance();
      if (next === undefined || pinch.distance === 0) return;
      const rect = stage.getBoundingClientRect();
      zoomAt(next.distance / pinch.distance, next.x - rect.left, next.y - rect.top);
      pinch = { distance: next.distance };
      return;
    }
    if (drag === undefined || event.buttons !== 1) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) < DRAG_PX) return;
      drag.moved = true;
      world.classList.add("office-world--drag");
      stage.classList.add("office-stage--drag");
      try {
        stage.setPointerCapture?.(id);
      } catch {
        // Not every pointer can be captured; the drag still follows the moves.
      }
      hideCard(undefined);
    }
    tx = drag.tx + dx;
    ty = drag.ty + dy;
    fit = false;
    focusRoom = undefined;
    markDim();
    applyCamera();
  });
  const endPointer = (event: Event): void => {
    const id = (event as PointerEvent).pointerId ?? 0;
    pointers.delete(id);
    if (pointers.size < 2) pinch = undefined;
    if (drag !== undefined && drag.id === id) {
      if (drag.moved) {
        // The click that follows a drag is not a choice.
        suppressClick = true;
        later(() => {
          suppressClick = false;
        }, 0);
      }
      drag = undefined;
      world.classList.remove("office-world--drag");
      stage.classList.remove("office-stage--drag");
    }
  };
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", endPointer);
  stage.addEventListener("pointerleave", endPointer);
  // Non-passive, on the stage only: it must cancel the page's own scroll.
  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const point = localPoint(event);
      const sensitivity = event.ctrlKey ? 0.01 : 0.002;
      zoomAt(Math.exp(-event.deltaY * sensitivity), point.x, point.y);
    },
    { passive: false },
  );
  stage.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = 60;
    switch (event.key) {
      case "+":
      case "=":
        zoomCentre(1.3);
        break;
      case "-":
        zoomCentre(1 / 1.3);
        break;
      case "0":
        fitAll();
        break;
      case "ArrowLeft":
        tx += step;
        break;
      case "ArrowRight":
        tx -= step;
        break;
      case "ArrowUp":
        ty += step;
        break;
      case "ArrowDown":
        ty -= step;
        break;
      default:
        return;
    }
    if (event.key.startsWith("Arrow")) {
      fit = false;
      applyCamera();
    }
    event.preventDefault();
  });

  $("office-home").addEventListener("click", () => fitAll());
  $("office-zoom-in").addEventListener("click", () => zoomCentre(1.3));
  $("office-zoom-out").addEventListener("click", () => zoomCentre(1 / 1.3));
  $("office-empty-open").addEventListener("click", () => options.openTab());

  const onVisibility = (): void => {
    root.classList.toggle("office--paused", document.visibilityState === "hidden");
  };
  document.addEventListener("visibilitychange", onVisibility);
  onVisibility();

  return {
    update,
    show,
    fitAll,
    zoomIn: () => zoomCentre(1.3),
    zoomOut: () => zoomCentre(1 / 1.3),
    view: () => ({ k, tx, ty, fit }),
    dispose() {
      disposed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

// ---- the feed ---------------------------------------------------------------

export type OfficeFeedOptions = OfficeViewOptions & {
  api: Pick<RendererApi, "officeActivity" | "onOfficeChanged">;
  /** Terminal tabs whose shell this window knows runs a command. */
  running(): ReadonlySet<string>;
  /** The raised-hands count, for the nav badge — also while the route is hidden. */
  onHands(count: number): void;
  /** How often to re-read what only this window knows (running shells, ended sessions). */
  tickMs?: number;
};

export type Office = {
  setProjects(projects: readonly string[]): void;
  setWorkspace(state: WorkspaceState): void;
  setSessions(sessions: readonly Session[]): void;
  /** The route was just shown. */
  show(): void;
  dispose(): void;
};

/**
 * Joins the four inputs (projects, workspace tabs, sessions, what main read
 * off the agents' screens) into the model and hands it to the view. The model
 * is cheap and pure, so it is rebuilt while the route is hidden too — the nav
 * badge needs the hands count — but the view does no DOM work then.
 */
export function initOffice(options: OfficeFeedOptions): Office {
  const view = createOfficeView(options);
  const now = options.now ?? (() => Date.now());
  let projects: readonly string[] = [];
  let workspace: WorkspaceState = { tabs: [], activeTabId: undefined };
  let sessions: readonly Session[] = [];
  let activity: OfficeActivity = EMPTY_OFFICE_ACTIVITY;
  let hands = -1;
  let queued = false;
  let pulling = false;
  let pullAgain = false;
  let disposed = false;

  function rebuild(): void {
    queued = false;
    if (disposed) return;
    const model = buildOffice({
      projects,
      workspace,
      sessions,
      activity,
      runningTabs: options.running(),
      now: now(),
    });
    if (model.totals.hands !== hands) {
      hands = model.totals.hands;
      options.onHands(hands);
    }
    view.update(model);
  }

  function schedule(): void {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(rebuild);
  }

  async function pull(): Promise<void> {
    if (pulling) {
      pullAgain = true;
      return;
    }
    pulling = true;
    try {
      activity = await options.api.officeActivity();
      schedule();
    } catch {
      // The floor keeps what it had; the next push asks again.
    } finally {
      pulling = false;
      if (pullAgain && !disposed) {
        pullAgain = false;
        void pull();
      }
    }
  }

  options.api.onOfficeChanged(() => void pull());
  void pull();
  const tick = setInterval(() => {
    if (document.visibilityState === "visible") schedule();
  }, options.tickMs ?? 3000);

  return {
    setProjects(next) {
      projects = next;
      schedule();
    },
    setWorkspace(next) {
      workspace = next;
      schedule();
    },
    setSessions(next) {
      sessions = next;
      schedule();
    },
    show() {
      rebuild();
      view.show();
      void pull();
    },
    dispose() {
      disposed = true;
      clearInterval(tick);
      view.dispose();
    },
  };
}
