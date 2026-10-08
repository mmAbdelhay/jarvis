// What the terminal screen's header and pane chips show. The laptop names a
// tab, not a pane, so a pane is "Pane {n}" by its place in the inventory.
import type { MobileWorkspaceTab, TerminalPaneInfo } from "@jarvis/wire";

/** The header title: the tab's own (or renamed) title, else the pane key. */
export function terminalTitle(
  tab: Pick<MobileWorkspaceTab, "title"> | undefined,
  paneKey: string,
): string {
  const title = tab?.title.trim();
  return title === undefined || title === "" ? paneKey : title;
}

export type PaneChip = {
  paneKey: string;
  /** 1-based place in the inventory, for the "Pane {n}" label. */
  number: number;
  current: boolean;
  exited: boolean;
};

export function paneChips(panes: readonly TerminalPaneInfo[], current: string): PaneChip[] {
  return panes.map((pane, index) => ({
    paneKey: pane.paneKey,
    number: index + 1,
    current: pane.paneKey === current,
    exited: pane.exited,
  }));
}
