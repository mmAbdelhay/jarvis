import type { WorkspaceTab } from "@jarvis/core";
import { LOGIN_TERMINAL_DETAIL } from "../src/login-terminal.js";
import { MESSAGES, PRIMARY_LANGUAGE, type MessageKey } from "../src/messages.js";
import { enhanceTerminal, handleSplitKey, type SplitKeys } from "./terminal-addons.js";
import { attachCompletion, type Completion } from "./terminal-completion.js";
import { createTerminalExplorer, type TerminalExplorer } from "./terminal-explorer.js";
import { hostPlatform } from "./keys.js";
import { createPlanPanel, type PlanPanel } from "./plan-panel.js";
import { createPane, type TerminalPane } from "./terminal-pane.js";
import { createSplitTree, type SplitTree } from "./terminal-splits.js";

// The Workspace's Terminal tabs.
//
// A terminal tab has no hosted view (see TabHost.openTerminal): its
// shell runs under a pty in the main process and its screen is drawn right
// here, in the renderer's own DOM, over the same slot a hosted page would
// occupy. One tree of panes per tab, kept alive for as long as the tab is —
// so switching tabs is showing and hiding elements, not replaying a stream,
// and scrollback survives without anyone having to store it.
//
// A tab holds a tree rather than a single pane because a tab can be split
// (see terminal-splits.ts). Every leaf is a whole pane with a shell of its
// own, keyed "<tabId>:<paneId>" — and a tab nobody has split is one leaf
// keyed by the bare tab id, which is exactly what it was before splits
// existed, down to the shell key.

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

/** The outer element belongs to the Workspace — one per tab, shown and
 *  hidden as tabs change — and the tree is what draws inside it.
 *
 *  Task 8: `planPanel` is one per tab too, the split tree's right sibling.
 *  `sessionPlanPath` is this tab's most recently resolved "session" plan
 *  (undefined until the first successful plansList answers) — what a
 *  `plans:changed` push compares its own path against to decide whether a
 *  closed panel should auto-open; `sessionPlanTimer` is the pending,
 *  per-tab debounce for the plansList call that keeps it fresh.
 *
 *  Fix round 1: `sessionPlanRequestId` guards a debounced lookup's own
 *  async answer — bumped every time one actually fires, so a stale
 *  response (clearTimeout only cancels a timer that has not fired yet,
 *  never an in-flight promise) is discarded rather than overwriting a
 *  newer one. `focusedPaneKey`/`focusedCwd` are the focused pane's own key
 *  and last-known cwd, kept here (not only in ensurePane's own closure) so
 *  a `plans:changed` push can schedule a *fresh* lookup of its own — a
 *  foreground process like `claude` never re-emits OSC 7, so the cached
 *  `sessionPlanPath` can be stale exactly when a plan just changed.
 *  `dismissedPlanPath` is the session plan path the user last closed the
 *  panel on purpose for (controller ruling): auto-open is suppressed for
 *  that exact path until a *different* session plan resolves. */
type Pane = {
  element: HTMLElement;
  tree: SplitTree;
  explorer: TerminalExplorer;
  planPanel: PlanPanel;
  sessionPlanPath: string | undefined;
  sessionPlanTimer: ReturnType<typeof setTimeout> | undefined;
  sessionPlanRequestId: number;
  focusedPaneKey: string | undefined;
  focusedCwd: string | undefined;
  dismissedPlanPath: string | undefined;
  /** The tab's own visible way to the plan panel: pressed while it is
   *  open, marked while `sessionPlanPath` names a plan. */
  planToggle: HTMLButtonElement;
};

/** The one place `sessionPlanPath` is written, so the toggle button's
 *  "this session has a plan" mark can never drift from it. */
function setSessionPlanPath(pane: Pane, path: string | undefined): void {
  pane.sessionPlanPath = path;
  pane.planToggle.classList.toggle("plan-toggle--has-plan", path !== undefined);
}

/** Which shell each pane is drawing. A WeakMap rather than a lookup table
 *  the tree would have to keep in step: a pane that has been closed is
 *  simply no longer among `tree.panes()`, so a key can never resolve to a
 *  pane that is gone. */
const paneKeys = new WeakMap<TerminalPane, string>();

/** How many commands the command editor's arrows may walk back through.
 *  Long enough to reach this morning's command, short enough that a prompt
 *  costs one small read. */
const HISTORY_LIMIT = 200;

const panes = new Map<string, Pane>();

// ------------------------------------------------------------- Plan panel

/** Adapts plan-panel.ts's `t: (key: MessageKey) => string` to this app's
 *  own bilingual MESSAGES table — every key the panel ever calls this with
 *  (messages.ts's own "plan*" group) takes just a language, so the cast is
 *  sound for every call this module makes, even though MessageKey itself
 *  spans MESSAGES entries of other arities too. */
function planPanelT(key: MessageKey): string {
  return (MESSAGES[key] as (language: "ar" | "en") => string)(PRIMARY_LANGUAGE);
}

/** How long a cwd/focus change waits, per tab, before re-asking main which
 *  plan (if any) this tab's own session currently names — the debounce
 *  spec rule 3 asks for, so a burst of prompts from a fast-running script
 *  costs one plansList call rather than one per prompt. */
const SESSION_PLAN_DEBOUNCE_MS = 300;

/** Clamps a plan panel's width to 300px…60% of `containerWidth` (spec
 *  rule 2). `containerWidth <= 0` — no real layout yet, which is every
 *  jsdom test and the first paint before the tab's own box has a size —
 *  drops the upper bound rather than clamping against a width that is not
 *  really zero. */
export function clampPlanPanelWidth(width: number, containerWidth: number): number {
  const max = containerWidth > 0 ? containerWidth * 0.6 : Number.POSITIVE_INFINITY;
  return Math.min(max, Math.max(300, width));
}

function planPanelWidthKey(tabId: string): string {
  return `jarvis.planPanelWidth.${tabId}`;
}

