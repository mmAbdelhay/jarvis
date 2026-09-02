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
    editors: {},
    clusters: {},
    headlamp: { binary: "/some/path" },
    terminal: { completion: { enabled: true, historyPath: "/h", commandLogPath: "/l" } },
    voice: {
      engine: "say" as const,
    piperBinary: "/opt/piper",
    piperModel: "/voices/alan.onnx",
    englishVoice: "Daniel",
      arabicVoice: "Majed",
      greeting: { en: "Good {timeOfDay} sir, how can I help you today?", ar: "{timeOfDay} يا سيدي" },
    },
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
    <button id="settings-database-add"></button>
    <div id="settings-databases"></div>
    <button id="settings-editor-add"></button>
    <div id="settings-editors"></div>
    <input id="settings-brain-cwd" />
    <select id="settings-brain-account"></select>
    <textarea id="settings-brain-prompt"></textarea>
    <select id="settings-voice-en"></select>
    <button id="settings-voice-en-play"></button>
    <select id="settings-voice-ar"></select>
    <button id="settings-voice-ar-play"></button>
    <div id="settings-voice-note"></div>
    <textarea id="settings-greeting-en"></textarea>
    <textarea id="settings-greeting-ar"></textarea>
    <input id="settings-whisper-binary" />
    <input id="settings-whisper-model" />`;

  const calls: Recorded[] = [];
  (window as unknown as { jarvis: Record<string, unknown> }).jarvis = {
    getSettings: () => Promise.resolve(config),
    listVoices: () =>
      Promise.resolve([
        { name: "Alan (neural)", language: "en_GB", upgraded: true, engine: "piper" },
        { name: "Daniel", language: "en_GB", upgraded: false, engine: "say" },
        { name: "Daniel (Enhanced)", language: "en_GB", upgraded: true, engine: "say" },
        { name: "Samantha", language: "en_US", upgraded: false, engine: "say" },
        { name: "Majed", language: "ar_001", upgraded: false, engine: "say" },
      ]),
    previewVoice: (...args: unknown[]) => {
      calls.push({ call: "previewVoice", args });
      return Promise.resolve();
    },
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

describe("databases section", () => {
  function withConnections(): JarvisConfig {
    return {
      ...sample(),
      databases: {
        acme: [
          { id: "main", label: "Local", engine: "mysql", host: "127.0.0.1", port: 3306, user: "root" },
        ],
      },
    };
  }

  it("renders one row per connection", async () => {
    harness(withConnections());
    initSettings();
    await openSettings();

    expect(document.querySelectorAll("#settings-databases .settings-row")).toHaveLength(1);
  });

  it("edits a connection field into the draft", async () => {
    const { calls } = harness(withConnections());
    initSettings();
    await openSettings();

    const host = document.querySelector<HTMLInputElement>(
      '#settings-databases input[data-field="host"]',
    )!;
    host.value = "db.internal";
    change(host);
    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    const saved = calls.find((entry) => entry.call === "saveSettings")?.args[0] as JarvisConfig;
    expect(saved.databases["acme"]?.[0]?.host).toBe("db.internal");
  });

  it("commits a port as a number, and ignores a non-numeric one", async () => {
    const { calls } = harness(withConnections());
    initSettings();
    await openSettings();

    const port = document.querySelector<HTMLInputElement>(
      '#settings-databases input[data-field="port"]',
    )!;
    port.value = "3307";
    change(port);
    port.value = "not a port";
    change(port);
    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    const saved = calls.find((entry) => entry.call === "saveSettings")?.args[0] as JarvisConfig;
    expect(saved.databases["acme"]?.[0]?.port).toBe(3307);
  });

  it("removes a connection from its own remove control", async () => {
    harness(withConnections());
    initSettings();
    await openSettings();

    document.querySelector<HTMLElement>("#settings-databases .settings-row-remove")?.click();

    expect(document.querySelectorAll("#settings-databases .settings-row")).toHaveLength(0);
  });

  it("adds a connection with an id that does not collide", async () => {
    harness(withConnections());
    initSettings();
    await openSettings();

    document.getElementById("settings-database-add")?.click();

    const ids = [...document.querySelectorAll<HTMLInputElement>(
      '#settings-databases input[data-field="id"]',
    )].map((input) => input.value);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("disables + Add connection when no project is configured", async () => {
    harness({ ...sample(), projects: {}, databases: {}, registry: sample().registry });
    initSettings();
    await openSettings();

    expect((document.getElementById("settings-database-add") as HTMLButtonElement).disabled).toBe(true);
  });

  it("moves a connection between projects through its project select", async () => {
    const config = withConnections();
    config.projects = { acme: "/x/a", "storefront": "/x/b" };
    const { calls } = harness(config);
    initSettings();
    await openSettings();

    const select = document.querySelector<HTMLSelectElement>("#settings-databases select")!;
    select.value = "storefront";
    change(select);
    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    const saved = calls.find((entry) => entry.call === "saveSettings")?.args[0] as JarvisConfig;
    expect(saved.databases["acme"]).toBeUndefined();
    expect(saved.databases["storefront"]?.[0]?.id).toBe("main");
  });

  // A connection keyed to a project that no longer exists is a config
  // parseConfig would reject outright, so the two mutations travel together.
  it("drops a deleted project's connections in the same mutation", async () => {
    const { calls } = harness(withConnections());
    initSettings();
    await openSettings();

    document.querySelector<HTMLElement>("#settings-projects .settings-row-remove")?.click();
    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    const saved = calls.find((entry) => entry.call === "saveSettings")?.args[0] as JarvisConfig;
    expect(saved.databases["acme"]).toBeUndefined();
  });

  it("follows a project rename", async () => {
    const { calls } = harness(withConnections());
    initSettings();
    await openSettings();

    const nameInput = document.querySelector<HTMLInputElement>("#settings-projects input")!;
    nameInput.value = "acme-2";
    change(nameInput);
    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    const saved = calls.find((entry) => entry.call === "saveSettings")?.args[0] as JarvisConfig;
    expect(saved.databases["acme"]).toBeUndefined();
    expect(saved.databases["acme-2"]?.[0]?.id).toBe("main");
  });
});

describe("editor roots section", () => {
  function withRoots(): JarvisConfig {
    return {
      ...sample(),
      editors: { acme: [{ name: "portal-vue", path: "portal-vue" }] },
    };
  }

  async function saved(calls: Recorded[]): Promise<JarvisConfig> {
    document.getElementById("settings-save")?.click();
    await Promise.resolve();
    return calls.find((entry) => entry.call === "saveSettings")?.args[0] as JarvisConfig;
  }

  it("renders one row per root", async () => {
    harness(withRoots());
    initSettings();
    await openSettings();

    expect(document.querySelectorAll("#settings-editors .settings-row")).toHaveLength(1);
  });

  it("edits a root's path into the draft", async () => {
    const { calls } = harness(withRoots());
    initSettings();
    await openSettings();

    const path = document.querySelector<HTMLInputElement>('#settings-editors input[data-field="path"]')!;
    path.value = "services/api";
    change(path);

    expect((await saved(calls)).editors["acme"]?.[0]?.path).toBe("services/api");
  });

  it("renames a root", async () => {
    const { calls } = harness(withRoots());
    initSettings();
    await openSettings();

    const name = document.querySelector<HTMLInputElement>('#settings-editors input[data-field="name"]')!;
    name.value = "portal";
    change(name);

    expect((await saved(calls)).editors["acme"]?.[0]?.name).toBe("portal");
  });

  // The rule the whole Settings route is built on: a re-render per keystroke
  // takes the focus out of the field mid-word.
  it("commits on change, never on input", async () => {
    const { calls } = harness(withRoots());
    initSettings();
    await openSettings();

    const path = document.querySelector<HTMLInputElement>('#settings-editors input[data-field="path"]')!;
    path.value = "half-typ";
    path.dispatchEvent(new Event("input", { bubbles: true }));

    expect((await saved(calls)).editors["acme"]?.[0]?.path).toBe("portal-vue");
  });

  it("removes a root from its own remove control", async () => {
    harness(withRoots());
    initSettings();
    await openSettings();

    document.querySelector<HTMLElement>("#settings-editors .settings-row-remove")?.click();

    expect(document.querySelectorAll("#settings-editors .settings-row")).toHaveLength(0);
  });

  it("adds a root with a name that does not collide", async () => {
    harness(withRoots());
    initSettings();
    await openSettings();

    document.getElementById("settings-editor-add")?.click();

    const names = [
      ...document.querySelectorAll<HTMLInputElement>('#settings-editors input[data-field="name"]'),
    ].map((input) => input.value);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  it("disables + Add root when no project is configured", async () => {
    harness({ ...sample(), projects: {}, editors: {}, registry: sample().registry });
    initSettings();
    await openSettings();

    expect((document.getElementById("settings-editor-add") as HTMLButtonElement).disabled).toBe(true);
  });

  it("moves a root between projects through its project select", async () => {
    const config = withRoots();
    config.projects = { acme: "/x/a", "storefront": "/x/b" };
    const { calls } = harness(config);
    initSettings();
    await openSettings();

    const select = document.querySelector<HTMLSelectElement>("#settings-editors select")!;
    select.value = "storefront";
    change(select);

    const config2 = await saved(calls);
    expect(config2.editors["acme"]).toBeUndefined();
    expect(config2.editors["storefront"]?.[0]?.name).toBe("portal-vue");
  });

  // Same reasoning as the databases section: a root keyed to a project that
  // no longer exists is a config parseConfig would refuse to load.
  it("drops a deleted project's roots in the same mutation", async () => {
    const { calls } = harness(withRoots());
    initSettings();
    await openSettings();

    document.querySelector<HTMLElement>("#settings-projects .settings-row-remove")?.click();

    expect((await saved(calls)).editors["acme"]).toBeUndefined();
  });

  it("follows a project rename", async () => {
    const { calls } = harness(withRoots());
    initSettings();
    await openSettings();

    const nameInput = document.querySelector<HTMLInputElement>("#settings-projects input")!;
    nameInput.value = "acme-2";
    change(nameInput);

    const config = await saved(calls);
    expect(config.editors["acme"]).toBeUndefined();
    expect(config.editors["acme-2"]?.[0]?.name).toBe("portal-vue");
  });
});

describe("voice section", () => {
  /** Settings loads the voice list after its first render. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  }

  it("offers the installed voices for each language", async () => {
    harness();
    initSettings();
    await openSettings();
    await settle();

    const english = [...document.querySelectorAll("#settings-voice-en option")].map((o) => o.textContent);
    expect(english).toEqual([
      "Alan (neural) · en_GB",
      "Daniel · en_GB",
      "Daniel (Enhanced) · en_GB",
      "Samantha · en_US",
    ]);

    const arabic = [...document.querySelectorAll("#settings-voice-ar option")].map((o) => o.textContent);
    expect(arabic).toEqual(["Majed · ar_001"]);
  });

  it("selects the configured voice", async () => {
    harness();
    initSettings();
    await openSettings();
    await settle();

    expect((document.getElementById("settings-voice-en") as HTMLSelectElement).value).toBe("Daniel");
  });

  // Opening Settings must not silently rewrite a configured voice to
  // whatever happened to come first in the list.
  it("keeps a configured voice that is not installed selectable", async () => {
    const config = sample();
    config.voice.englishVoice = "Oliver";
    harness(config);
    initSettings();
    await openSettings();
    await settle();

    const select = document.getElementById("settings-voice-en") as HTMLSelectElement;
    expect(select.value).toBe("Oliver");
    expect(select.options[0]?.textContent).toBe("Oliver (not installed)");
  });

  it("plays a sample in the selected voice", async () => {
    const { calls } = harness();
    initSettings();
    await openSettings();
    await settle();

    document.getElementById("settings-voice-en-play")?.click();

    expect(calls).toContainEqual({ call: "previewVoice", args: ["Daniel", "en"] });
  });

  // The difference between a user who thinks the app sounds bad and one who
  // knows there is a better voice a download away.
  it("says how to get better voices when only compact ones are installed", async () => {
    const { calls } = harness();
    void calls;
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis["listVoices"] = () =>
      Promise.resolve([{ name: "Daniel", language: "en_GB", upgraded: false, engine: "say" }]);
    initSettings();
    await openSettings();
    await settle();

    expect(document.getElementById("settings-voice-note")?.textContent).toContain("Manage Voices");
  });

  it("says nothing when an upgraded voice is already installed", async () => {
    harness();
    initSettings();
    await openSettings();
    await settle();

    expect(document.getElementById("settings-voice-note")?.textContent).toBe("");
  });

  it("saves an edited voice and greeting", async () => {
    const { calls } = harness();
    initSettings();
    await openSettings();
    await settle();

    const voice = document.getElementById("settings-voice-en") as HTMLSelectElement;
    voice.value = "Daniel (Enhanced)";
    change(voice);
    const greeting = document.getElementById("settings-greeting-en") as HTMLTextAreaElement;
    greeting.value = "Evening, boss.";
    change(greeting);

    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    const saved = calls.find((entry) => entry.call === "saveSettings")?.args[0] as JarvisConfig;
    expect(saved.voice.englishVoice).toBe("Daniel (Enhanced)");
    expect(saved.voice.greeting.en).toBe("Evening, boss.");
  });
});

describe("choosing the engine by choosing a voice", () => {
  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  }

  // The picker is the single control: there is no second switch to get out of
  // step with the name on screen.
  it("switches to the neural engine when its voice is chosen", async () => {
    const { calls } = harness();
    initSettings();
    await openSettings();
    await settle();

    const select = document.getElementById("settings-voice-en") as HTMLSelectElement;
    select.value = "Alan (neural)";
    change(select);
    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    const saved = calls.find((entry) => entry.call === "saveSettings")?.args[0] as JarvisConfig;
    expect(saved.voice.engine).toBe("piper");
  });

  it("switches back to say when a system voice is chosen", async () => {
    const config = sample();
    config.voice.engine = "piper";
    const { calls } = harness(config);
    initSettings();
    await openSettings();
    await settle();

    const select = document.getElementById("settings-voice-en") as HTMLSelectElement;
    select.value = "Samantha";
    change(select);
    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    const saved = calls.find((entry) => entry.call === "saveSettings")?.args[0] as JarvisConfig;
    expect(saved.voice.engine).toBe("say");
    expect(saved.voice.englishVoice).toBe("Samantha");
  });

  it("shows the neural voice as selected when it is the engine", async () => {
    const config = sample();
    config.voice.engine = "piper";
    harness(config);
    initSettings();
    await openSettings();
    await settle();

    expect((document.getElementById("settings-voice-en") as HTMLSelectElement).value).toBe(
      "Alan (neural)",
    );
  });
});
