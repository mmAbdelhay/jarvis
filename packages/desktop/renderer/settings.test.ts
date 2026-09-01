// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { JarvisConfig } from "../src/config.js";
import { initSettings, openSettings } from "./settings.js";

type Recorded = { call: string; args: unknown[] };

function sample(): JarvisConfig {
  return {
    registry: {
      agents: {
        "claude-mm": { command: "claude-mm", model: "opus", default: true, configDir: "/x/.claude-mm" },
        copilot: { command: "copilot" },
      },
      routing: [{ match: { project: "acme" }, agent: "claude-mm" }],
    },
    projects: { acme: "/x/projects/acme" },
    databases: {},
    brain: { systemPrompt: "You are Jarvis.", cwd: "/x/.config/jarvis/brain", accountId: "claude-mm" },
    whisper: { binaryPath: "/opt/whisper/bin", modelPath: "/opt/whisper/model.bin" },
    sessionsDbPath: "/x/.config/jarvis/sessions.db",
  };
}

function harness(config: JarvisConfig = sample()): { calls: Recorded[]; config: JarvisConfig } {
  document.body.innerHTML = `
    <div id="settings-status"></div>
    <button id="settings-restart" hidden></button>
    <button id="settings-save"></button>
    <button id="settings-agent-add"></button>
    <div id="settings-agents"></div>
    <button id="settings-routing-add"></button>
    <div id="settings-routing"></div>
    <button id="settings-project-add"></button>
    <div id="settings-projects"></div>
    <input id="settings-brain-cwd" />
    <select id="settings-brain-account"></select>
    <textarea id="settings-brain-prompt"></textarea>
    <input id="settings-whisper-binary" />
    <input id="settings-whisper-model" />`;

  const calls: Recorded[] = [];
  (window as unknown as { jarvis: Record<string, unknown> }).jarvis = {
    getSettings: () => Promise.resolve(config),
    saveSettings: (draft: unknown) => {
      calls.push({ call: "saveSettings", args: [draft] });
      return Promise.resolve({ ok: true });
    },
    testAgent: (agent: unknown) => {
      calls.push({ call: "testAgent", args: [agent] });
      return Promise.resolve({ id: "x", ok: true, detail: "1.0.0" });
    },
    restartApp: () => {
      calls.push({ call: "restartApp", args: [] });
      return Promise.resolve();
    },
  };
  return { calls, config };
}

function change(element: Element): void {
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  harness();
  initSettings();
});

describe("openSettings", () => {
  it("draws one row per configured agent", async () => {
    await openSettings();

    expect(document.querySelectorAll("#settings-agents .settings-row")).toHaveLength(2);
  });

  it("draws one row per routing rule", async () => {
    await openSettings();

    expect(document.querySelectorAll("#settings-routing .settings-row")).toHaveLength(1);
  });

  it("draws one row per project", async () => {
    await openSettings();

    expect(document.querySelectorAll("#settings-projects .settings-row")).toHaveLength(1);
  });

  it("populates the brain fields", async () => {
    await openSettings();

    expect((document.getElementById("settings-brain-cwd") as HTMLInputElement).value).toBe(
      "/x/.config/jarvis/brain",
    );
    expect((document.getElementById("settings-brain-prompt") as HTMLTextAreaElement).value).toBe(
      "You are Jarvis.",
    );
    expect((document.getElementById("settings-brain-account") as HTMLSelectElement).value).toBe(
      "claude-mm",
    );
  });

  it("populates the whisper fields", async () => {
    await openSettings();

    expect((document.getElementById("settings-whisper-binary") as HTMLInputElement).value).toBe(
      "/opt/whisper/bin",
    );
  });

  // Mirrors parseConfig's own requirement: only an agent with a configDir
  // can be brain.accountId, so the UI cannot even offer one without.
  it("offers only agents with a configDir as the brain account", async () => {
    await openSettings();

    const options = [...(document.getElementById("settings-brain-account") as HTMLSelectElement).options]
      .map((option) => option.value)
      .filter((value) => value !== "");

    expect(options).toEqual(["claude-mm"]);
  });

  it("populates the routing rule's agent select from the current agents", async () => {
    await openSettings();

    const options = [...document.querySelector("#settings-routing select")!.children].map(
      (option) => (option as HTMLOptionElement).value,
    );

    expect(options).toContain("claude-mm");
    expect(options).toContain("copilot");
  });
});

