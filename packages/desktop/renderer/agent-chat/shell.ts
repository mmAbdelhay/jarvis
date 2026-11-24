// The chat's frame: the header row (files toggle, title, search, Chat | Term)
// and the layout under it — a centred 820px column (feed, question, composer)
// beside a 320px side panel. The panel's own visibility and the narrow layout
// are decided by the caller; this file only builds the places.
import { el, ICONS, icon, type Translate } from "./dom.js";

export type Mode = "chat" | "term";

export type Shell = {
  /** The header row (a flex item of the pane, above the chat). */
  bar: HTMLElement;
  tablist: HTMLElement;
  tabs: Record<Mode, HTMLButtonElement>;
  /** Where the header's extra buttons go (search, panel). */
  actions: HTMLElement;
  /** The chat section. */
  panel: HTMLElement;
  /** Above the body: the search field. */
  top: HTMLElement;
  /** The column that holds the feed. */
  main: HTMLElement;
  /** Below the feed: question, chips, note, composer. */
  lower: HTMLElement;
  /** Beside the column. */
  side: HTMLElement;
  setSelected(mode: Mode): void;
  setIdentity(vendor: string, title: string | undefined): void;
};

export function createShell(options: {
  t: Translate;
  toggleFiles?: (() => void) | undefined;
  onTab(mode: Mode, byUser: boolean): void;
  currentMode(): Mode;
}): Shell {
  const { t } = options;
  const bar = el("div", "agent-bar");
  bar.hidden = true;
  if (options.toggleFiles !== undefined) {
    const files = el("button", "ac-iconbutton ac-files-toggle");
    files.type = "button";
    files.append(icon(ICONS.files));
    files.setAttribute("aria-label", t("explorerToggle"));
    files.title = t("explorerToggle");
    const toggleFiles = options.toggleFiles;
    files.addEventListener("click", () => toggleFiles());
    bar.append(files);
  }
  const title = el("strong", "ac-bar__title");
  title.dir = "auto";
  const vendor = el("span", "ac-bar__vendor");
  const actions = el("div", "ac-bar__actions");
  const tablist = el("div", "agent-switch");
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", t("agentSwitchLabel"));
  const tabs = {
    chat: el("button", "agent-switch__tab", t("agentChatTab")),
    term: el("button", "agent-switch__tab", t("agentTermTab")),
  };
  for (const mode of ["chat", "term"] as const) {
    const tab = tabs[mode];
    tab.type = "button";
    tab.dataset["mode"] = mode;
    tab.setAttribute("role", "tab");
    tab.addEventListener("click", () => options.onTab(mode, true));
  }
  tablist.append(tabs.chat, tabs.term);
  tablist.addEventListener("keydown", (event) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const next: Mode =
      event.key === "Home"
        ? "chat"
        : event.key === "End"
          ? "term"
          : options.currentMode() === "chat"
            ? "term"
            : "chat";
    options.onTab(next, true);
    tabs[next].focus();
  });
  bar.append(title, vendor, el("span", "ac-spacer"), actions, tablist);

  const panel = el("section", "agent-chat");
  panel.hidden = true;
  panel.setAttribute("aria-label", t("agentChatFeedLabel"));
  const top = el("div", "ac-top");
  const body = el("div", "ac-body");
  const main = el("div", "ac-main");
  const lower = el("div", "ac-lower");
  const side = el("div", "ac-sidewrap");
  main.append(lower);
  body.append(main, side);
  panel.append(top, body);

  return {
    bar,
    tablist,
    tabs,
    actions,
    panel,
    top,
    main,
    lower,
    side,
    setSelected(mode) {
      for (const which of ["chat", "term"] as const) {
        const selected = which === mode;
        tabs[which].setAttribute("aria-selected", String(selected));
        tabs[which].tabIndex = selected ? 0 : -1;
      }
    },
    setIdentity(vendorName, name) {
      vendor.textContent = vendorName;
      title.textContent = name !== undefined && name !== "" ? name : vendorName;
      vendor.hidden = name === undefined || name === "";
    },
  };
}
