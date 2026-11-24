import type { WorkspaceState, WorkspaceTab } from "@jarvis/core";
import type { RendererApi } from "../src/ipc.js";
import { plainTerminalState, type PopoutTerminalState } from "../src/popout-state.js";
import {
  focusTerminalLeaf,
  initWorkspaceTerminals,
  renderWorkspaceTerminals,
  stageTerminalCarry,
  terminalCarry,
} from "./workspace-terminal.js";

// The pop-out page (popout.html): a minimal second renderer that draws ONE
// terminal tab in a window of its own, with the existing terminal modules.
//
// It starts none of the main app's services — no voice, prayer, dashboard,
// updater, Office or hosted-view bookkeeping — and never calls what would
// move the main window's pages or tab state (activate, bounds, visibility;
// popout.test.ts holds that as a source check). The host is the only party
// that decides which window owns the tab: this page is told its tab id on
// its launch arguments, asks `popout:ready` what it starts from, and hands
// its layout and unsent command-editor text back — when asked, as it changes,
// and as the page goes away (a reload keeps typed text).
//
// One owner sizes the pty: this window. The main window has disposed its
// panes for the tab, so nothing else sends a resize for it.

const REPORT_MS = 1000;

export type PopoutTerminals = {
  init(): void;
  render(tabs: WorkspaceTab[], activeTabId: string, project: string): void;
  carry(tabId: string): PopoutTerminalState;
  stage(tabId: string, state: PopoutTerminalState): void;
  focusLeaf(paneKey: string): void;
};

const REAL_TERMINALS: PopoutTerminals = {
  init: initWorkspaceTerminals,
  render: (tabs, activeTabId, project) => renderWorkspaceTerminals(tabs, activeTabId, project),
  carry: terminalCarry,
  stage: stageTerminalCarry,
  focusLeaf: focusTerminalLeaf,
};

type Api = Pick<
  RendererApi,
  | "popoutTabId"
  | "popoutReady"
  | "popoutReportState"
  | "popoutHandedOver"
  | "workspaceSnapshot"
  | "onWorkspace"
  | "onPopoutHandover"
  | "onPopoutFocusPane"
>;

export async function startPopout(
  api: Api,
  terminals: PopoutTerminals = REAL_TERMINALS,
): Promise<void> {
  const tabId = api.popoutTabId;
  if (tabId === undefined) return;
  let ready: Awaited<ReturnType<Api["popoutReady"]>>;
  let snapshot: WorkspaceState;
  try {
    ready = await api.popoutReady();
    snapshot = await api.workspaceSnapshot();
  } catch {
    return;
  }
  // The host answers only for the tab it opened this window for.
  if (ready === undefined || ready.tabId !== tabId) return;
  const own = (state: WorkspaceState): WorkspaceTab | undefined =>
    state.tabs.find((tab) => tab.id === tabId);
  const first = own(snapshot);
  if (first === undefined) return;

  terminals.init();
  // The carried layout and drafts, before the pane is built: its panes attach
  // to the shells they had and the text is put back in their editors.
  if (
    ready.state !== undefined &&
    JSON.stringify(ready.state) !== JSON.stringify(plainTerminalState(tabId))
  ) {
    terminals.stage(tabId, ready.state);
  }
  const draw = (tab: WorkspaceTab): void => terminals.render([tab], tab.id, tab.project);
  draw(first);

  api.onWorkspace((state) => {
    const tab = own(state);
    // Its tab gone: the host is closing this window; draw nothing more.
    if (tab !== undefined) draw(tab);
  });

  api.onPopoutHandover((id) => {
    if (id !== tabId) return;
    void Promise.resolve(api.popoutHandedOver(tabId, terminals.carry(tabId))).catch(
      () => undefined,
    );
  });
  api.onPopoutFocusPane((paneKey) => terminals.focusLeaf(paneKey));

  // The host keeps the last state reported, for a return the renderer cannot
  // answer (it crashed, it is reloading, it is slow): so changes go up.
  let reported = JSON.stringify(ready.state ?? plainTerminalState(tabId));
  const report = (): void => {
    try {
      const state = terminals.carry(tabId);
      const text = JSON.stringify(state);
      if (text === reported) return;
      reported = text;
      void Promise.resolve(api.popoutReportState(state)).catch(() => undefined);
    } catch {
      // The page is going away.
    }
  };
  const timer = setInterval(report, REPORT_MS);
  const goodbye = (): void => {
    report();
    clearInterval(timer);
    window.removeEventListener("pagehide", goodbye);
  };
  window.addEventListener("pagehide", goodbye);
}

// The page's own start: only in a window the host opened as a pop-out.
if (typeof window !== "undefined" && window.jarvis?.popoutTabId !== undefined) {
  void startPopout(window.jarvis);
}
