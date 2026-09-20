// Types for terminal-inputs.mjs (fix round 1, M5).

export const FONT_SIZE: number;

export function stripPageController(source: string): string;

export type TerminalInputs = {
  xtermJs: string;
  fitJs: string;
  unicode11Js: string;
  xtermCss: string;
  pageJs: string;
  theme: Record<string, string>;
  fontFamily: string;
  scrollback: number;
  fontSize: number;
  raw: {
    xtermJs: string;
    fitJs: string;
    unicode11Js: string;
    xtermCss: string;
    themeSource: string;
    pageSource: string;
  };
};

export function readTerminalInputs(): Promise<TerminalInputs>;
