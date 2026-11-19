import type { TailnetMachine, TailnetPeers } from "@jarvis/wire";
import type { RendererApi } from "../src/ipc.js";
import type { MachineViewState } from "../src/machine-views.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";

// The topbar's machine switcher: the other Jarvis machines on this user's
// tailnet (tailnet-peers.ts), one of which can be opened full-window under
// the topbar (machine-views.ts). The renderer draws the stage behind that
// view — a loading line, or why the machine could not be shown and a way
// back — since a native view paints over the renderer and only covers the
// stage once its page has loaded.

export type MachineSwitcherApi = Pick<
  RendererApi,
  | "tailnetPeers"
  | "showMachine"
  | "showLocalMachine"
  | "setMachineBounds"
  | "closeMachine"
  | "onMachineState"
> & {
  /** Keeps this machine's workspace pages off screen while another machine
   *  covers the window. */
  hideWorkspace(): void;
  /** Brings them back once this machine is shown again. */
  restoreWorkspace(): void;
};

/** How often the open menu asks again (tailnet-peers.ts caches for as long). */
export const MACHINE_POLL_MS = 30_000;

const en = PRIMARY_LANGUAGE;

const key = (name: string): string => name.toLowerCase();

export async function initMachineSwitcher(
  api: MachineSwitcherApi,
  doc: Document = document,
): Promise<void> {
  const button = doc.getElementById("machine-button");
  const menu = doc.getElementById("machine-menu");
  const stage = doc.getElementById("machine-stage");
  if (button === null || menu === null || stage === null) return;
  const win = doc.defaultView ?? window;

  /** Every machine opened this session and not closed, by lowercased name:
   *  their views are kept alive in main, so each gets a close control. */
  const opened = new Map<string, TailnetMachine>();
  let active: TailnetMachine | undefined;
  let peers: TailnetPeers | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let round = 0;

  button.setAttribute("aria-haspopup", "menu");
  menu.setAttribute("role", "menu");

  const renderButton = (): void => {
    const label = active?.label ?? MESSAGES.machineThisMachine(en);
    const text = doc.getElementById("machine-button-label") ?? button;
    text.textContent = label;
    button.setAttribute("aria-label", MESSAGES.machineSwitcherLabel(label, en));
    button.classList.toggle("machine-btn--remote", active !== undefined);
  };

  const item = (text: string, onChoose: () => void, current: boolean): HTMLButtonElement => {
    const el = doc.createElement("button");
    el.type = "button";
    el.className = "machine-menu-item";
    el.setAttribute("role", "menuitem");
    if (current) el.setAttribute("aria-current", "true");
    el.textContent = text;
    el.addEventListener("click", onChoose);
    return el;
  };

  const note = (text: string): HTMLElement => {
    const el = doc.createElement("div");
    el.className = "machine-menu-note";
    el.textContent = text;
    return el;
  };

  const renderMenu = (): void => {
    const rows: HTMLElement[] = [
      item(MESSAGES.machineThisMachine(en), () => void chooseLocal(), active === undefined),
    ];
    const found = peers?.machines ?? [];
    // A machine opened earlier but missing from this round (gone offline)
    // is still listed, so its view can be closed.
    const listed = [...found];
    for (const [name, m] of opened) {
      if (!found.some((f) => key(f.name) === name)) listed.push(m);
    }
    for (const m of listed) {
      const row = doc.createElement("div");
      row.className = "machine-menu-row";
      const choose = item(
        "",
        () => void chooseMachine(m),
        active !== undefined && key(active.name) === key(m.name),
      );
      const label = doc.createElement("span");
      label.className = "machine-menu-label";
      label.textContent = m.label;
      const name = doc.createElement("span");
      name.className = "machine-menu-name mono";
      name.textContent = m.name;
      choose.replaceChildren(label, name);
      row.append(choose);
      if (opened.has(key(m.name))) {
        const close = doc.createElement("button");
        close.type = "button";
        close.className = "machine-menu-close";
        close.setAttribute("aria-label", MESSAGES.machineClose(m.label, en));
        close.textContent = "×";
        close.addEventListener("click", () => void closeOne(m));
        row.append(close);
      }
      rows.push(row);
    }
    if (peers === undefined) rows.push(note(MESSAGES.machineLooking(en)));
    else if (peers.state === "no-cli") rows.push(note(MESSAGES.machineNoCli(en)));
    else if (peers.state === "not-running") rows.push(note(MESSAGES.machineNotRunning(en)));
    else if (found.length === 0) rows.push(note(MESSAGES.machineNoneFound(en)));
    menu.replaceChildren(...rows);
  };

  const refresh = async (): Promise<void> => {
    const mine = ++round;
    try {
      const answer = await api.tailnetPeers();
      // Only the newest round draws, and only into an open menu.
      if (mine !== round || menu.hidden) return;
      peers = answer;
      renderMenu();
    } catch (error: unknown) {
      console.error(`machine switcher: ${String(error)}`);
    }
  };

  const target = (m: TailnetMachine) => ({ name: m.name, webPort: m.webPort, v: m.v });
  const logged = (work: Promise<void>): void => {
    work.catch((error: unknown) => console.error(`machine switcher: ${String(error)}`));
  };

  const openMenu = (): void => {
    const rect = button.getBoundingClientRect();
    menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    menu.style.left = `${Math.round(rect.left)}px`;
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    // A machine view is native and paints over every DOM element below the
    // topbar, this menu included. Hidden — never resized, which would resize
    // that machine's terminals — until the menu closes.
    if (active !== undefined) logged(api.showLocalMachine());
    renderMenu();
    void refresh();
    timer = setInterval(() => void refresh(), MACHINE_POLL_MS);
  };

  /** `reshow`: put the shown machine's view back (the menu closed without a
   *  choice). A choice shows what was chosen itself. */
  const closeMenu = (reshow: boolean): void => {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (reshow && active !== undefined) logged(api.showMachine(target(active)));
  };

  /** The area below the topbar, where the machine view goes. */
  const reportBounds = (): void => {
    const bar = doc.querySelector(".topbar");
    const top = Math.round(bar?.getBoundingClientRect().bottom ?? 0);
    stage.style.top = `${top}px`;
    void api.setMachineBounds({
      x: 0,
      y: top,
      width: Math.round(win.innerWidth),
      height: Math.max(0, Math.round(win.innerHeight - top)),
      devicePixelRatio: win.devicePixelRatio,
    });
  };

  const renderStage = (phase: MachineViewState["phase"]): void => {
    if (active === undefined) return;
    if (phase === "ready") {
      stage.replaceChildren();
      return;
    }
    const panel = doc.createElement("div");
    panel.className = `machine-stage-panel machine-stage-panel--${phase}`;
    const line = doc.createElement("p");
    line.className = "machine-stage-text";
    if (phase === "loading") {
      const spinner = doc.createElement("span");
      spinner.className = "machine-stage-spinner";
      spinner.setAttribute("aria-hidden", "true");
      panel.append(spinner);
      line.textContent = MESSAGES.machineLoading(active.label, en);
    } else {
      line.textContent =
        phase === "offline"
          ? MESSAGES.machineOffline(en)
          : phase === "certificate"
            ? MESSAGES.machineCertificate(en)
            : MESSAGES.machineVersion(en);
    }
    line.setAttribute("role", "status");
    const back = doc.createElement("button");
    back.type = "button";
    back.className = "machine-stage-back";
    back.textContent = MESSAGES.machineBack(en);
    back.addEventListener("click", () => void chooseLocal());
    panel.append(line, back);
    stage.replaceChildren(panel);
  };

  const chooseMachine = async (m: TailnetMachine): Promise<void> => {
    closeMenu(false);
    active = m;
    opened.set(key(m.name), m);
    api.hideWorkspace();
    stage.hidden = false;
    renderStage("loading");
    renderButton();
    reportBounds();
    try {
      await api.showMachine(target(m));
    } catch (error: unknown) {
      console.error(`machine switcher: ${String(error)}`);
    }
  };

  const chooseLocal = async (): Promise<void> => {
    closeMenu(false);
    await goLocal();
  };

  const goLocal = async (): Promise<void> => {
    const wasRemote = active !== undefined;
    active = undefined;
    stage.hidden = true;
    stage.replaceChildren();
    renderButton();
    if (!wasRemote) return;
    try {
      await api.showLocalMachine();
    } catch (error: unknown) {
      console.error(`machine switcher: ${String(error)}`);
    }
    api.restoreWorkspace();
  };

  const closeOne = async (m: TailnetMachine): Promise<void> => {
    opened.delete(key(m.name));
    const wasActive = active !== undefined && key(active.name) === key(m.name);
    try {
      await api.closeMachine(m.name);
    } catch (error: unknown) {
      console.error(`machine switcher: ${String(error)}`);
    }
    // The menu stays open on the list, now without that close control.
    if (wasActive) await goLocal();
    if (!menu.hidden) renderMenu();
  };

  api.onMachineState((state) => {
    if (active === undefined || key(state.name) !== key(active.name)) return;
    renderStage(state.phase);
  });

  button.addEventListener("click", () => {
    if (menu.hidden) openMenu();
    else closeMenu(true);
  });
  doc.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || menu.hidden) return;
    closeMenu(true);
    button.focus();
  });
  doc.addEventListener("click", (event) => {
    const inside =
      event.target instanceof Node &&
      (button.contains(event.target) || menu.contains(event.target));
    if (inside) return;
    closeMenu(true);
  });
  win.addEventListener("resize", () => {
    if (active !== undefined) reportBounds();
  });

  button.setAttribute("aria-expanded", "false");
  renderButton();
}
