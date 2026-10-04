// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RendererApi } from "../src/ipc.js";
import { MESSAGES } from "../src/messages.js";
import type { RunningCounts, UpdateError, UpdateState } from "../src/updater.js";
import { formatAgo } from "./format.js";

// The card's own markup, cut from index.html so the ids tested here are the
// ids the app ships.
const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.html"), "utf8");
const START = "<!-- updates -->";
const END = "<!-- /updates -->";
const card = html.slice(html.indexOf(START), html.indexOf(END) + END.length);

const PAGE = "https://github.com/mmAbdelhay/jarvis/releases/tag/v0.1.9";
const base: UpdateState = { phase: "current", current: "0.1.8" };
const available: UpdateState = {
  phase: "available",
  current: "0.1.8",
  latest: "0.1.9",
  url: PAGE,
  notes: "Fixes.",
};

async function setup(opts: { counts?: () => Promise<RunningCounts> } = {}) {
  vi.resetModules();
  document.body.innerHTML = `<button id="nav-settings">Settings<span id="nav-settings-dot" class="nav-dot" hidden></span></button>${card}`;
  let listener: ((state: UpdateState) => void) | undefined;
  const api = {
    updateCheck: vi.fn(async () => base),
    updateDownload: vi.fn(() => new Promise<UpdateState>(() => {})),
    updateCancel: vi.fn(async () => available),
    updateCounts: vi.fn(opts.counts ?? (async () => ({ terminals: 3, agents: 2 }))),
    updateInstall: vi.fn(() => new Promise<UpdateState>(() => {})),
    openTab: vi.fn(async () => {}),
    onUpdateState: vi.fn((cb: (state: UpdateState) => void) => {
      listener = cb;
      return () => {};
    }),
  };
  window.jarvis = api as unknown as RendererApi;
  const { initUpdateSettings } = await import("./update-settings.js");
  initUpdateSettings();
  return { ...api, push: (state: UpdateState) => listener?.(state) };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const byId = (id: string) => document.getElementById(id) as HTMLElement;
/** Visible: neither it nor any ancestor is hidden. */
const shown = (id: string): boolean => {
  for (let node: HTMLElement | null = byId(id); node !== null; node = node.parentElement) {
    if (node.hidden) return false;
  }
  return true;
};
const dot = () => byId("nav-settings-dot");
/** A download that finishes: downloading, then ready. */
const toReady = (api: { push: (state: UpdateState) => void }) => {
  api.push({ ...available, phase: "downloading", received: 0, total: 10 });
  api.push({ ...available, phase: "ready" });
};

describe("Settings → General → Updates", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("the markup is in index.html", () => {
    expect(card.length).toBeGreaterThan(START.length + END.length);
  });

  it("asks nothing by itself; main's own launch check fills the card", async () => {
    const api = await setup();
    await settle();
    expect(api.updateCheck).not.toHaveBeenCalled();
    const at = Date.now();
    api.push({ ...base, lastChecked: at });
    const line = byId("settings-update-version").textContent;
    expect(line).toContain("0.1.8");
    expect(line).toContain(MESSAGES.updateLastChecked(formatAgo(at, Date.now(), "en"), "en"));
    expect(shown("settings-update-card")).toBe(false);
    expect(dot().hidden).toBe(true);
  });

  it("Check now asks main and shows the answer", async () => {
    const api = await setup();
    byId("settings-update-check").click();
    expect(api.updateCheck).toHaveBeenCalledTimes(1);
    await settle();
    expect(byId("settings-update-status").textContent).toBe(MESSAGES.updateCurrent("0.1.8", "en"));
  });

  it("checking: the button waits and says so", async () => {
    const api = await setup();
    api.push({ ...base, phase: "checking" });
    expect((byId("settings-update-check") as HTMLButtonElement).disabled).toBe(true);
    expect(byId("settings-update-status").textContent).toBe(MESSAGES.updateChecking("en"));
  });

  it("available: version, notes, Full notes, Install update, and the nav dot", async () => {
    const api = await setup();
    api.push(available);
    expect(shown("settings-update-card")).toBe(true);
    expect(byId("settings-update-title").textContent).toBe(
      MESSAGES.updateNewer("0.1.9", "0.1.8", "en"),
    );
    expect(byId("settings-update-notes").textContent).toBe("Fixes.");
    expect(shown("settings-update-install")).toBe(true);
    expect(byId("settings-update-install").textContent).toBe(MESSAGES.updateInstall("en"));
    expect(shown("settings-update-progress")).toBe(false);
    expect(shown("settings-update-confirm")).toBe(false);
    expect(dot().hidden).toBe(false);

    byId("settings-update-notes-link").click();
    expect(api.openTab).toHaveBeenCalledWith("__personal__", PAGE);
  });

  it("notes stay plain text and stop at 20 lines", async () => {
    const api = await setup();
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    lines[0] = `<img src=x onerror="window.pwned=1">`;
    api.push({ ...available, notes: lines.join("\n") });
    const notes = byId("settings-update-notes");
    expect(notes.querySelector("img")).toBeNull();
    expect(notes.textContent).toContain("<img src=x");
    expect(notes.textContent?.split("\n")).toHaveLength(20);
    expect(notes.textContent).toContain("line 20");
    expect(notes.textContent).not.toContain("line 21");
  });

  it("Install update pressed twice downloads once", async () => {
    const api = await setup();
    api.push(available);
    byId("settings-update-install").click();
    byId("settings-update-install").click();
    expect(api.updateDownload).toHaveBeenCalledTimes(1);
  });

  it("downloading: progress bar, bytes and Cancel; no install button", async () => {
    const api = await setup();
    api.push({ ...available, phase: "downloading", received: 50_000_000, total: 100_000_000 });
    expect(shown("settings-update-progress")).toBe(true);
    expect(shown("settings-update-install")).toBe(false);
    expect(byId("settings-update-fill").style.width).toBe("50%");
    expect(byId("settings-update-bytes").textContent).toBe(
      MESSAGES.updateDownloading("50.0 MB", "100.0 MB", "en"),
    );
    byId("settings-update-cancel").click();
    expect(api.updateCancel).toHaveBeenCalledTimes(1);
  });

  it("verifying: no Cancel", async () => {
    const api = await setup();
    api.push({ ...available, phase: "verifying" });
    expect(shown("settings-update-cancel")).toBe(false);
    expect(byId("settings-update-bytes").textContent).toBe(MESSAGES.updateVerifying("en"));
  });

  it("ready: the confirm names what a restart ends; Install now installs once", async () => {
    const api = await setup();
    toReady(api);
    await settle();
    expect(api.updateCounts).toHaveBeenCalledTimes(1);
    expect(shown("settings-update-confirm")).toBe(true);
    expect(byId("settings-update-confirm-text").textContent).toBe(
      MESSAGES.updateRestartEnds({ terminals: 3, agents: 2 }, "en"),
    );
    expect(byId("settings-update-confirm-text").textContent).toContain("3");
    expect(dot().hidden).toBe(false);
    byId("settings-update-install-now").click();
    byId("settings-update-install-now").click();
    expect(api.updateInstall).toHaveBeenCalledTimes(1);
  });

  it("ready: without counts the confirm still shows, without numbers", async () => {
    const api = await setup({
      counts: async () => {
        throw new Error("core gone");
      },
    });
    toReady(api);
    await settle();
    expect(shown("settings-update-confirm")).toBe(true);
    expect(byId("settings-update-confirm-text").textContent).toBe(
      MESSAGES.updateRestartEnds(undefined, "en"),
    );
  });

  it("Later hides the confirm and keeps an Install now on the card", async () => {
    const api = await setup();
    toReady(api);
    await settle();
    byId("settings-update-later").click();
    expect(shown("settings-update-confirm")).toBe(false);
    expect(shown("settings-update-install")).toBe(true);
    expect(byId("settings-update-install").textContent).toBe(MESSAGES.updateInstallNow("en"));
    expect(api.updateInstall).not.toHaveBeenCalled();
    // A later push of the same ready state does not reopen it.
    api.push({ ...available, phase: "ready" });
    await settle();
    expect(shown("settings-update-confirm")).toBe(false);
    // Install now on the card asks again before restarting.
    byId("settings-update-install").click();
    await settle();
    expect(shown("settings-update-confirm")).toBe(true);
    expect(api.updateDownload).not.toHaveBeenCalled();
    expect(api.updateInstall).not.toHaveBeenCalled();
  });

  it("ready on its own (a reload, a re-check) offers Install now without asking", async () => {
    const api = await setup();
    api.push({ ...available, phase: "ready" });
    await settle();
    expect(shown("settings-update-confirm")).toBe(false);
    expect(byId("settings-update-install").textContent).toBe(MESSAGES.updateInstallNow("en"));
    expect(dot().hidden).toBe(false);
  });

  it("installing: no buttons left to press", async () => {
    const api = await setup();
    api.push({ ...available, phase: "installing" });
    expect(shown("settings-update-install")).toBe(false);
    expect(shown("settings-update-confirm")).toBe(false);
    expect(byId("settings-update-status").textContent).toBe(MESSAGES.updateInstalling("en"));
  });

  it("an error shows its own line; a failed download can be tried again", async () => {
    const api = await setup();
    api.push({ ...available, phase: "error", error: "mismatch" });
    expect(byId("settings-update-status").textContent).toBe(MESSAGES.updateError("mismatch", "en"));
    expect(shown("settings-update-install")).toBe(true);
    expect(dot().hidden).toBe(true);
    byId("settings-update-install").click();
    expect(api.updateDownload).toHaveBeenCalledTimes(1);
  });

  it("no build for this computer: the release link, no install", async () => {
    const api = await setup();
    api.push({ ...available, phase: "error", error: "no-asset" });
    expect(byId("settings-update-status").textContent).toBe(MESSAGES.updateError("no-asset", "en"));
    expect(shown("settings-update-install")).toBe(false);
    expect(shown("settings-update-notes-link")).toBe(true);
  });

  it("install blockers offer no download; retryable errors do", async () => {
    const api = await setup();
    for (const error of ["read-only", "translocated", "not-appimage", "dev-build"] as const) {
      api.push({ ...available, phase: "error", error });
      expect(shown("settings-update-install")).toBe(false);
      // The updater reports these at check time, so the card still names the
      // release and links its page: the user's way to get it by hand.
      expect(byId("settings-update-status").textContent).toBe(MESSAGES.updateError(error, "en"));
      expect(byId("settings-update-title").textContent).toBe(
        MESSAGES.updateNewer("0.1.9", "0.1.8", "en"),
      );
      expect(shown("settings-update-notes-link")).toBe(true);
    }
    for (const error of ["download", "mismatch", "no-sums", "swap", "offline"] as const) {
      api.push({ ...available, phase: "error", error });
      expect(shown("settings-update-install")).toBe(true);
    }
  });

  it("Check now comes back when the first check fails outright", async () => {
    const api = await setup();
    api.updateCheck.mockImplementationOnce(async () => {
      throw new Error("ipc gone");
    });
    byId("settings-update-check").click();
    expect((byId("settings-update-check") as HTMLButtonElement).disabled).toBe(true);
    await settle();
    expect((byId("settings-update-check") as HTMLButtonElement).disabled).toBe(false);
  });

  it("installing hides Full notes", async () => {
    const api = await setup();
    api.push({ ...available, phase: "installing" });
    expect(shown("settings-update-notes-link")).toBe(false);
  });

  it("offline with nothing known: one line, no card", async () => {
    const api = await setup();
    api.push({ ...base, phase: "error", error: "offline" });
    expect(byId("settings-update-status").textContent).toBe(MESSAGES.updateError("offline", "en"));
    expect(shown("settings-update-card")).toBe(false);
  });
});

describe("update error strings", () => {
  const errors: UpdateError[] = [
    "offline",
    "no-asset",
    "no-sums",
    "mismatch",
    "download",
    "read-only",
    "translocated",
    "not-appimage",
    "dev-build",
    "swap",
  ];
  it("every UpdateError has its own English and Arabic line", () => {
    const en = errors.map((error) => MESSAGES.updateError(error, "en"));
    const ar = errors.map((error) => MESSAGES.updateError(error, "ar"));
    expect(new Set(en).size).toBe(errors.length);
    expect(new Set(ar).size).toBe(errors.length);
    for (const line of ar) expect(line).toMatch(/[؀-ۿ]/);
    for (const line of en) expect(line).not.toMatch(/[؀-ۿ]/);
  });
});
