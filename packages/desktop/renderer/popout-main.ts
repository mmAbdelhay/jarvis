import type { RendererApi } from "../src/ipc.js";
import type { PopoutTerminalState } from "../src/popout-state.js";
import type { OfficeTarget } from "./office-model.js";
import { initPopped } from "./popped.js";

/**
 * The main window's half of a pop-out. Opening: the host asks for a terminal
 * tab's layout and unsent text before anything moves, and is answered from the
 * panes as they are now. Returning: what the pop-out carried back is taken and
 * staged for the tab's next pane before the tab counts as back (popped.ts).
 */
export async function initMainPopouts(
  api: Pick<
    RendererApi,
    | "popoutList"
    | "onPopoutChanged"
    | "onPopoutHandover"
    | "popoutHandedOver"
    | "popoutTakeReturned"
  >,
  terminals: {
    carry(tabId: string): PopoutTerminalState;
    stage(tabId: string, state: PopoutTerminalState): void;
  },
): Promise<void> {
  try {
    api.onPopoutHandover((tabId) => {
      void Promise.resolve(api.popoutHandedOver(tabId, terminals.carry(tabId))).catch(
        () => undefined,
      );
    });
  } catch {
    // A host without pop-outs never asks.
  }
  await initPopped(api, async (tabId) => {
    const state = await api.popoutTakeReturned(tabId);
    if (state !== undefined) terminals.stage(tabId, state);
  });
}

/** An Office employee of a tab that is shown in another window brings that
 *  window forward (on the pane that asked). True when it did. */
export function focusPopped(
  api: Pick<RendererApi, "popoutFocus">,
  target: OfficeTarget,
  popped: (tabId: string) => boolean,
): boolean {
  if (target.type === "session" || !popped(target.tabId)) return false;
  try {
    void Promise.resolve(
      api.popoutFocus(target.tabId, target.type === "pane" ? target.paneKey : undefined),
    ).catch(() => undefined);
  } catch {
    // A host without pop-outs.
  }
  return true;
}

/** The tab ids and session id this window shows, for the host's "viewed"
 *  check. A tab shown in another window is viewed there: that window reports
 *  it, and the host counts it only while that window has the focus. */
export function viewingKeys(input: {
  view: string;
  activeTabId?: string | undefined;
  sessionId?: string | undefined;
  popped: (tabId: string) => boolean;
}): string[] {
  if (input.view === "workspace") {
    return input.activeTabId !== undefined && !input.popped(input.activeTabId)
      ? [input.activeTabId]
      : [];
  }
  if (input.view === "session") return input.sessionId === undefined ? [] : [input.sessionId];
  return [];
}
