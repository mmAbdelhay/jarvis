// Types for the pure builder in terminal-html.mjs. Plain .mjs (not .ts) so
// it runs directly under Node with no build step — this file is its type
// annotation for editors and for terminal-html.test.ts.

export type TerminalHtmlInputs = {
  xtermJs: string;
  fitJs: string;
  unicode11Js: string;
  xtermCss: string;
  pageJs: string;
  theme: Record<string, string>;
  fontFamily: string;
  scrollback: number;
  fontSize: number;
};

export type TerminalHtmlOutput = {
  html: string;
  scriptSha256: string;
};

export function buildTerminalHtml(inputs: TerminalHtmlInputs): TerminalHtmlOutput;

export function wrapVendorModule(
  source: string,
  exportName: "Terminal" | "FitAddon" | "Unicode11Addon",
): string;

export function sha256Hex(text: string): string;
