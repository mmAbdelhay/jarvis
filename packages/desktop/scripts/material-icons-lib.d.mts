export function plainFileName(name: unknown): boolean;
export function checkSvg(text: unknown): { ok: true } | { ok: false; reason: string };
export function vendorIcons(paths: { from: string; to: string }): {
  icons: number;
  version: string;
};
