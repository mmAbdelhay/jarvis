// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RendererApi } from "../src/ipc.js";
import type { UpdateCheck } from "../src/update-check.js";

async function setup(answer: UpdateCheck) {
  vi.resetModules();
  document.body.innerHTML = `
    <button id="settings-update-check"></button>
    <span id="settings-update-result"></span>
    <button id="settings-update-open" hidden></button>`;
  const api = {
    checkForUpdate: vi.fn(async () => answer),
    openTab: vi.fn(async () => {}),
  };
  window.jarvis = api as unknown as RendererApi;
  const { initUpdateSettings } = await import("./update-settings.js");
  initUpdateSettings();
  return api;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const byId = (id: string) => document.getElementById(id) as HTMLElement;

describe("Check for updates", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("asks nothing until the button is pressed", async () => {
    const api = await setup({ kind: "current", current: "0.1.5" });
    await settle();
    expect(api.checkForUpdate).not.toHaveBeenCalled();
  });

  it("names a newer release and opens its page in the Personal browser", async () => {
    const api = await setup({
      kind: "newer",
      current: "0.1.5",
      latest: "0.1.6",
      url: "https://github.com/mmAbdelhay/jarvis/releases/tag/v0.1.6",
      notes: "",
      assets: [],
    });
    byId("settings-update-check").click();
    await settle();
    expect(byId("settings-update-result").textContent).toContain("0.1.6");
    expect(byId("settings-update-open").hidden).toBe(false);

    byId("settings-update-open").click();
    expect(api.openTab).toHaveBeenCalledWith(
      "__personal__",
      "https://github.com/mmAbdelhay/jarvis/releases/tag/v0.1.6",
    );
  });

  it("offers no link when this is the latest, or the check failed", async () => {
    await setup({ kind: "current", current: "0.1.5" });
    byId("settings-update-check").click();
    await settle();
    expect(byId("settings-update-open").hidden).toBe(true);

    await setup({ kind: "failed", current: "0.1.5" });
    byId("settings-update-check").click();
    await settle();
    expect(byId("settings-update-open").hidden).toBe(true);
    expect(byId("settings-update-result").textContent).not.toBe("");
  });
});