/** The width this tab's panel was last dragged to, or undefined for a tab
 *  never resized (or unreadable storage — a private window, cleared site
 *  data) — the panel then keeps styles.css's own 420px default. */
function loadPlanPanelWidth(tabId: string): number | undefined {
  try {
    const raw = window.localStorage.getItem(planPanelWidthKey(tabId));
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function savePlanPanelWidth(tabId: string, width: number): void {
  try {
    window.localStorage.setItem(planPanelWidthKey(tabId), String(width));
  } catch {
    // Not remembering is not worth interrupting anyone over.
  }
}

/**
 * Debounced per tab (SESSION_PLAN_DEBOUNCE_MS): asks main which plan (if
 * any) `tabId`'s own session transcript currently names, and records the
 * answer on the tab's own Pane. `paneKey`/`cwd` are the focused pane's own
 * — the same pair `planPanel.setPane` is handed at every cwd/focus call
 * site, since "this tab's session plan" follows whichever pane is focused
 * exactly as the panel itself does. `openIfPath`, when given, is the
 * `plans:changed` path this refresh exists to answer for (fix round 1) —
 * once the lookup resolves, `maybeAutoOpenPlan` decides whether it now
 * matches and the panel is still closed and not dismissed for it.
 *
 * `clearTimeout` only cancels a timer that has not fired yet, never an
 * in-flight `plansList` promise — a second call arriving while the first
 * request is already awaiting main's answer replaces the timer (fine, it
 * had not fired) but cannot stop that answer arriving late. `pane.
 * sessionPlanRequestId`, bumped only when a timer actually fires, is what
 * lets the `.then` below tell "my own answer" from "an older one that
 * arrived after a newer request already resolved" and discard the latter.
 *
 * Looks `tabId` up in `panes` at call time rather than closing over the
 * `Pane` object: every call site fires from inside a pane's own hooks,
 * which can only run once `ensurePane` has already returned and set the
 * entry — so a miss here only ever means the tab has since closed.
 */
function scheduleSessionPlanRefresh(
  tabId: string,
  paneKey: string,
  cwd: string,
  openIfPath?: string,
): void {
  const pane = panes.get(tabId);
  if (pane === undefined) return;
  if (pane.sessionPlanTimer !== undefined) clearTimeout(pane.sessionPlanTimer);
  pane.sessionPlanTimer = setTimeout(() => {
    pane.sessionPlanTimer = undefined;
    const requestId = ++pane.sessionPlanRequestId;
    void window.jarvis
      .plansList(paneKey, cwd)
      .then((list) => {
        if (pane.sessionPlanRequestId !== requestId) return; // superseded — discard
        const resolved = list.session?.path;
        setSessionPlanPath(pane, resolved);
        // A *different, defined* session plan than the one the user
        // dismissed re-arms auto-open for it (controller ruling); the
        // dismissal itself only ever suppresses the exact path it was
        // recorded for. `resolved === undefined` is not "a different
        // plan" — it is "no plan for whichever pane is focused right
        // now" (fix round 2: a sibling split with a real cwd but no
        // active session resolves exactly this), and must never wipe a
        // dismissal that still applies once focus returns to the pane
        // that actually has one.
        if (
          resolved !== undefined &&
          pane.dismissedPlanPath !== undefined &&
          pane.dismissedPlanPath !== resolved
        ) {
          pane.dismissedPlanPath = undefined;
        }
        if (openIfPath !== undefined) maybeAutoOpenPlan(tabId, openIfPath);
      })
      .catch(() => {
        // A failed lookup leaves the tab's last known session plan alone.
      });
  }, SESSION_PLAN_DEBOUNCE_MS);
}

/**
 * Whether `tabId`'s panel should auto-open for `path` right now: closed,
 * its own session plan resolves to exactly this path, and the user has
 * not already dismissed this same path (controller ruling). The one place
 * that rule is written down — both the immediate check in onPlansChanged
 * and every debounced lookup's own resolution route through this.
 */
function maybeAutoOpenPlan(tabId: string, path: string): void {
  const pane = panes.get(tabId);
  if (pane === undefined) return;
  if (pane.planPanel.isOpen()) return;
  if (pane.sessionPlanPath !== path) return;
  if (pane.dismissedPlanPath === path) return;
  openPlanPanelWithoutStealingFocus(pane, path);
}

/**
 * Auto-open must never move the terminal's own focus (spec rule 4).
 * plan-panel.ts's open() does not touch focus itself, but a picker or a
 * comment draft left over from before the panel was closed both queue a
 * `queueMicrotask(() => …focus())` of their own (renderPicker/commentBox)
 * — closePanel() now resets the picker (fix round 1), but a draft is not
 * this caller's to reset. Saving and restoring document.activeElement
 * around open() is the defensive net for either: one extra macrotask after
 * open() resolves, so every microtask a render queued has already run
 * before this decides whether anything needs restoring.
 */
function openPlanPanelWithoutStealingFocus(pane: Pane, path: string): void {
  const previousFocus = document.activeElement;
  void pane.planPanel
    .open(path)
    .then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    .then(() => {
      if (
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected &&
        document.activeElement !== previousFocus
      ) {
        previousFocus.focus();
      }
    });
}

/** Records the focused pane's own key and cwd on the tab (fix round 1) —
 *  what a `plans:changed` push uses to schedule its own fresh session-plan
 *  lookup. A newly focused pane with no known cwd yet (`cwd` undefined)
 *  leaves nothing honest to compare a future push against, so it clears
 *  the cached session plan and cancels any lookup still in flight for the
 *  pane that just lost focus — the same "nothing honest to show" rule the
 *  sidebar's own clear() already follows for this exact case. */
function setFocusedPane(tabId: string, paneKey: string, cwd: string | undefined): void {
  const pane = panes.get(tabId);
  if (pane === undefined) return;
  pane.focusedPaneKey = paneKey;
  pane.focusedCwd = cwd;
  if (cwd === undefined) {
    setSessionPlanPath(pane, undefined);
    if (pane.sessionPlanTimer !== undefined) {
      clearTimeout(pane.sessionPlanTimer);
      pane.sessionPlanTimer = undefined;
    }
    pane.sessionPlanRequestId += 1; // invalidates any in-flight lookup for the old pane
  }
}

/**
 * Drags the split between the tab's panes and its plan panel — the same
 * pattern workspace.ts's own wireDevToolsHandle follows: the pointer is
 * tracked on the window, not the handle, so a fast drag that leaves the 5px
 * strip does not silently stop resizing. Persists the final width on
 * mouseup only, the same "drag freely, remember once" discipline
 * saveDevToolsLayout follows.
 */
function wirePlanPanelHandle(
  handle: HTMLElement,
  panelElement: HTMLElement,
  container: HTMLElement,
  tabId: string,
  tree: SplitTree,
): void {
  handle.addEventListener("mousedown", (event) => {
    event.preventDefault();
    let width = clampPlanPanelWidth(
      panelElement.getBoundingClientRect().width,
      container.getBoundingClientRect().width,
    );

    const onMove = (move: MouseEvent): void => {
      const box = container.getBoundingClientRect();
      if (box.width === 0) return;
      width = clampPlanPanelWidth(box.right - move.clientX, box.width);
      panelElement.style.width = `${Math.round(width)}px`;
      for (const leaf of tree.panes()) leaf.refit();
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      savePlanPanelWidth(tabId, Math.round(width));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

// Minor (fix round 1): a width that was legal against yesterday's window
// is not necessarily legal against today's — nothing re-checks the 60%
// ceiling without this. Registered once at module init, re-registered on
// every module reset the same way workspace-terminal.test.ts's own
// vi.resetModules() needs the focus listener below to be (jsdom's
// `window` outlives every test; a plain addEventListener would leave one
// stale, closed-over listener behind per test otherwise).
type PlanPanelResizeHost = typeof window & {
  __reassertPlanPanelWidthOnResize__?: () => void;
};
const planPanelResizeHost = window as PlanPanelResizeHost;
if (planPanelResizeHost.__reassertPlanPanelWidthOnResize__ !== undefined) {
  window.removeEventListener("resize", planPanelResizeHost.__reassertPlanPanelWidthOnResize__);
}
const handlePlanPanelWindowResize = (): void => {
  for (const pane of panes.values()) {
    const current = pane.planPanel.element.getBoundingClientRect().width;
    if (current <= 0) continue; // no real layout (every jsdom test that never stubs it)
    const clamped = Math.round(clampPlanPanelWidth(current, pane.element.clientWidth));
    if (clamped === Math.round(current)) continue;
    pane.planPanel.element.style.width = `${clamped}px`;
    for (const leaf of pane.tree.panes()) leaf.refit();
  }
};
planPanelResizeHost.__reassertPlanPanelWidthOnResize__ = handlePlanPanelWindowResize;
window.addEventListener("resize", handlePlanPanelWindowResize);

let wired = false;

// M9 Task 7 / M7 ruling 11 (shared pty size, last writer wins): which
// terminal tab, if any, is the one actually drawn on screen right now —
// set by renderWorkspaceTerminals below, read by
// reassertVisibleWorkspaceTerminal() so a window focus event (which has no
// tab id of its own to hand it) knows what, if anything, to reassert.
let visibleTabId: string | undefined;

/** How terminals behave: read once for the whole module rather than once per
 *  pane, because a change to jarvis.yaml takes effect on restart anyway.
 *  Until it resolves — and if it never does — a pane is built with these,
 *  which are the terminal Jarvis shipped before blocks existed and so the
 *  right thing to fall back to. */
let terminalSettings = {
  blocks: false,
  inputEditor: false,
  notifyAfterSeconds: 0,
  home: "",
  // 0 is right as the "not answered yet" value: a pane reads anything that
  // is not a positive number as "keep the default".
  scrollback: 0,
};
try {
  void window.jarvis
    .terminalSettings()
    .then((settings) => {
      terminalSettings = settings;
    })
    .catch(() => {
      // Today's terminal. Nothing else about the tab is affected.
    });
} catch {
  // A preload without the channel — the same fallback.
}

/** Called once, from initWorkspace. Subscribes to the two streams main
 *  pushes; every pane created later reads from the same subscription rather
 *  than adding one of its own. */
export function initWorkspaceTerminals(): void {
  if (wired) return;
  wired = true;

  window.jarvis.onTerminalData((paneKey, chunk) => {
    // writeLive, not write: a pane drops anything pushed before its own
    // attach has settled, since that content is already inside the backlog
    // attach() is about to return — see terminal-pane.ts's own comment on
    // why that ordering is guaranteed, which is what makes this safe.
    paneFor(paneKey)?.writeLive(chunk);
  });

  window.jarvis.onTerminalExit((paneKey, code) => {
    // The tab stays open: its scrollback is usually the reason you were
    // there. The shell is gone, and saying so beats a terminal that has
    // silently stopped responding. It goes straight to the live terminal:
    // this is Jarvis speaking, not the pty, so it is no command's output and
    // has no business inside a block.
    paneFor(paneKey)?.terminal.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`);
  });

  // Task 8: the tab menu's own Plans item (bug 2's native menu, desktop-
  // only.ts) — main only names which tab; the renderer owns whether that
  // tab's panel is open, the same division of labour onTabRename already
  // follows for Rename's own inline input.
  window.jarvis.onTabPlans((tabId) => {
    const pane = panes.get(tabId);
    if (pane === undefined) return;
    pane.planPanel.toggle();
  });

  // Task 8: a plan file changed on disk. Every open tab's panel gets the
  // chance to refresh itself (notifyChanged is a no-op unless that panel's
  // own open doc — or list — actually needs it). A tab whose panel is
  // still closed is checked twice: once against whatever session plan is
  // already cached (the common case — a recent cwd/focus event already
  // resolved it), and once via a fresh, debounced plansList of its own
  // (fix round 1) — a foreground process like `claude` never re-emits
  // OSC 7 while it works, so the cached value can be stale exactly when a
  // plan just changed, which is the scenario this feature exists for.
  // maybeAutoOpenPlan is the one place that decides whether a path
  // actually counts as "this tab's own" and is not one the user already
  // dismissed; opening never moves focus (openPlanPanelWithoutStealingFocus).
  window.jarvis.onPlansChanged((path) => {
    for (const [tabId, pane] of panes) {
      pane.planPanel.notifyChanged(path);
      maybeAutoOpenPlan(tabId, path);
      if (pane.focusedPaneKey !== undefined && pane.focusedCwd !== undefined) {
        scheduleSessionPlanRefresh(tabId, pane.focusedPaneKey, pane.focusedCwd, path);
      }
    }
  });
}

/**
 * Moves its tab's focus to the leaf drawing `paneKey`, by stepping the
 * tree's own focus round — at most once per leaf, so a key no leaf holds
 * (a split since closed) leaves the focus where it was found. The tab is
 * not shown here; its next render focuses whichever leaf this left focused.
 */
export function focusTerminalLeaf(paneKey: string): void {
  const colon = paneKey.indexOf(":");
  const entry = panes.get(colon === -1 ? paneKey : paneKey.slice(0, colon));
  if (entry === undefined) return;
  const leaves = entry.tree.panes();
  if (!leaves.some((leaf) => paneKeys.get(leaf) === paneKey)) return;
  for (let step = 0; step < leaves.length; step += 1) {
    if (paneKeys.get(entry.tree.focused()) === paneKey) return;
    entry.tree.focus(1);
  }
}

/**
 * The pane drawing `paneKey`'s shell, or undefined for a shell this window
 * has no pane for.
 *
 * The pty stream is routed by shell key, never by tab: a split tab has one
 * shell per pane, and putting one pane's output into another's would be the
 * worst thing this module could do. The tab id is the part before the first
 * colon — tab ids have none of their own (see WorkspaceTabs' `tab-<n>`).
 */
function paneFor(paneKey: string): TerminalPane | undefined {
  const colon = paneKey.indexOf(":");
  const entry = panes.get(colon === -1 ? paneKey : paneKey.slice(0, colon));
  return entry?.tree.panes().find((pane) => paneKeys.get(pane) === paneKey);
}

/**
 * Shows the active tab's terminal and hides every other, creating a pane
 * the first time a tab needs one. Driven entirely by workspace state: the
 * renderer never tracks "which terminal is open" separately from which tab
 * is active.
 */
export function renderWorkspaceTerminals(
  tabs: WorkspaceTab[],
  activeTabId: string | undefined,
  selectedProject: string,
): void {
  const host = $("workspace-terminal");
  const live = new Set(tabs.filter((tab) => tab.kind === "terminal").map((tab) => tab.id));

  // A tab that is gone takes its terminal with it. The shell is already
  // being reaped by main's own close handler.
  for (const [tabId, pane] of panes) {
    if (live.has(tabId)) continue;
    // Every pane of the tab, not only the one that was focused: main's own
    // close handler reaps the tab's shells and its splits' with them.
    pane.tree.dispose();
    pane.explorer.dispose();
    // Task 8: closing a tab disposes its plan panel too, and drops any
    // pending session-plan refresh rather than letting it fire into a
    // Pane object that is no longer in `panes` (scheduleSessionPlanRefresh
    // already no-ops in that case, but there is no reason to leave the
    // timer running for a tab that is gone).
    pane.planPanel.dispose();
    if (pane.sessionPlanTimer !== undefined) clearTimeout(pane.sessionPlanTimer);
    pane.element.remove();
    panes.delete(tabId);
  }

  const active = tabs.find((tab) => tab.id === activeTabId);
  // The active tab may belong to a project the user has since switched away
  // from: hideAll() leaves it active in the store so that switching back
  // restores it, and main hides the hosted views behind a flag of its own.
  // A terminal is the renderer's own DOM, so it applies the same rule here
  // rather than going on showing another project's shell.
  const showing =
    active?.kind === "terminal" && active.project === selectedProject ? active.id : undefined;
  host.hidden = showing === undefined;

  // The AWS login tab is the one terminal in Jarvis drawn without blocks —
  // see paneSettings.
  if (showing !== undefined) {
    ensurePane(showing, selectedProject, host, active?.detail === LOGIN_TERMINAL_DETAIL);
  }
  for (const [tabId, pane] of panes) pane.element.hidden = tabId !== showing;

  // Fix round 1, Important 3: reasserting on *every* render (every
  // workspace:update push, whether or not the visible pane actually
  // changed) is more than rule 5 asks for — "reasserts... after showing
  // its Workspace/receiving focus" means a `showing` transition, not every
  // redraw of the same already-visible tab. `wasShowing` is read before
  // `visibleTabId` is overwritten below, so a render that leaves the same
  // tab visible sends nothing here; the focus listener is the only other
  // caller, unconditionally, as before.
  const wasShowing = visibleTabId;
  visibleTabId = showing;
  if (showing === undefined) return;
  const pane = panes.get(showing);
  if (pane === undefined) return;
  // The host was hidden until a moment ago, so this is the first point at
  // which the panes have a real size to be laid out at.
  for (const leaf of pane.tree.panes()) leaf.refit();
  pane.tree.focused().focus();
  // fit() above only calls back into resize() on a genuine change of a
  // leaf's own cell grid — see reassertVisibleWorkspaceTerminal()'s own
  // comment for why an explicit, unconditional send is still needed on a
  // genuine showing transition.
  if (wasShowing !== showing) {
    reassertVisibleWorkspaceTerminal();
  }
}

/**
 * Re-sends the visible terminal tab's current pty size, for every one of
 * its leaves, unconditionally (M7 ruling 11: last writer wins, both sides
 * re-assert).
 *
 * `leaf.refit()` (called from renderWorkspaceTerminals above, and by each
 * pane's own ResizeObserver) only calls back into its `resize` hook — and
 * so only sends `terminal:resize` — on a genuine change of the leaf's own
 * cell grid. A phone that resized this same pane's pty while the laptop's
 * Workspace was not looking leaves the laptop believing its old size
 * forever: nothing about *its* box changed, so fit() alone would never
 * notice. This sends every visible leaf's real cols/rows whenever the
 * terminal could plausibly be the thing on screen — a fresh render, or the
 * window regaining focus — whether or not they changed locally.
 *
 * Reads `visibleTabId` rather than taking a tab id, so the window "focus"
 * listener below (which has none to hand it) can call it too. Only ever
 * touches the pane that is actually visible right now: a hidden tab, or
 * another project's terminal, is never resized from here — which is what
 * keeps a laptop that is not looking at a terminal from undoing a phone's
 * own sizing of it.
 */
function reassertVisibleWorkspaceTerminal(): void {
  if (visibleTabId === undefined) return;
  const pane = panes.get(visibleTabId);
  if (pane === undefined) return;
  for (const leaf of pane.tree.panes()) {
    const paneKey = paneKeys.get(leaf);
    if (paneKey === undefined) continue;
    const { cols, rows } = leaf.terminal;
    if (cols < 1 || rows < 1) continue;
    void window.jarvis.resizeTerminal(paneKey, cols, rows);
  }
}

// Registered once, at module init, so a phone-driven resize is picked up
// even if the window regains focus while some other view is showing over
// the Workspace — reassertVisibleWorkspaceTerminal() itself declines to
// send anything in that case (visibleTabId is undefined whenever no
// terminal tab is the thing on screen).
//
// Keyed on `window` itself, rather than left as a bare addEventListener,
// the same way session-view.ts's own focus listener is: the app only ever
// loads this module once, but workspace-terminal.test.ts re-imports it
// fresh (vi.resetModules) for every test while jsdom's `window` outlives
// all of them, so a plain addEventListener would leave one stale, closed-
// over listener behind per test. Swapping the listener on each module load
// keeps exactly one live — the current module's own.
type FocusHost = typeof window & { __reassertWorkspaceTerminalOnFocus__?: () => void };
const focusHost = window as FocusHost;
if (focusHost.__reassertWorkspaceTerminalOnFocus__ !== undefined) {
  window.removeEventListener("focus", focusHost.__reassertWorkspaceTerminalOnFocus__);
}
const handleWorkspaceTerminalFocus = (): void => reassertVisibleWorkspaceTerminal();
focusHost.__reassertWorkspaceTerminalOnFocus__ = handleWorkspaceTerminalFocus;
window.addEventListener("focus", handleWorkspaceTerminalFocus);

/**
 * How this tab's panes behave.
 *
 * Every terminal in Jarvis gets the configured settings, with exactly one
 * deliberate exception: the AWS login tab (see LOGIN_TERMINAL_DETAIL). That
 * tab is opened by Jarvis itself to run one command — `saml2aws login` —
 * and is closed once the login is done; there is never a second command, so
 * a block would be a frame around the only thing on screen. It is the one
 * place this design opts out of blocks, and it opts out here rather than
 * anywhere deeper so that nothing in the pane itself has to know why.
 */
function paneSettings(isLoginTerminal: boolean): typeof terminalSettings {
  return isLoginTerminal ? { ...terminalSettings, blocks: false } : terminalSettings;
}

function ensurePane(
  tabId: string,
  project: string,
  host: HTMLElement,
  isLoginTerminal: boolean,
): Pane {
  const existing = panes.get(tabId);
  if (existing !== undefined) return existing;

  const element = document.createElement("div");
  element.className = "workspace-terminal-pane";
  host.append(element);

  // The tree is built from the panes it is given, so its own actions can
  // only be wired after it exists — and they are only ever called from a
  // keystroke, long after this returns.
  let tree: SplitTree | undefined;
  const splitKeys: SplitKeys = {
    split: (direction) => tree?.split(direction),
    // No tree yet is "no other pane", which sends ⌘W to the tab — the same
    // answer as a tab that was never split.
    closeFocused: () => tree?.closeFocused() ?? false,
    focus: (delta) => tree?.focus(delta),
    closeTab: () => void window.jarvis.closeTab(tabId),
  };

  // The tab's plan panel, right sibling of the split tree — declared here
  // (assigned once the tree exists, mirroring `tree` above) so the pane
  // callbacks built below can close over it even though it is built after
  // them. Every callback that reaches it only ever runs later, on a
  // cwd/focus event or a click — long after this function has returned and
  // `planPanel` holds its real value.
  let planPanel: PlanPanel | undefined;

  // The tab's file sidebar, on the left — one for the whole tab, however
  // many panes it is split into, following whichever of them has the
  // focus. Appended before the tree so it sits left of the panes.
  const explorer = createTerminalExplorer(element, terminalSettings.home, {
    // Guarded: a preload without the channel leaves a sidebar with nothing
    // to draw, never a terminal that throws. The pane key travels with
    // every listing rather than being assumed from the tab because it is
    // what tells main which shell asked: main resolves the path against
    // that pane's own working directory, and uses it to pick which
    // configured project the request belongs to. The containment check
    // itself is against that project's directory, not against the cwd —
    // see ipc.ts's listDir.
    list: async (paneKey, path) => {
      try {
        return await window.jarvis.listTerminalDir(paneKey, path);
      } catch {
        return [];
      }
    },
    // Fire-and-forget, exactly like `list` above: main does the whole of
    // "open this file" — containment, code-server, the tab itself — and
    // never rejects, so there is nothing here to await or to show. A
    // refusal (outside the project, no editor integration, code-server
    // failing to start) leaves the terminal exactly as it was, with no
    // dialog over it.
    choose: (paneKey, path) => {
      try {
        void window.jarvis.openTerminalFile(paneKey, path).catch(() => {});
      } catch {
        // A preload without the channel. Same fallback as `list` above.
      }
    },
    // New file, New folder, Rename and Move to Trash. Main proves every
    // path inside the pane's project (ipc.ts's createEntry and friends);
    // these only carry the request. A preload without a channel throws
    // here, which the explorer turns into a `failed` it shows.
    writes: {
      create: (paneKey, parent, name, kind) =>
        window.jarvis.createTerminalEntry(paneKey, parent, name, kind),
      rename: (paneKey, path, newName) => window.jarvis.renameTerminalEntry(paneKey, path, newName),
      trash: (paneKey, path) => window.jarvis.trashTerminalEntry(paneKey, path),
      t: planPanelT,
    },
  });

  /** Where each pane's shell last said it was. Read on a focus change:
   *  the sidebar follows the newly focused pane, and that pane's prompt
   *  may be minutes old. */
  const lastCwd = new Map<string, string>();

  const built = createSplitTree(
    element,
    (paneKey, paneHost) =>
      makePane(
        tabId,
        paneKey,
        project,
        paneHost,
        splitKeys,
        paneSettings(isLoginTerminal),
        // Only the focused pane's directory drives the sidebar (and the
        // plan panel, which follows it the same way — Task 8 rule 1): a
        // background pane running `cd` must never re-root either under
        // someone reading it in another pane.
        (path) => {
          lastCwd.set(paneKey, path);
          if (focusedKey() === paneKey) {
            explorer.setRoot(paneKey, path);
            planPanel?.setPane(paneKey, path);
            setFocusedPane(tabId, paneKey, path);
            scheduleSessionPlanRefresh(tabId, paneKey, path);
          }
        },
        // The sidebar's only way out: no chord, one palette action.
        () => explorer.toggle(),
        // A re-read now, keeping open folders open. The prompt and the
        // sidebar's own on-screen check already do this; the palette entry
        // is for not wanting to wait.
        () => explorer.refresh(),
        // The plan panel's own only way out besides the tab menu's Plans
        // item (Task 8) — no chord of its own, same rule as the sidebar.
        () => planPanel?.toggle(),
      ),
    tabId,
    {
      onFocus: (paneKey) => {
        const path = lastCwd.get(paneKey);
        // A pane that has never said where it is — a shell with no
        // integration, or one that has not drawn its first prompt yet —
        // leaves nothing honest to show. Going on showing the previous
        // pane's directory would be worst of all after a ⌘W, where that
        // pane's shell is gone and every listing under its key would fall
        // back to the tab's own.
        if (path === undefined) explorer.clear();
        else explorer.setRoot(paneKey, path);
        planPanel?.setPane(paneKey, path);
        setFocusedPane(tabId, paneKey, path);
        if (path !== undefined) scheduleSessionPlanRefresh(tabId, paneKey, path);
      },
    },
  );
  tree = built;

  /** The focused pane's shell key. Resolved through the same WeakMap the
   *  pty stream is routed by, so it can never name a pane that is gone. */
  function focusedKey(): string | undefined {
    return tree === undefined ? undefined : paneKeys.get(tree.focused());
  }

  // The plan panel and its drag handle: appended last, after the tree, so
  // DOM order inside `.workspace-terminal-pane` is explorer | splits |
  // handle | panel (spec rule 1) — the handle always immediately precedes
  // the panel it resizes.
  const planHandle = document.createElement("div");
  planHandle.className = "plan-panel-handle";
  // The panel itself starts closed (plan-panel.ts's own root.hidden), so
  // the handle starts hidden with it; onToggle below keeps the two in step
  // from here on.
  planHandle.hidden = true;

  // The panel's visible switch (the tab menu and the palette are the
  // other two): floated in the panes' own top corner, so it costs the
  // terminal no width and stays left of the panel once that is open.
  const planToggle = document.createElement("button");
  planToggle.type = "button";
  planToggle.className = "plan-toggle";
  planToggle.textContent = "☰";
  planToggle.title = planPanelT("planPanelToggle");
  planToggle.setAttribute("aria-label", planPanelT("planPanelToggle"));
  planToggle.setAttribute("aria-pressed", "false");
  planToggle.addEventListener("click", () => planPanel?.toggle());
  built.element.append(planToggle);

  const builtPanel = createPlanPanel({
    api: window.jarvis,
    t: planPanelT,
    // xterm refit after every open/close (spec rule 5): both go through
    // setOpen, so this is the one place that needs to. Never touches focus
    // — plan-panel.ts's open()/close() do not move it either, which is
    // what keeps an auto-open from stealing the terminal's keys.
    onToggle: (open) => {
      planHandle.hidden = !open;
      planToggle.setAttribute("aria-pressed", String(open));
      for (const leaf of built.panes()) leaf.refit();
      // Controller ruling (fix round 1): every close reaching this hook is
      // the user's own — auto-open only ever calls open(), never
      // close()/toggle() — so record the session plan it was showing (if
      // any) as dismissed. scheduleSessionPlanRefresh's own resolution
      // clears this again once a *different* session plan resolves.
      if (!open) {
        const pane = panes.get(tabId);
        if (pane !== undefined && pane.sessionPlanPath !== undefined) {
          pane.dismissedPlanPath = pane.sessionPlanPath;
        }
      }
    },
    // Controller ruling: main's webContents deny every target=_blank
    // outright, so a plan block's own rendered link has no route to the OS
    // browser without this — see desktop-only.ts's own scheme/length gate
    // before shell.openExternal ever runs.
    onLinkClick: (href) => void window.jarvis.plansOpenLink(href),
  });
  planPanel = builtPanel;
  element.append(planHandle, builtPanel.element);
  wirePlanPanelHandle(planHandle, builtPanel.element, element, tabId, built);

  // A width this tab was resized to before wins over styles.css's own
  // 420px default (spec rule 2); clamped against this pane's own box,
  // which already has its real size by the time ensurePane runs (its host
  // was un-hidden just before this call — see renderWorkspaceTerminals).
  const savedWidth = loadPlanPanelWidth(tabId);
  if (savedWidth !== undefined) {
    builtPanel.element.style.width = `${clampPlanPanelWidth(savedWidth, element.clientWidth)}px`;
  }

  const pane: Pane = {
    element,
    tree: built,
    explorer,
    planPanel: builtPanel,
    sessionPlanPath: undefined,
    sessionPlanTimer: undefined,
    sessionPlanRequestId: 0,
    focusedPaneKey: undefined,
    focusedCwd: undefined,
    dismissedPlanPath: undefined,
    planToggle,
  };
  panes.set(tabId, pane);
  return pane;
}

/**
 * One leaf of a tab's tree: a whole terminal pane, with its own blocks, its
 * own editor and its own autocomplete, talking to the shell keyed
 * `paneKey`. Nothing here is conditional on whether the pane is the tab's
 * first or one split off it — the only difference between them is the key.
 */
function makePane(
  tabId: string,
  paneKey: string,
  project: string,
  element: HTMLElement,
  splitKeys: SplitKeys,
  settings: typeof terminalSettings,
  onCwd: (path: string) => void,
  toggleExplorer: () => void,
  refreshExplorer: () => void,
  togglePlan: () => void,
): TerminalPane {
  // A split pane's shell has to exist before the pane can attach to it, so
  // the attach below waits on this. The tab's own pane has had a shell
  // since main opened the tab.
  const started = startShell(tabId, paneKey);

  // Where this pane's shell last said it was — the same OSC 7 report that
  // drives `onCwd` and the chip row, kept here too because autocomplete
  // needs it read fresh at every keystroke, not only on a prompt. `main`
  // only ever knows where the shell *started*; without this, completions
  // would keep answering for that directory forever, the very bug this
  // wiring exists to fix. `undefined` until the first prompt — main falls
  // back to the start directory for that case on its own.
  let livePath: string | undefined;

  // Completion needs the pane's terminal to exist before it can be built,
  // but the editor's own keystrokes need completion consulted from inside
  // createPane, before completion can exist — so the pane gets a forward
  // reference, filled in once attachCompletion has actually run, exactly
  // the way `completion` itself already gets reassigned below.
  let completion: Completion = { handleKey: () => true, close: () => {} };

  // The pane's own first look at a keystroke: the split chords, then the
  // autocomplete dropdown. It is passed both to the pane (the editor's
  // path) and to enhanceTerminal (xterm's), because those are two
  // different events — while the command editor is visible a keystroke
  // targets its field and never reaches xterm at all — and the split
  // chords have to work at either.
  const interceptKey = (event: KeyboardEvent): boolean =>
    handleSplitKey(event, splitKeys) && completion.handleKey(event);

  // The pane's terminal: frozen blocks over a live xterm when the shell's
  // integration is on, and today's bare terminal when it is not. Keystrokes,
  // the cell grid and the shell's buffered prologue are all its business;
  // what stays here is everything that needs to know which shell this is.
  const view = createPane(element, {
    // Every keystroke verbatim, control bytes included — that is what makes
    // Ctrl-C, arrows and Escape work rather than only plain text.
    sendInput: (data) => void window.jarvis.sendTerminalInput(paneKey, data),
    resize: (cols, rows) => void window.jarvis.resizeTerminal(paneKey, cols, rows),
    // ConPTY repaints its whole screen on every resize; a POSIX pty does not.
    ptyRepaintsOnResize: hostPlatform() === "win32",
    // A `Notification` this environment lacks, or has never been granted
    // permission for, throws — and this is the one call in the pane's
    // whole chain of side effects allowed to swallow that, since nothing
    // here reaches the pty or the DOM the terminal itself depends on.
    notify: (title, body) => {
      try {
        new Notification(title, { body });
      } catch {
        // Notification unsupported or denied: no less a working terminal.
      }
    },
    // M10 Task 4: main decides whether this is push-worthy (a paired phone,
    // push turned on, the laptop's own window unfocused) — this pane only
    // ever reports the fact, never a command line or any other detail.
    onCommandFinished: (seconds, ok) =>
      void window.jarvis.reportCommandFinished(paneKey, seconds, ok),
    // Whatever the shell printed before this pane existed — its prompt,
    // usually. `started` is waited on only so a split pane's attach does
    // not race the shell it is attaching to — main's shell registry has to
    // have the key before `terminal:attach` can read anything back for it.
    // Attaching itself registers no listener: the live stream has been
    // flowing since initWorkspaceTerminals ran, before any of this pane
    // exists, so a slow or unknown key here never leaves the pane blank.
    // What stops a chunk from landing twice is terminal-pane.ts's own
    // write-gate on its attach promise, not this wait.
    attach: () =>
      started === undefined
        ? window.jarvis.attachTerminal(paneKey)
        : started.then(() => window.jarvis.attachTerminal(paneKey)),
    settings,
    // What the command editor's arrows walk: Jarvis's own command log,
    // never zsh's line editor. Guarded because a preload without the
    // channel must still be a terminal, with arrows that do nothing rather
    // than an exception at every prompt.
    history: async () => {
      try {
        return await window.jarvis.terminalHistory(paneKey, HISTORY_LIMIT);
      } catch {
        return [];
      }
    },
    // What ⌘P's "Run workflow…" offers — this project's saved workflows.
    // Guarded the same way `history` is: a channel that fails leaves the
    // action with nothing to offer, never a terminal that throws.
    workflows: async () => {
      try {
        return await window.jarvis.terminalWorkflows(project);
      } catch {
        return [];
      }
    },
    // The chip row's data, read fresh on every cwd event. Guarded the same
    // way `history` and `workflows` are: a channel that fails (or a preload
    // without it) leaves the row showing whatever it already had rather
    // than throwing into the pane.
    chips: async (path) => {
      try {
        // The pane's live directory travels with the request: main's own
        // record of where a shell is was written when the shell started
        // and never again, so after a `cd` it would answer for the wrong
        // repository — see TerminalHandlers.chips.
        return await window.jarvis.terminalChips(paneKey, path);
      } catch {
        return undefined;
      }
    },
    interceptKey,
    // The palette's split right / split down / close pane — the same tree
    // handleSplitKey already acts on for the app's own ⌘D/⌘⇧D/⌘W chords.
    splitKeys,
    // The two AI actions' only route to the brain. window.jarvis.terminalAi
    // never rejects (main resolves every failure, including no brain
    // configured, to ""), so this needs no guard of its own.
    terminalAi: (kind, text) => window.jarvis.terminalAi(kind, text),
    // So the palette can hide a suggestion list left showing from
    // mid-typing before it opens over the same pane.
    closeCompletion: () => completion.close(),
    // Where this pane's shell is, as of the prompt it is about to draw —
    // what the tab's file sidebar follows, and now also what autocomplete
    // reads before it asks main for anything.
    onCwd: (path) => {
      livePath = path;
      onCwd(path);
    },
    // "Toggle file sidebar" in the pane's own palette. The sidebar belongs
    // to the tab, not to the pane, so every pane's action toggles the same
    // one — which is the point: whichever pane you are in can dismiss it.
    toggleExplorer,
    // "Refresh file sidebar" in the same palette, and the sidebar's only
    // refresh trigger besides a `cd` and expanding a folder.
    refreshExplorer,
    // "Toggle plan panel" (Task 8), the same "belongs to the tab" rule
    // toggleExplorer follows.
    togglePlan,
  });
  paneKeys.set(view, paneKey);
  const terminal = view.terminal;

  // Autocomplete: a dropdown under the cursor, completing from this user's
  // own shell history. Guarded because it is an enhancement and never a
  // requirement — a terminal that could not wire it must still be a
  // terminal, which is the same rule the addon stack follows. Its key
  // handling goes through enhanceTerminal rather than being attached
  // separately: xterm keeps only one custom key handler.
  //
  // readInput/applyInput/anchor go in only when the pane actually has an
  // editor — with `inputEditor` off, the pane's own readInput/applyInput/
  // editorElement always read as "no editor" anyway, but passing them
  // regardless would still hand attachCompletion an `anchor` hook, and an
  // anchor hook changes how the dropdown positions itself even over a bare
  // terminal. Today's cell-under-the-cursor placement has to stay exactly
  // what it was for a pane that never asked for an editor.
  const editorCompletionHooks = settings.inputEditor
    ? {
        readInput: () => view.readInput(),
        applyInput: (line: string) => view.applyInput(line),
        // The pane's answer, not the parser's: in blocks mode the marks
        // are consumed by the block splitter and never reach xterm, so
        // completion's own OSC handler never fires and every keystroke
        // used to be dropped on refresh()'s first line.
        promptActive: () => view.atPrompt(),
        // Left-aligned to the editor's own box, and handing over its
        // vertical span — not a caret cell, since the buffer never moves
        // while the editor is live to compute one from. Direction (above
        // the box or below it) is attachCompletion's call, made from the
        // room actually available in `element`.
        anchor: () => {
          const editorEl = view.editorElement();
          if (editorEl === undefined) return { x: 0, top: 0, bottom: 0 };
          const editorBox = editorEl.getBoundingClientRect();
          const hostBox = element.getBoundingClientRect();
          return {
            x: editorBox.left - hostBox.left,
            top: editorBox.top - hostBox.top,
            bottom: editorBox.bottom - hostBox.top,
          };
        },
      }
    : {};
  try {
    completion = attachCompletion(terminal, element, {
      // The pane's own key, never the tab's: main resolves a split's cwd
      // through the same map it resolves the tab's, so a pane in a split
      // completes against the directory its own shell is in. `livePath`
      // travels alongside it for the same reason it travels with `chips`
      // — main's own record is only ever the shell's *starting* directory.
      suggest: (input) => window.jarvis.suggestCompletions(paneKey, input, livePath),
      sendInput: (data) => void window.jarvis.sendTerminalInput(paneKey, data),
      ...editorCompletionHooks,
    });
  } catch {
    // No dropdown. The shell is untouched.
  }

  // Addons, key bindings and the find bar — shared with the Session view's
  // terminal so the two behave identically. After open(): WebGL needs a real
  // element to attach a context to.
  enhanceTerminal(terminal, element, {
    interceptKey,
    sendInput: (data) => void window.jarvis.sendTerminalInput(paneKey, data),
    // A link opens as an ordinary browser tab in the same project, which is
    // what puts it through normalizeInput and the app's navigation rules
    // instead of handing an arbitrary string to the OS.
    openLink: (url) => void window.jarvis.openTab(project, url),
    // Undefined with blocks switched off — createPane leaves its own
    // blockNav undefined in that case, and the key handler's guards make
    // that mean "behave exactly as today" rather than claiming ⌘↑/⌘↓/⌘⇧F
    // and doing nothing with them.
    blockNav: view.blockNav,
    // ⌘P, claimed in every pane state — see terminal-addons.ts's own note
    // on why this one, unlike ^R, is never gated on the editor or on
    // whether something is running.
    openPalette: () => view.openPalette(),
  });

  // The pane's own slot, which a divider drag or a sibling's closing
  // resizes as well as the window does.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => view.refit()).observe(element);
  }

  return view;
}

/**
 * Starts the shell for a pane split off `tabId`, in the tab's own
 * directory. The tab's first pane already has one — main started it when
 * it opened the tab — and gets undefined, so that pane attaches exactly as
 * it did before splits existed, on the same tick.
 *
 * Never rejects: a split whose shell could not be started leaves a pane
 * that draws nothing, which is a great deal better than an exception in
 * the middle of a terminal.
 */
function startShell(tabId: string, paneKey: string): Promise<void> | undefined {
  if (paneKey === tabId) return undefined;
  try {
    // Everything after the tab id and its colon — see createSplitTree,
    // which is what composed the key.
    return Promise.resolve(
      window.jarvis.splitTerminal(tabId, paneKey.slice(tabId.length + 1)),
    ).catch(() => undefined);
  } catch {
    // A preload without the channel.
    return Promise.resolve();
  }
}