describe("settings row editing", () => {
  it("commits an agent field edit into the draft on change, not on input", async () => {
    const { calls } = harness();
    initSettings();
    await openSettings();
    const commandInput = document.querySelectorAll<HTMLInputElement>(
      "#settings-agents .settings-row input",
    )[1] as HTMLInputElement;

    commandInput.value = "claude-mm-renamed-command";
    commandInput.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    // The edit is not committed yet — only "input" fired, not "change" —
    // so the draft actually sent to Save still has the original value.
    const saved = calls.find((entry) => entry.call === "saveSettings");
    const sent = saved?.args[0] as JarvisConfig | undefined;
    expect(sent?.registry.agents["claude-mm"]?.command).toBe("claude-mm");
  });

  it("adds a new blank agent row", async () => {
    await openSettings();

    document.getElementById("settings-agent-add")?.click();

    expect(document.querySelectorAll("#settings-agents .settings-row")).toHaveLength(3);
  });

  it("removes an agent row", async () => {
    await openSettings();
    const removeButtons = document.querySelectorAll<HTMLElement>(
      "#settings-agents .settings-row-remove",
    );

    removeButtons[0]?.click();

    expect(document.querySelectorAll("#settings-agents .settings-row")).toHaveLength(1);
  });

  // The spec's own explicit requirement: deleting an agent must not leave a
  // routing rule or brain.accountId silently pointing at nothing.
  it("blanks a routing rule's target when its agent is deleted", async () => {
    await openSettings();
    const removeButtons = document.querySelectorAll<HTMLElement>(
      "#settings-agents .settings-row-remove",
    );
    // claude-mm is the first agent row and is targeted by the one routing
    // rule in the fixture.
    removeButtons[0]?.click();

    const agentSelect = document.querySelector<HTMLSelectElement>("#settings-routing select");
    expect(agentSelect?.value).toBe("");
  });

  it("clears brain.accountId when the agent it names is deleted", async () => {
    await openSettings();
    const removeButtons = document.querySelectorAll<HTMLElement>(
      "#settings-agents .settings-row-remove",
    );
    removeButtons[0]?.click();

    expect((document.getElementById("settings-brain-account") as HTMLSelectElement).value).toBe("");
  });

  it("adds a new blank routing rule", async () => {
    await openSettings();

    document.getElementById("settings-routing-add")?.click();

    expect(document.querySelectorAll("#settings-routing .settings-row")).toHaveLength(2);
  });

  it("adds a new blank project row", async () => {
    await openSettings();

    document.getElementById("settings-project-add")?.click();

    expect(document.querySelectorAll("#settings-projects .settings-row")).toHaveLength(2);
  });

  it("removes a project row", async () => {
    await openSettings();
    document.querySelector<HTMLElement>("#settings-projects .settings-row-remove")?.click();

    expect(document.querySelectorAll("#settings-projects .settings-row")).toHaveLength(0);
  });

  it("renaming a project's name keeps its path", async () => {
    await openSettings();
    const nameInput = document.querySelector<HTMLInputElement>("#settings-projects input")!;

    nameInput.value = "acme-renamed";
    change(nameInput);
    document.getElementById("settings-save")?.click();
    await Promise.resolve();
  });
});

describe("Test button", () => {
  it("calls testAgent with the draft row's own command, without saving", async () => {
    const { calls } = harness();
    initSettings();
    await openSettings();
    const testButtons = [...document.querySelectorAll("#settings-agents button")].filter(
      (button) => button.textContent === "Test",
    );

    (testButtons[0] as HTMLElement).click();
    await Promise.resolve();

    expect(calls.some((entry) => entry.call === "testAgent")).toBe(true);
    expect(calls.some((entry) => entry.call === "saveSettings")).toBe(false);
  });

  it("shows a check mark for a healthy agent", async () => {
    await openSettings();
    const testButtons = [...document.querySelectorAll("#settings-agents button")].filter(
      (button) => button.textContent === "Test",
    );

    (testButtons[0] as HTMLElement).click();
    await Promise.resolve();

    expect(document.querySelector(".settings-test-status")?.textContent).toBe("✓");
  });

  it("shows a cross for an unhealthy agent", async () => {
    harness();
    initSettings();
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis["testAgent"] = () =>
      Promise.resolve({ id: "x", ok: false, detail: "command not found" });
    await openSettings();
    const testButtons = [...document.querySelectorAll("#settings-agents button")].filter(
      (button) => button.textContent === "Test",
    );

    (testButtons[0] as HTMLElement).click();
    await Promise.resolve();

    expect(document.querySelector(".settings-test-status")?.textContent).toBe("✗");
  });
});

describe("Save and restart", () => {
  it("sends the whole draft on Save", async () => {
    const { calls } = harness();
    initSettings();
    await openSettings();

    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.call).toBe("saveSettings");
  });

  it("shows the restart prompt after a successful save", async () => {
    await openSettings();

    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    expect((document.getElementById("settings-restart") as HTMLElement).hidden).toBe(false);
    expect(document.getElementById("settings-status")?.textContent).toBe("Saved.");
  });

  it("shows the headline and technical detail on a failed save, without a restart prompt", async () => {
    harness();
    initSettings();
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis["saveSettings"] = () =>
      Promise.resolve({
        ok: false,
        text: "Couldn't save settings — see below.",
        detail: "Config `agents.x.command` must be a string",
        language: "en",
      });
    await openSettings();

    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    const status = document.getElementById("settings-status");
    expect(status?.textContent).toContain("Couldn't save settings");
    expect(status?.textContent).toContain("Config `agents.x.command` must be a string");
    expect((document.getElementById("settings-restart") as HTMLElement).hidden).toBe(true);
  });

  it("calls restartApp when the restart button is clicked", async () => {
    const { calls } = harness();
    initSettings();
    await openSettings();
    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    document.getElementById("settings-restart")?.click();
    await Promise.resolve();

    expect(calls.some((entry) => entry.call === "restartApp")).toBe(true);
  });

  it("clears a stale save status when a field is edited again", async () => {
    await openSettings();
    document.getElementById("settings-save")?.click();
    await Promise.resolve();
    expect(document.getElementById("settings-status")?.textContent).toBe("Saved.");

    const cwd = document.getElementById("settings-brain-cwd") as HTMLInputElement;
    cwd.value = "/new/cwd";
    change(cwd);

    expect(document.getElementById("settings-status")?.textContent).toBe("");
    expect((document.getElementById("settings-restart") as HTMLElement).hidden).toBe(true);
  });
});
