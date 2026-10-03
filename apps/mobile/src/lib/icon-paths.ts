// Icon geometry for the phone UI, copied from the design mockups' inline
// SVGs. Pure data: components/Icon.tsx draws it with react-native-svg.
export type IconShape =
  | { kind: "path"; attrs: { d: string } }
  | { kind: "circle"; attrs: { cx: number; cy: number; r: number } }
  | { kind: "rect"; attrs: { x: number; y: number; width: number; height: number; rx: number } }
  | { kind: "ellipse"; attrs: { cx: number; cy: number; rx: number; ry: number } };

export type IconSpec = {
  /** Default "0 0 24 24". */
  viewBox?: string;
  /** Default 2. */
  strokeWidth?: number;
  /** Painted with the colour and no stroke, instead of stroked. */
  fill?: boolean;
  /** Flips horizontally in a right-to-left layout (it points along the reading direction). */
  mirror?: boolean;
  shapes: readonly IconShape[];
};

const path = (d: string): IconShape => ({ kind: "path", attrs: { d } });
const circle = (cx: number, cy: number, r: number): IconShape => ({
  kind: "circle",
  attrs: { cx, cy, r },
});

export const ICONS = {
  brand: {
    strokeWidth: 2.4,
    shapes: [circle(12, 12, 4), path("M12 2v3M12 19v3M2 12h3M19 12h3")],
  },
  settings: {
    shapes: [
      circle(12, 12, 3),
      path(
        "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
      ),
    ],
  },
  home: { shapes: [path("M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z")] },
  sessions: { shapes: [path("M4 6h16M4 12h16M4 18h10")] },
  mic: {
    strokeWidth: 2.2,
    shapes: [
      { kind: "rect", attrs: { x: 9, y: 3, width: 6, height: 11, rx: 3 } },
      path("M5 11a7 7 0 0 0 14 0M12 18v3"),
    ],
  },
  workspace: {
    shapes: [
      { kind: "rect", attrs: { x: 3, y: 4, width: 18, height: 16, rx: 2 } },
      path("M3 9h18M8 4v5"),
    ],
  },
  changes: {
    shapes: [
      circle(6, 6, 2.5),
      circle(6, 18, 2.5),
      circle(18, 12, 2.5),
      path("M6 8.5v7M8.3 7.2l7.4 3.6"),
    ],
  },
  plus: { strokeWidth: 2.6, shapes: [path("M12 5v14M5 12h14")] },
  search: { shapes: [circle(11, 11, 7), path("M20 20l-3.5-3.5")] },
  chevronDown: { strokeWidth: 2.2, shapes: [path("M6 9l6 6 6-6")] },
  chevronUp: { strokeWidth: 2.2, shapes: [path("M6 15l6-6 6 6")] },
  back: { strokeWidth: 2.2, mirror: true, shapes: [path("M15 18l-6-6 6-6")] },
  more: { fill: true, shapes: [circle(5, 12, 1.8), circle(12, 12, 1.8), circle(19, 12, 1.8)] },
  send: { strokeWidth: 2.4, mirror: true, shapes: [path("M5 12h14M13 6l6 6-6 6")] },
  branch: {
    strokeWidth: 2.2,
    shapes: [
      circle(6, 6, 2.5),
      circle(6, 18, 2.5),
      circle(18, 8, 2.5),
      path("M6 8.5v7M18 10.5c0 4-6 3-10 6"),
    ],
  },
  terminal: { shapes: [path("M4 17l6-5-6-5M12 19h8")] },
  database: {
    shapes: [
      { kind: "ellipse", attrs: { cx: 12, cy: 6, rx: 7, ry: 3 } },
      path("M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"),
    ],
  },
  pencil: { shapes: [path("M4 20h4L19 9l-4-4L4 16z")] },
  close: { strokeWidth: 2.2, shapes: [path("M6 6l12 12M18 6L6 18")] },
  file: {
    shapes: [path("M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"), path("M14 3v5h5")],
  },
  fileNew: {
    shapes: [
      path("M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"),
      path("M14 3v5h5M12 11v6M9 14h6"),
    ],
  },
  folder: {
    shapes: [path("M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z")],
  },
  folderNew: {
    shapes: [
      path("M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"),
      path("M12 11v5M9.5 13.5h5"),
    ],
  },
  folderFilled: {
    fill: true,
    shapes: [path("M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z")],
  },
  check: { strokeWidth: 3.4, shapes: [path("M5 12l5 5 9-10")] },
  arrowDown: { strokeWidth: 2.6, shapes: [path("M12 5v14M6 13l6 6 6-6")] },
} as const satisfies Record<string, IconSpec>;

export type IconName = keyof typeof ICONS;
