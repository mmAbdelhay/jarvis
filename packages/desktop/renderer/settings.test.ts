// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig, type JarvisConfig } from "../src/config.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { PERSONAL_PROJECT } from "../src/personal.js";
import type { BindChoice } from "@jarvis/remote";
import { initSettings, openSettings, savePrayerSettings } from "./settings.js";
import { encodeQr, qrToCanvas } from "./vendor/qr.js";

// The real encoder is unit-tested on its own (vendor/qr.test.ts); here we
// only need to see how settings.ts calls it — with exactly the pairing
// link, only while a pairing window is open.
vi.mock("./vendor/qr.js", () => ({
  encodeQr: vi.fn(() => ({ size: 21, modules: [] })),
  qrToCanvas: vi.fn(),
}));

// jsdom implements no canvas context and logs a "not implemented" warning
// on every getContext("2d") call otherwise — settings.ts's clear-on-closed
// path calls it on every non-open pairing render, which is most tests in
// this file. Stub a minimal 2D context once so output stays pristine; the
// dedicated clearRect test below overrides it for a single call.
const fakeQrContext = { fillStyle: "", fillRect: () => {}, clearRect: () => {} };
const qrCanvasGetContext = vi
  .spyOn(HTMLCanvasElement.prototype, "getContext")
  .mockReturnValue(fakeQrContext as unknown as CanvasRenderingContext2D);

type Recorded = { call: string; args: unknown[] };

function sample(): JarvisConfig {
  return {
    registry: {
      agents: {
        "claude-main": {
          command: "claude-main",
          model: "opus",
          default: true,
          configDir: "/x/.claude-main",
        },
        copilot: { command: "copilot" },
      },
      routing: [{ match: { project: "acme" }, agent: "claude-main" }],
    },
    projects: { acme: "/x/projects/acme" },
    databases: {},
    editors: {},
    clusters: {},
    docker: {},
    chat: {},
    workflows: {},
    headlamp: { binary: "/some/path" },
    prayer: { enabled: false },
    terminal: {
      completion: { enabled: true, historyPath: "/h", commandLogPath: "/l" },
      blocks: { enabled: true, inputEditor: true },
      notifyAfterSeconds: 30,
    },
    voice: {
      engine: "say" as const,
      piperBinary: "/opt/piper",
      piperModel: "/voices/alan.onnx",
      piperArabicModel: "/voices/ar.onnx",
      englishVoice: "Daniel",
      arabicVoice: "Majed",
      greeting: {
        en: "Good {timeOfDay} sir, how can I help you today?",
        ar: "{timeOfDay} يا سيدي",
      },
      speakGreeting: true,
    },
    brain: {
      systemPrompt: "You are Jarvis.",
      cwd: "/x/.config/jarvis/brain",
      accountId: "claude-main",
    },
    whisper: { binaryPath: "/opt/whisper/bin", modelPath: "/opt/whisper/model.bin" },
    performance: {
      suspendTabsAfterMinutes: 15,
      stopSidecarsAfterMinutes: 10,
      terminalScrollback: 5000,
    },
    browser: { allowPopups: true },
    sessions: { importWindowDays: 30 },
    remote: {
      enabled: false,
      bindAddress: "127.0.0.1",
      port: 7717,
      sidecarProxy: false,
      tls: {},
      push: { enabled: false, includeProjectNames: false },
      idleDisableMinutes: 0,
    },
    sessionsDbPath: "/x/.config/jarvis/sessions.db",
  };
}

/** The config a recorded `saveSettings` call carried.
 *
 *  Written as a function because `savedConfig(saved).docker`
 *  puts the member access outside the optional chain: a test where Save never
 *  fired would throw on undefined rather than fail with a reason. */
function savedConfig(saved: Recorded | undefined): JarvisConfig {
  if (saved === undefined) throw new Error("saveSettings was never called");
  return saved.args[0] as JarvisConfig;
}

function harness(config: JarvisConfig = sample()): { calls: Recorded[]; config: JarvisConfig } {
  document.body.innerHTML = `
    <div id="settings-status"></div>
    <button id="settings-restart" hidden></button>
    <button id="settings-tools"></button>
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
    <button id="settings-docker-add"></button>
    <button id="settings-docker-autopopulate"></button>
    <div id="settings-docker"></div>
    <div id="settings-docker-picker" hidden></div>
    <button id="settings-chat-add"></button>
    <div id="settings-chat"></div>
    <input id="settings-brain-cwd" />
    <select id="settings-brain-account"></select>
    <textarea id="settings-brain-prompt"></textarea>
    <select id="settings-voice-en"></select>
    <button id="settings-voice-en-play"></button>
    <select id="settings-voice-ar"></select>
    <button id="settings-voice-ar-play"></button>
    <div id="settings-voice-note"></div>
    <input id="settings-speak-greeting" type="checkbox" />
    <textarea id="settings-greeting-en"></textarea>
    <textarea id="settings-greeting-ar"></textarea>
    <input id="settings-allow-popups" type="checkbox" />
    <input id="settings-browser-homepage" />
    <input id="settings-whisper-binary" />
    <input id="settings-whisper-model" />
    <div id="settings-remote-title"></div>
    <label id="settings-remote-enabled-label"></label>
    <input id="settings-remote-enabled" type="checkbox" />
    <span id="settings-remote-state"></span>
    <label id="settings-remote-idle-label"></label>
    <input id="settings-remote-idle" />
    <div id="settings-remote-idle-note"></div>
    <div id="settings-remote-idle-state" hidden></div>
    <span id="settings-remote-reachable-label"></span>
    <div id="settings-remote-choices"></div>
    <div id="settings-remote-all-note" hidden></div>
    <label id="settings-remote-port-label"></label>
    <input id="settings-remote-port" />
    <div id="settings-remote-port-note"></div>
    <label id="settings-remote-proxy-label"></label>
    <input id="settings-remote-proxy" type="checkbox" />
    <div id="settings-remote-proxy-note"></div>
    <div id="settings-remote-certificate" hidden></div>
    <span id="settings-remote-cert-status"></span>
    <button id="settings-remote-cert-button"></button>
    <div id="settings-remote-cert-error" hidden></div>
    <div id="settings-remote-cert-hint" hidden></div>
    <label id="settings-remote-push-label"></label>
    <input id="settings-remote-push" type="checkbox" />
    <div id="settings-remote-push-note"></div>
    <label id="settings-remote-push-projects-label"></label>
    <input id="settings-remote-push-projects" type="checkbox" />
    <div id="settings-remote-push-projects-note"></div>
    <div id="settings-remote-problem" hidden></div>
    <div id="settings-remote-pair-title"></div>
    <button id="settings-remote-new-code"></button>
    <div id="settings-remote-pair-note"></div>
    <div id="settings-remote-pair-code"></div>
    <canvas id="remote-pair-qr" hidden></canvas>
    <div id="settings-remote-pair-fingerprint"></div>
    <div id="settings-remote-pair-expiry"></div>
    <button id="settings-remote-pair-cancel" hidden></button>
    <div id="settings-remote-devices-title"></div>
    <div id="settings-remote-devices"></div>
    <div id="settings-remote-warning"></div>
    <div id="settings-remote-no-credential"></div>`;

  const calls: Recorded[] = [];
  (window as unknown as { jarvis: Record<string, unknown> }).jarvis = {
    // The voice section's note names a macOS preference pane, so these cases
    // are written as a Mac user sees them; the Linux case sets its own.
    platform: "darwin",
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
    remoteBindChoices: () =>
      Promise.resolve([
        { address: "127.0.0.1", iface: "lo0", kind: "loopback" },
        { address: "192.168.100.69", iface: "en0", kind: "lan" },
        { address: "100.84.17.203", iface: "utun4", kind: "mesh" },
      ]),
    remoteStatus: () =>
      Promise.resolve({
        enabled: false,
        listening: undefined,
        pairing: { kind: "closed" },
        devices: [],
        problem: undefined,
      }),
    openRemotePairing: () => Promise.resolve({ ok: true, value: undefined }),
    cancelRemotePairing: () => Promise.resolve(),
    decideRemotePairing: () => Promise.resolve(),
    revokeRemoteDevice: () => Promise.resolve({ ok: true, value: undefined }),
    onRemoteStatus: () => {},
    tailscaleCert: () => {
      calls.push({ call: "tailscaleCert", args: [] });
      return Promise.resolve({
        ok: true,
        certPath: "/x/.config/jarvis/tls/m1.tailnet.ts.net.crt",
        keyPath: "/x/.config/jarvis/tls/m1.tailnet.ts.net.key",
        name: "m1.tailnet.ts.net",
      });
    },
    openTab: (...args: unknown[]) => {
      calls.push({ call: "openTab", args });
      return Promise.resolve();
    },
    dockerContainers: () =>
      Promise.resolve({
        ok: true,
        value: [
          {
            name: "acme-app-1",
            id: "a",
            image: "app:latest",
            state: "running",
            status: "running",
            ports: [],
            composeProject: "acme",
            composeWorkingDir: "/x/projects/acme",
            composeService: "app",
          },
          {
            name: "other-app-1",
            id: "b",
            image: "other:latest",
            state: "running",
            status: "running",
            ports: [],
            composeProject: "other",
            composeWorkingDir: "/x/projects/other",
            composeService: "app",
          },
        ],
      }),
  };
  return { calls, config };
}

function change(element: Element): void {
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
      "claude-main",
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

    const options = [
      ...(document.getElementById("settings-brain-account") as HTMLSelectElement).options,
    ]
      .map((option) => option.value)
      .filter((value) => value !== "");

    expect(options).toEqual(["claude-main"]);
  });

  it("populates the routing rule's agent select from the current agents", async () => {
    await openSettings();

    const options = [...document.querySelector("#settings-routing select")!.children].map(
      (option) => (option as HTMLOptionElement).value,
    );

    expect(options).toContain("claude-main");
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

    commandInput.value = "claude-main-renamed-command";
    commandInput.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    // The edit is not committed yet — only "input" fired, not "change" —
    // so the draft actually sent to Save still has the original value.
    const saved = calls.find((entry) => entry.call === "saveSettings");
    const sent = saved?.args[0] as JarvisConfig | undefined;
    expect(sent?.registry.agents["claude-main"]?.command).toBe("claude-main");
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
    // claude-main is the first agent row and is targeted by the one routing
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

describe("Save and live apply", () => {
  it("sends the whole draft on Save", async () => {
    const { calls } = harness();
    initSettings();
    await openSettings();

    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.call).toBe("saveSettings");
  });

  it("shows live apply status without a restart prompt after a successful save", async () => {
    await openSettings();

    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    expect((document.getElementById("settings-restart") as HTMLElement).hidden).toBe(true);
    expect(document.getElementById("settings-status")?.textContent).toBe(
      MESSAGES.settingsSavedLive(PRIMARY_LANGUAGE),
    );
  });

  it("keeps a restart option when startup-service settings changed", async () => {
    await openSettings();
    const cwd = document.getElementById("settings-brain-cwd") as HTMLInputElement;
    cwd.value = "/new/cwd";
    change(cwd);
    document.getElementById("settings-save")?.click();
    await Promise.resolve();
    expect((document.getElementById("settings-restart") as HTMLElement).hidden).toBe(false);
    expect(document.getElementById("settings-status")?.textContent).toBe(
      MESSAGES.settingsSavedRestart(PRIMARY_LANGUAGE),
    );
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
    expect(document.getElementById("settings-status")?.textContent).toBe(
      MESSAGES.settingsSavedLive(PRIMARY_LANGUAGE),
    );

    const cwd = document.getElementById("settings-brain-cwd") as HTMLInputElement;
    cwd.value = "/new/cwd";
    change(cwd);

    expect(document.getElementById("settings-status")?.textContent).toBe("");
    expect((document.getElementById("settings-restart") as HTMLElement).hidden).toBe(true);
  });

  it("keeps prayer edits in the draft until Save writes them", async () => {
    const { calls } = harness();
    initSettings();
    await openSettings();

    await savePrayerSettings({ enabled: true });
    expect(calls).toHaveLength(0);

    document.getElementById("settings-save")?.click();
    await Promise.resolve();
    expect(savedConfig(calls[0]).prayer).toEqual({ enabled: true });
  });
});

describe("databases section", () => {
  function withConnections(): JarvisConfig {
    return {
      ...sample(),
      databases: {
        acme: [
          {
            id: "main",
            label: "Local",
            engine: "mysql",
            host: "127.0.0.1",
            port: 3306,
            user: "root",
          },
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

    const ids = [
      ...document.querySelectorAll<HTMLInputElement>('#settings-databases input[data-field="id"]'),
    ].map((input) => input.value);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("disables + Add connection when no project is configured", async () => {
    harness({ ...sample(), projects: {}, databases: {}, registry: sample().registry });
    initSettings();
    await openSettings();

    expect((document.getElementById("settings-database-add") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("moves a connection between projects through its project select", async () => {
    const config = withConnections();
    config.projects = { acme: "/x/a", storefront: "/x/b" };
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

    const path = document.querySelector<HTMLInputElement>(
      '#settings-editors input[data-field="path"]',
    )!;
    path.value = "services/api";
    change(path);

    expect((await saved(calls)).editors["acme"]?.[0]?.path).toBe("services/api");
  });

  it("renames a root", async () => {
    const { calls } = harness(withRoots());
    initSettings();
    await openSettings();

    const name = document.querySelector<HTMLInputElement>(
      '#settings-editors input[data-field="name"]',
    )!;
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

    const path = document.querySelector<HTMLInputElement>(
      '#settings-editors input[data-field="path"]',
    )!;
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

    expect((document.getElementById("settings-editor-add") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("moves a root between projects through its project select", async () => {
    const config = withRoots();
    config.projects = { acme: "/x/a", storefront: "/x/b" };
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

    const english = [...document.querySelectorAll("#settings-voice-en option")].map(
      (o) => o.textContent,
    );
    expect(english).toEqual([
      "Alan (neural) · en_GB",
      "Daniel · en_GB",
      "Daniel (Enhanced) · en_GB",
      "Samantha · en_US",
    ]);

    const arabic = [...document.querySelectorAll("#settings-voice-ar option")].map(
      (o) => o.textContent,
    );
    expect(arabic).toEqual(["Majed · ar_001"]);
  });

  it("selects the configured voice", async () => {
    harness();
    initSettings();
    await openSettings();
    await settle();

    expect((document.getElementById("settings-voice-en") as HTMLSelectElement).value).toBe(
      "Daniel",
    );
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

  it("says nothing about Manage Voices off macOS, where that screen does not exist", async () => {
    // Every voice on the list there is a Piper model, which has no compact
    // and enhanced versions to choose between. The advice would be directions
    // to a preference pane the user does not have.
    const { calls } = harness();
    void calls;
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis["platform"] = "linux";
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis["listVoices"] = () =>
      Promise.resolve([{ name: "Daniel", language: "en_GB", upgraded: false, engine: "say" }]);
    initSettings();
    await openSettings();
    await settle();

    expect(document.getElementById("settings-voice-note")?.textContent).toBe("");
  });

  it("says nothing when an upgraded voice is already installed", async () => {
    harness();
    initSettings();
    await openSettings();
    await settle();

    expect(document.getElementById("settings-voice-note")?.textContent).toBe("");
  });

  // The greeting is the only thing the app says unprompted, so this is the
  // switch for a room that has to stay quiet. It silences the speech alone —
  // the text still reaches the conversation panel, which is why there is one
  // toggle here and not two.
  it("shows whether the greeting is spoken", async () => {
    harness();
    initSettings();
    await openSettings();
    await settle();

    expect((document.getElementById("settings-speak-greeting") as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("saves the greeting silenced", async () => {
    const { calls } = harness();
    initSettings();
    await openSettings();
    await settle();

    const toggle = document.getElementById("settings-speak-greeting") as HTMLInputElement;
    toggle.checked = false;
    change(toggle);

    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    const saved = calls.find((entry) => entry.call === "saveSettings")?.args[0] as JarvisConfig;
    expect(saved.voice.speakGreeting).toBe(false);
    // Silencing it must not touch the greeting itself.
    expect(saved.voice.greeting.en).not.toBe("");
  });

  it("shows popups as allowed by default", async () => {
    harness();
    initSettings();
    await openSettings();
    await settle();

    expect((document.getElementById("settings-allow-popups") as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("saves popups turned off", async () => {
    const { calls } = harness();
    initSettings();
    await openSettings();
    await settle();

    const toggle = document.getElementById("settings-allow-popups") as HTMLInputElement;
    toggle.checked = false;
    change(toggle);

    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    const saved = calls.find((entry) => entry.call === "saveSettings")?.args[0] as JarvisConfig;
    expect(saved.browser.allowPopups).toBe(false);
  });

  it("saves a configured default page and clears it back to unset", async () => {
    const { calls } = harness();
    initSettings();
    await openSettings();
    await settle();

    const input = document.getElementById("settings-browser-homepage") as HTMLInputElement;
    input.value = "https://example.com";
    change(input);
    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    let saved = calls.find((entry) => entry.call === "saveSettings")?.args[0] as JarvisConfig;
    expect(saved.browser.homePage).toBe("https://example.com");

    input.value = "  ";
    change(input);
    document.getElementById("settings-save")?.click();
    await Promise.resolve();

    const saves = calls.filter((entry) => entry.call === "saveSettings");
    saved = saves[saves.length - 1]?.args[0] as JarvisConfig;
    expect(saved.browser.homePage).toBeUndefined();
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

describe("settings docker section", () => {
  it("draws one row per configured container", async () => {
    const config = sample();
    config.docker = { acme: [{ name: "app", container: "acme-app-1" }] };
    harness(config);
    initSettings();
    await openSettings();

    expect(document.querySelectorAll("#settings-docker .settings-row")).toHaveLength(1);
  });

  it("pre-ticks only the containers inside the project's directory", async () => {
    await openSettings();

    document.getElementById("settings-docker-autopopulate")?.click();
    await flush();

    const boxes = [
      ...document.querySelectorAll("#settings-docker-picker input[type=checkbox]"),
    ] as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
  });

  it("changes nothing until the checklist is confirmed", async () => {
    const { calls } = harness();
    initSettings();
    await openSettings();

    document.getElementById("settings-docker-autopopulate")?.click();
    await flush();
    document.getElementById("settings-save")?.click();
    await flush();

    const saved = calls.find((entry) => entry.call === "saveSettings");
    expect(savedConfig(saved).docker).toEqual({});
  });

  it("adds exactly the ticked containers, named after their compose service", async () => {
    const { calls } = harness();
    initSettings();
    await openSettings();

    document.getElementById("settings-docker-autopopulate")?.click();
    await flush();
    document.getElementById("settings-docker-confirm")?.click();
    document.getElementById("settings-save")?.click();
    await flush();

    const saved = calls.find((entry) => entry.call === "saveSettings");
    expect(savedConfig(saved).docker).toEqual({
      acme: [{ name: "app", container: "acme-app-1" }],
    });
  });

  // Two compose stacks each with an `app` service, filed under one project:
  // parseConfig rejects duplicate names within a project, so the second one
  // has to be suffixed or Save fails on a config the picker itself wrote.
  it("de-duplicates a display name two ticked containers would share", async () => {
    const { calls } = harness();
    initSettings();
    await openSettings();

    document.getElementById("settings-docker-autopopulate")?.click();
    await flush();

    const boxes = [
      ...document.querySelectorAll("#settings-docker-picker input[type=checkbox]"),
    ] as HTMLInputElement[];
    boxes[1]!.checked = true;
    change(boxes[1]!);

    document.getElementById("settings-docker-confirm")?.click();
    document.getElementById("settings-save")?.click();
    await flush();

    const saved = calls.find((entry) => entry.call === "saveSettings");
    expect(savedConfig(saved).docker).toEqual({
      acme: [
        { name: "app", container: "acme-app-1" },
        { name: "app-2", container: "other-app-1" },
      ],
    });
  });

  // "+ Add container" used to seed an empty `container`, which parseConfig
  // refuses — Add then Save failed with a raw parser message.
  it("adds a row that is already saveable before it is filled in", async () => {
    const { calls } = harness();
    initSettings();
    await openSettings();

    document.getElementById("settings-docker-add")?.click();
    document.getElementById("settings-save")?.click();
    await flush();

    const saved = calls.find((entry) => entry.call === "saveSettings");
    expect(savedConfig(saved).docker).toEqual({
      acme: [{ name: "container-1", container: "container-1" }],
    });
    // The thing that actually matters: parseConfig accepts it.
    expect(() =>
      parseConfig({
        agents: { a: { command: "a" } },
        projects: { acme: "/x/projects/acme" },
        brain: { cwd: "/x/brain" },
        docker: savedConfig(saved).docker,
      }),
    ).not.toThrow();
  });

  it("keeps a configured container Docker no longer has", async () => {
    const config = sample();
    config.docker = { acme: [{ name: "gone", container: "acme-gone-1" }] };
    const { calls } = harness(config);
    initSettings();
    await openSettings();

    document.getElementById("settings-docker-autopopulate")?.click();
    await flush();
    document.getElementById("settings-docker-confirm")?.click();
    document.getElementById("settings-save")?.click();
    await flush();

    const saved = calls.find((entry) => entry.call === "saveSettings");
    expect(savedConfig(saved).docker["acme"]).toContainEqual({
      name: "gone",
      container: "acme-gone-1",
    });
  });

  // A container with no matching project directory must never be written
  // to a project the user did not see and could not change — the picker
  // must show, and let the user choose, exactly where it will land.
  it("assigns a manually-ticked unmatched container to the project chosen on its row, not silently to the first one", async () => {
    const config = sample();
    config.projects = { acme: "/x/projects/acme", extra: "/x/projects/extra" };
    const { calls } = harness(config);
    initSettings();
    await openSettings();

    document.getElementById("settings-docker-autopopulate")?.click();
    await flush();

    const boxes = [
      ...document.querySelectorAll("#settings-docker-picker input[type=checkbox]"),
    ] as HTMLInputElement[];
    // other-app-1 (the second container) matches no configured project's
    // directory, so it starts unticked with the row defaulting to the
    // first project — the user must move it explicitly.
    boxes[1]!.checked = true;
    boxes[1]!.dispatchEvent(new Event("change", { bubbles: true }));

    const selects = [
      ...document.querySelectorAll("#settings-docker-picker select"),
    ] as HTMLSelectElement[];
    selects[1]!.value = "extra";
    selects[1]!.dispatchEvent(new Event("change", { bubbles: true }));

    document.getElementById("settings-docker-confirm")?.click();
    document.getElementById("settings-save")?.click();
    await flush();

    const saved = savedConfig(calls.find((entry) => entry.call === "saveSettings")).docker;
    expect(saved["extra"]).toContainEqual({ name: "app", container: "other-app-1" });
    expect(saved["acme"]?.some((entry) => entry.container === "other-app-1")).toBe(false);
  });
});

describe("settings chat section", () => {
  function withChat(): JarvisConfig {
    return {
      ...sample(),
      chat: { acme: [{ name: "Acme", driver: "slack", account: "acme" }] },
    };
  }

  async function saved(calls: Recorded[]): Promise<JarvisConfig> {
    document.getElementById("settings-save")?.click();
    await Promise.resolve();
    return calls.find((entry) => entry.call === "saveSettings")?.args[0] as JarvisConfig;
  }

  it("renders one row per configured chat", async () => {
    harness(withChat());
    initSettings();
    await openSettings();

    expect(document.querySelectorAll("#settings-chat .settings-row")).toHaveLength(1);
  });

  it("offers every driver the build knows, and no others", async () => {
    harness(withChat());
    initSettings();
    await openSettings();

    const driver = document.querySelector<HTMLSelectElement>(
      '#settings-chat select[data-field="driver"]',
    )!;
    expect([...driver.options].map((option) => option.value)).toEqual(["slack", "teams"]);
  });

  it("switches a project's driver into the draft", async () => {
    const { calls } = harness(withChat());
    initSettings();
    await openSettings();

    const driver = document.querySelector<HTMLSelectElement>(
      '#settings-chat select[data-field="driver"]',
    )!;
    driver.value = "teams";
    change(driver);

    expect((await saved(calls)).chat["acme"]?.[0]?.driver).toBe("teams");
  });

  it("edits an account into the draft", async () => {
    const { calls } = harness(withChat());
    initSettings();
    await openSettings();

    const account = document.querySelector<HTMLInputElement>(
      '#settings-chat input[data-field="account"]',
    )!;
    account.value = "orbit.com";
    change(account);

    expect((await saved(calls)).chat["acme"]?.[0]?.account).toBe("orbit.com");
  });

  // An emptied account means "the provider's own picker", and parseConfig
  // rejects `account: ""` — so clearing the field must drop the key, not
  // save a config the user cannot then load.
  it("drops the account key when the field is cleared", async () => {
    const { calls } = harness(withChat());
    initSettings();
    await openSettings();

    const account = document.querySelector<HTMLInputElement>(
      '#settings-chat input[data-field="account"]',
    )!;
    account.value = "";
    change(account);

    expect((await saved(calls)).chat["acme"]?.[0]).toEqual({
      name: "Acme",
      driver: "slack",
    });
  });

  it("commits on change, never on input", async () => {
    const { calls } = harness(withChat());
    initSettings();
    await openSettings();

    const account = document.querySelector<HTMLInputElement>(
      '#settings-chat input[data-field="account"]',
    )!;
    account.value = "half-typ";
    account.dispatchEvent(new Event("input", { bubbles: true }));

    expect((await saved(calls)).chat["acme"]?.[0]?.account).toBe("acme");
  });

  it("removes a chat from its own remove control", async () => {
    harness(withChat());
    initSettings();
    await openSettings();

    document.querySelector<HTMLElement>("#settings-chat .settings-row-remove")?.click();

    expect(document.querySelectorAll("#settings-chat .settings-row")).toHaveLength(0);
  });

  it("adds a chat with a name that does not collide", async () => {
    harness(withChat());
    initSettings();
    await openSettings();

    document.getElementById("settings-chat-add")?.click();

    const names = [
      ...document.querySelectorAll<HTMLInputElement>('#settings-chat input[data-field="name"]'),
    ].map((input) => input.value);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  // parseConfig rejects a chat keyed to a project that does not exist, so
  // with no projects there is no valid row to add.
  it("disables + Add chat when no project is configured", async () => {
    harness({ ...sample(), projects: {}, chat: {} });
    initSettings();
    await openSettings();

    expect((document.getElementById("settings-chat-add") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("remote access section", () => {
  /** The address list arrives after the first render, like the voice list. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  }

  async function open(config: JarvisConfig = sample()): Promise<Recorded[]> {
    const { calls } = harness(config);
    initSettings();
    await openSettings();
    await settle();
    return calls;
  }

  /** Opens with a hand-picked address list instead of the default harness's
   *  loopback/en0/utun4 trio — for the cases that care whether a Tailscale
   *  or a Wi-Fi address exists at all. */
  async function openWithChoices(
    choices: BindChoice[],
    config: JarvisConfig = sample(),
  ): Promise<Recorded[]> {
    const { calls } = harness(config);
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis["remoteBindChoices"] = () =>
      Promise.resolve(choices);
    initSettings();
    await openSettings();
    await settle();
    return calls;
  }

  function withRemote(patch: Partial<JarvisConfig["remote"]>): JarvisConfig {
    const config = sample();
    return { ...config, remote: { ...config.remote, ...patch } };
  }

  function radios(): HTMLInputElement[] {
    return [
      ...document.querySelectorAll<HTMLInputElement>(
        '#settings-remote-choices input[type="radio"]',
      ),
    ];
  }

  function radioFor(choice: "tailscale" | "wifi" | "other"): HTMLInputElement {
    const radio = document.querySelector<HTMLInputElement>(
      `#settings-remote-choices input[data-choice="${choice}"]`,
    );
    if (radio === null) throw new Error(`no ${choice} radio`);
    return radio;
  }

  const tailscaleRadio = (): HTMLInputElement => radioFor("tailscale");
  const wifiRadio = (): HTMLInputElement => radioFor("wifi");
  const otherRadio = (): HTMLInputElement => radioFor("other");

  function advancedDetails(): HTMLDetailsElement {
    const details = document.getElementById("settings-remote-advanced");
    if (details === null) throw new Error("no Advanced… disclosure");
    return details as HTMLDetailsElement;
  }

  function otherField(): HTMLInputElement {
    const field = document.querySelector<HTMLInputElement>(
      '#settings-remote-choices input[data-field="bindAddress"]',
    );
    if (field === null) throw new Error("no Other… address field");
    return field;
  }

  /** Clicks Save and returns what the most recent save carried. */
  async function save(calls: Recorded[]): Promise<JarvisConfig> {
    document.getElementById("settings-save")?.click();
    await Promise.resolve();
    return savedConfig(calls.filter((entry) => entry.call === "saveSettings").at(-1));
  }

  const text = (id: string): string | null | undefined => document.getElementById(id)?.textContent;

  it("is off, port 7717, no proxy and no push when jarvis.yaml has no remote section", async () => {
    await open();

    expect((document.getElementById("settings-remote-enabled") as HTMLInputElement).checked).toBe(
      false,
    );
    expect(text("settings-remote-state")).toBe(MESSAGES.remoteState(false, PRIMARY_LANGUAGE));
    expect((document.getElementById("settings-remote-port") as HTMLInputElement).value).toBe(
      "7717",
    );
    expect((document.getElementById("settings-remote-proxy") as HTMLInputElement).checked).toBe(
      false,
    );
    expect((document.getElementById("settings-remote-push") as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it("renders exactly two primary radios, Tailscale then Local Wi-Fi, each labelled and with its address", async () => {
    await open();

    const primaries = [
      ...document.querySelectorAll("#settings-remote-choices > .settings-remote-choice--primary"),
    ];
    expect(primaries.map((label) => label.textContent)).toEqual([
      `${MESSAGES.remoteTailscaleLabel(PRIMARY_LANGUAGE)}100.84.17.203`,
      `${MESSAGES.remoteWifiLabel(PRIMARY_LANGUAGE)}192.168.100.69`,
    ]);
  });

  it("pre-selects Tailscale when the saved address is still the config default and this machine has one", async () => {
    await open();

    expect(tailscaleRadio().checked).toBe(true);
    expect(tailscaleRadio().value).toBe("100.84.17.203");
    expect(wifiRadio().checked).toBe(false);
  });

  it("pre-selects Local Wi-Fi when the saved address is the config default and this machine has no Tailscale address", async () => {
    await openWithChoices([
      { address: "127.0.0.1", iface: "lo0", kind: "loopback" },
      { address: "192.168.100.69", iface: "en0", kind: "lan" },
    ]);

    expect(wifiRadio().checked).toBe(true);
    expect(wifiRadio().value).toBe("192.168.100.69");
  });

  it("disables the Tailscale radio and explains why when this machine has no mesh address", async () => {
    await openWithChoices([
      { address: "127.0.0.1", iface: "lo0", kind: "loopback" },
      { address: "192.168.100.69", iface: "en0", kind: "lan" },
    ]);

    expect(tailscaleRadio().disabled).toBe(true);
    expect(text("settings-remote-tailscale-missing")).toBe(
      MESSAGES.remoteTailscaleMissing(PRIMARY_LANGUAGE),
    );
  });

  it("collapses everything else — loopback and Other… — behind Advanced…, closed while a primary is selected", async () => {
    await open();

    expect(advancedDetails().open).toBe(false);
    const rest = [...advancedDetails().querySelectorAll(".settings-remote-choice")].map(
      (label) => label.textContent,
    );
    expect(rest).toEqual([
      `${MESSAGES.remoteBindChoiceLabel("loopback", "lo0", PRIMARY_LANGUAGE)}127.0.0.1`,
      MESSAGES.remoteOtherAddress(PRIMARY_LANGUAGE),
    ]);
    expect(otherField().disabled).toBe(true);
  });

  it("bidi-isolates the OS-given interface name of a choice inside Advanced…", async () => {
    await openWithChoices([
      { address: "127.0.0.1", iface: "lo0", kind: "loopback" },
      { address: "192.168.100.69", iface: "en0", kind: "lan" },
      { address: "100.84.17.203", iface: "utun4", kind: "mesh" },
      { address: "192.168.64.1", iface: "bridge0", kind: "lan" },
    ]);

    const restLabels = advancedDetails().querySelectorAll(".settings-remote-choice");
    const bridgeLabel = restLabels[1];
    const isolated = bridgeLabel?.querySelector('bdi, [dir="auto"]');
    expect(isolated?.textContent).toBe("bridge0");
  });

  it("gives the Other… address field an accessible name of its own", async () => {
    await open();

    expect(otherField().getAttribute("aria-label")).toBe(
      MESSAGES.remoteOtherAddress(PRIMARY_LANGUAGE),
    );
  });

  it("keeps every shown address left-to-right, listed or typed", async () => {
    await open();

    const shown = document.querySelectorAll(
      "#settings-remote-choices .settings-remote-choice .mono",
    );
    expect([...shown].every((element) => (element as HTMLElement).dir === "ltr")).toBe(true);
    expect(otherField().dir).toBe("ltr");
  });

  it("saves the address picked", async () => {
    const calls = await open();

    const wifi = wifiRadio();
    wifi.checked = true;
    change(wifi);

    expect((await save(calls)).remote.bindAddress).toBe("192.168.100.69");
    expect(wifiRadio().checked).toBe(true);
    expect(tailscaleRadio().checked).toBe(false);
  });

  it("shows a configured address this machine does not list under Other…, with Advanced… open", async () => {
    await open(withRemote({ bindAddress: "10.1.2.3" }));

    expect(advancedDetails().open).toBe(true);
    expect(otherRadio().checked).toBe(true);
    expect(otherField().value).toBe("10.1.2.3");
    expect(otherField().disabled).toBe(false);
    expect(tailscaleRadio().checked).toBe(false);
    expect(wifiRadio().checked).toBe(false);
  });

  it("opens Advanced… with the matching rest choice selected, not Other…, when the saved address is loopback's literal on a machine with no Tailscale or Wi-Fi address", async () => {
    await openWithChoices(
      [{ address: "127.0.0.1", iface: "lo0", kind: "loopback" }],
      withRemote({ bindAddress: "127.0.0.1" }),
    );

    expect(advancedDetails().open).toBe(true);
    expect(otherRadio().checked).toBe(false);
    const loopback = document.querySelector<HTMLInputElement>(
      '#settings-remote-advanced input[value="127.0.0.1"]',
    );
    expect(loopback?.checked).toBe(true);
  });

  it("commits a typed address on change, never on input, and keeps Other… picked", async () => {
    const calls = await open(withRemote({ bindAddress: "10.1.2.3" }));

    const other = otherRadio();
    other.checked = true;
    change(other);
    expect(otherRadio().checked).toBe(true);

    const field = otherField();
    field.value = "10.9.8.7";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect((await save(calls)).remote.bindAddress).toBe("10.1.2.3");

    change(field);
    expect((await save(calls)).remote.bindAddress).toBe("10.9.8.7");
    expect(otherRadio().checked).toBe(true);
  });

  it("snaps the Other… field back to the saved address when emptied, like the port field", async () => {
    const calls = await open();

    const other = otherRadio();
    other.checked = true;
    change(other);

    const field = otherField();
    field.value = "10.9.8.7";
    change(field);
    expect((await save(calls)).remote.bindAddress).toBe("10.9.8.7");

    field.value = "";
    change(field);
    expect(field.value).toBe("10.9.8.7");
    expect((await save(calls)).remote.bindAddress).toBe("10.9.8.7");
  });

  it("keeps keyboard focus in the radio group across the rebuild a change triggers", async () => {
    await open();

    const [first, second] = radios();
    if (first === undefined || second === undefined) throw new Error("need two radios");
    const secondAddress = second.value;
    first.focus();

    second.checked = true;
    change(second);

    const rebuilt = radios().find((radio) => radio.value === secondAddress);
    expect(document.activeElement).toBe(rebuilt);
  });

  // Task 4: idleDisableMinutes and push.includeProjectNames are now shown
  // (settings-remote-idle, settings-remote-push-projects) — tls is the one
  // that still isn't, so it carries the "the panel doesn't show it" case.
  it("shows idle auto-disable and project-names on load, and round-trips both plus a still-unshown field through save", async () => {
    const calls = await open(
      withRemote({
        idleDisableMinutes: 30,
        push: { enabled: false, includeProjectNames: true },
        tls: { certPath: "/c", keyPath: "/k" },
      }),
    );

    expect((document.getElementById("settings-remote-idle") as HTMLInputElement).value).toBe("30");
    expect(
      (document.getElementById("settings-remote-push-projects") as HTMLInputElement).checked,
    ).toBe(true);

    // Change a field the panel does show, so the save is not a no-op.
    const port = document.getElementById("settings-remote-port") as HTMLInputElement;
    port.value = "8443";
    change(port);

    const saved = await save(calls);
    expect(saved.remote.idleDisableMinutes).toBe(30);
    expect(saved.remote.push.includeProjectNames).toBe(true);
    expect(saved.remote.tls).toEqual({ certPath: "/c", keyPath: "/k" });
  });

  it("commits the idle minutes on change, ignores a non-numeric one, and never commits on input alone", async () => {
    const calls = await open();
    const idle = document.getElementById("settings-remote-idle") as HTMLInputElement;

    // Typing without a change event (blur/Enter) must not touch the draft —
    // the same discipline the bindAddress field's own test proves.
    idle.value = "45";
    idle.dispatchEvent(new Event("input", { bubbles: true }));
    expect((await save(calls)).remote.idleDisableMinutes).toBe(0);

    change(idle);
    expect(idle.value).toBe("45");
    expect((await save(calls)).remote.idleDisableMinutes).toBe(45);

    idle.value = "abc";
    change(idle);
    expect(idle.value).toBe("45");
    expect((await save(calls)).remote.idleDisableMinutes).toBe(45);
  });

  it("commits the project-names checkbox, independent of whether push itself is enabled", async () => {
    const calls = await open();
    const checkbox = document.getElementById("settings-remote-push-projects") as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);

    checkbox.checked = true;
    change(checkbox);

    expect((await save(calls)).remote.push.includeProjectNames).toBe(true);
  });

  it("warns only for an address that listens on every interface, in any of its spellings", async () => {
    await open();
    expect((document.getElementById("settings-remote-all-note") as HTMLElement).hidden).toBe(true);

    // net.isIP accepts every one of these as "every interface"; the renderer
    // can't import node:net, so the normaliser must recognise each by hand.
    // The last five are less common spellings of the same address (an
    // embedded dotted quad, or the IPv4-mapped unspecified address written
    // out in full) that a naive "0.0.0.0 or ::" check would miss.
    for (const address of [
      "0.0.0.0",
      "::",
      "::ffff:0.0.0.0",
      "0:0:0:0:0:0:0:0",
      "::0.0.0.0",
      "0:0:0:0:0:0:0.0.0.0",
      "::ffff:0:0",
      "0:0:0:0:0:ffff:0.0.0.0",
      "0::ffff:0.0.0.0",
    ]) {
      await open(withRemote({ bindAddress: address }));
      const note = document.getElementById("settings-remote-all-note") as HTMLElement;
      expect(note.hidden).toBe(false);
      expect(note.textContent).toBe(MESSAGES.remoteAllInterfaces(PRIMARY_LANGUAGE));
    }

    // Non-zero controls: a real address must never trip the warning, even
    // when it is IPv4-mapped, loopback, or shares a prefix with "::".
    for (const address of [
      "100.84.17.203",
      "10.1.2.3",
      "0.0.0.1",
      "::ffff:0.0.0.1",
      "::ffff:0:1",
      "::1",
      "1::",
    ]) {
      await open(withRemote({ bindAddress: address }));
      expect((document.getElementById("settings-remote-all-note") as HTMLElement).hidden).toBe(
        true,
      );
    }
  });

  it("commits a port as a number, and ignores a non-numeric one", async () => {
    const calls = await open();

    const port = document.getElementById("settings-remote-port") as HTMLInputElement;
    port.value = "8443";
    change(port);
    port.value = "84x";
    change(port);

    expect(port.value).toBe("8443");
    expect((await save(calls)).remote.port).toBe(8443);
  });

  it("saves it turned on, with the proxy and push notifications", async () => {
    const calls = await open();

    for (const id of ["settings-remote-enabled", "settings-remote-proxy", "settings-remote-push"]) {
      const toggle = document.getElementById(id) as HTMLInputElement;
      toggle.checked = true;
      change(toggle);
    }

    expect(text("settings-remote-state")).toBe(MESSAGES.remoteState(true, PRIMARY_LANGUAGE));
    const saved = await save(calls);
    expect(saved.remote.enabled).toBe(true);
    expect(saved.remote.sidecarProxy).toBe(true);
    expect(saved.remote.push.enabled).toBe(true);
  });

  it("shows the pairing area disabled while remote access is off, and says why", async () => {
    await open();

    expect(text("settings-remote-pair-title")).toBe(MESSAGES.remotePairTitle(PRIMARY_LANGUAGE));
    const button = document.getElementById("settings-remote-new-code") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe(MESSAGES.remoteNewCode(PRIMARY_LANGUAGE));
    expect(text("settings-remote-pair-note")).toBe(MESSAGES.remotePairSaveFirst(PRIMARY_LANGUAGE));
  });

  function statusOf(patch: Partial<Parameters<typeof withStatus>[0]>) {
    return withStatus(patch);
  }

  function withStatus(patch: {
    enabled?: boolean;
    problem?:
      | "bad-address"
      | "listen-failed"
      | "certificate-failed"
      | "devices-unreadable"
      | "devices-write-failed";
    pairing?:
      | { kind: "closed" }
      | { kind: "open"; uri: string; expiresAt: number }
      | {
          kind: "confirming";
          requestId: string;
          deviceName: string;
          address: string;
          expiresAt: number;
        };
    devices?: {
      id: string;
      name: string;
      pairedAt: number;
      lastSeenAt: number | undefined;
      connected: boolean;
      push?: "ios" | "android";
    }[];
    listening?: {
      host: string;
      port: number;
      fingerprint: string;
      certificate: { source: "self-signed" | "configured"; hostname: string | undefined };
    };
    sidecarProxy?: "off" | "needs-certificate" | "on";
    idle?:
      | { kind: "armed"; disableAt: number }
      | { kind: "disabled"; at: number; afterMinutes: number };
  }) {
    return {
      enabled: patch.enabled ?? true,
      listening: patch.listening,
      pairing: patch.pairing ?? { kind: "closed" as const },
      devices: patch.devices ?? [],
      problem: patch.problem,
      sidecarProxy: patch.sidecarProxy ?? ("off" as const),
      idle: patch.idle,
    };
  }

  async function openWithStatus(status: ReturnType<typeof withStatus>): Promise<Recorded[]> {
    const config = sample();
    const { calls } = harness(config);
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis["remoteStatus"] = () =>
      Promise.resolve(status);
    initSettings();
    await openSettings();
    await settle();
    return calls;
  }

  it("enables New code once remote access is enabled and pairing is closed", async () => {
    await openWithStatus(statusOf({ enabled: true, pairing: { kind: "closed" } }));
    const button = document.getElementById("settings-remote-new-code") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("keeps New code disabled while devices.json is unreadable, even when enabled", async () => {
    await openWithStatus(
      statusOf({ enabled: true, problem: "devices-unreadable", pairing: { kind: "closed" } }),
    );
    const button = document.getElementById("settings-remote-new-code") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("clicking New code calls openRemotePairing, and shows a failure's text in the note", async () => {
    const config = sample();
    const { calls } = harness(config);
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis["remoteStatus"] = () =>
      Promise.resolve(statusOf({ enabled: true, pairing: { kind: "closed" } }));
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis["openRemotePairing"] = (
      ...args: unknown[]
    ) => {
      calls.push({ call: "openRemotePairing", args });
      return Promise.resolve({ ok: false, text: "T" });
    };
    initSettings();
    await openSettings();
    await settle();

    document.getElementById("settings-remote-new-code")?.dispatchEvent(new Event("click"));
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.some((entry) => entry.call === "openRemotePairing")).toBe(true);
    expect(text("settings-remote-pair-note")).toBe("T");
  });

  it("shows the pairing link and a counting-down expiry while a pairing window is open", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      await openWithStatus(
        statusOf({
          enabled: true,
          pairing: { kind: "open", uri: "jarvis-pair://x", expiresAt: now + 120_000 },
        }),
      );
      expect(text("settings-remote-pair-code")).toBe("jarvis-pair://x");
      expect(text("settings-remote-pair-expiry")).toBe(
        MESSAGES.remotePairExpires(120, PRIMARY_LANGUAGE),
      );
      const cancel = document.getElementById("settings-remote-pair-cancel") as HTMLButtonElement;
      expect(cancel.hidden).toBe(false);

      vi.advanceTimersByTime(1000);
      expect(text("settings-remote-pair-expiry")).toBe(
        MESSAGES.remotePairExpires(119, PRIMARY_LANGUAGE),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws the QR from exactly the pairing link, and shows the canvas, while a pairing window is open", async () => {
    const now = Date.now();
    vi.mocked(encodeQr).mockClear();
    vi.mocked(qrToCanvas).mockClear();

    await openWithStatus(
      statusOf({
        enabled: true,
        pairing: { kind: "open", uri: "jarvis-pair://x", expiresAt: now + 120_000 },
      }),
    );

    expect(encodeQr).toHaveBeenCalledWith("jarvis-pair://x");
    expect(qrToCanvas).toHaveBeenCalledTimes(1);
    const canvas = document.getElementById("remote-pair-qr") as HTMLCanvasElement;
    expect(canvas.hidden).toBe(false);
    // The link text stays beside it — unchanged by this task (M4 ruling 34).
    expect(text("settings-remote-pair-code")).toBe("jarvis-pair://x");
  });

  it("clears and hides the QR canvas when there is no pairing link", async () => {
    const clearRect = vi.fn();
    qrCanvasGetContext.mockReturnValueOnce({ clearRect } as unknown as CanvasRenderingContext2D);

    await openWithStatus(statusOf({ enabled: true, pairing: { kind: "closed" } }));

    expect(clearRect).toHaveBeenCalled();
    const canvas = document.getElementById("remote-pair-qr") as HTMLCanvasElement;
    expect(canvas.hidden).toBe(true);
  });

  it("shows the pairing link's certificate fingerprint tail beside the QR, matching the phone's fingerprintTail", async () => {
    const now = Date.now();
    const fingerprint = `${"a".repeat(60)}beef`;
    const uri = `jarvis://pair?v=1&host=127.0.0.1&port=7717&secret=${"s".repeat(43)}&fp=${fingerprint}`;

    await openWithStatus(
      statusOf({
        enabled: true,
        pairing: { kind: "open", uri, expiresAt: now + 120_000 },
      }),
    );

    // Same computation as apps/mobile/src/lib/pair-flow.ts's
    // fingerprintTail (fingerprint.slice(-4)): this checks the desktop
    // shows the *same* tail for the *same* fingerprint the phone's
    // confirm step would show, not merely "some 4 characters".
    const expectedTail = fingerprint.slice(-4);
    expect(expectedTail).toBe("beef");
    expect(text("settings-remote-pair-fingerprint")).toBe(
      MESSAGES.remotePairFingerprintTail(expectedTail, PRIMARY_LANGUAGE),
    );
  });

  it("clears the fingerprint tail when there is no pairing link", async () => {
    await openWithStatus(statusOf({ enabled: true, pairing: { kind: "closed" } }));
    expect(text("settings-remote-pair-fingerprint")).toBe("");
  });

  it("clears the pairing code and expiry, and stops the interval, on a closed status", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const config = sample();
      const { calls } = harness(config);
      let status: ReturnType<typeof withStatus> = statusOf({
        enabled: true,
        pairing: { kind: "open", uri: "jarvis-pair://x", expiresAt: now + 120_000 },
      });
      (window as unknown as { jarvis: Record<string, unknown> }).jarvis["remoteStatus"] = () =>
        Promise.resolve(status);
      initSettings();
      await openSettings();
      await settle();
      expect(text("settings-remote-pair-code")).toBe("jarvis-pair://x");

      const clearSpy = vi.spyOn(globalThis, "clearInterval");
      status = statusOf({ enabled: true, pairing: { kind: "closed" } });
      // A second visit to the route re-pulls remoteStatus() (openSettings'
      // own refresh) and re-renders the pair area from the new value —
      // exactly what happens if the window was paired/expired elsewhere and
      // the user comes back to Settings.
      await openSettings();
      await settle();

      expect(text("settings-remote-pair-code")).toBe("");
      expect(text("settings-remote-pair-expiry")).toBe("");
      expect(
        (document.getElementById("settings-remote-pair-cancel") as HTMLButtonElement).hidden,
      ).toBe(true);
      expect(clearSpy).toHaveBeenCalled();

      // The interval really did stop, not just get cleared once and
      // silently rescheduled: nothing repopulates the expiry text.
      vi.advanceTimersByTime(2000);
      expect(text("settings-remote-pair-expiry")).toBe("");

      void calls;
      clearSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-renders the pair area and device list from an onRemoteStatusChange push while Settings is open", async () => {
    const config = sample();
    harness(config);
    // initRemoteStatus (app.ts's real caller of this push path) also wires
    // the topbar pill and the confirmation dialog — neither exists in this
    // route's own harness, so they're laid down minimally here too.
    document.body.insertAdjacentHTML(
      "beforeend",
      `<button id="nav-settings"></button>
       <button id="remote-pill" hidden><span id="remote-pill-text"></span></button>
       <div id="remote-confirm" hidden>
         <div id="remote-confirm-title"></div>
         <div id="remote-confirm-body"></div>
         <div id="remote-confirm-from"></div>
         <button id="remote-confirm-approve"></button>
         <button id="remote-confirm-deny"></button>
       </div>`,
    );
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis["remoteStatus"] = () =>
      Promise.resolve(statusOf({ enabled: true, pairing: { kind: "closed" } }));
    initSettings();
    await openSettings();
    await settle();
    expect(text("settings-remote-devices")).toBe(MESSAGES.remoteNoDevices(PRIMARY_LANGUAGE));

    // Settings' own initSettings already subscribed onRemoteStatusChange;
    // driving a push through initRemoteStatus (app.ts's real entry point)
    // exercises that same subscription end to end, rather than reaching
    // into settings.ts's internals.
    const { initRemoteStatus } = await import("./remote-status.js");
    let pushed: ((status: ReturnType<typeof statusOf>) => void) | undefined;
    initRemoteStatus({
      remoteStatus: () => Promise.resolve(statusOf({ enabled: true })),
      onRemoteStatus: (cb: (status: ReturnType<typeof statusOf>) => void) => {
        pushed = cb;
      },
      decideRemotePairing: () => Promise.resolve(),
    });
    await settle();

    pushed?.(
      statusOf({
        enabled: true,
        devices: [
          { id: "d1", name: "Pushed phone", pairedAt: 0, lastSeenAt: undefined, connected: true },
        ],
      }),
    );

    expect(text("settings-remote-devices")).toContain("Pushed phone");
  });

  it("lists no paired devices, and says so", async () => {
    await open();

    expect(text("settings-remote-devices-title")).toBe(
      MESSAGES.remoteDevicesTitle(PRIMARY_LANGUAGE),
    );
    expect(text("settings-remote-devices")).toBe(MESSAGES.remoteNoDevices(PRIMARY_LANGUAGE));
  });

  it("lists two devices as two rows, and revoking the second calls revokeRemoteDevice with its id", async () => {
    const config = sample();
    const { calls } = harness(config);
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis["remoteStatus"] = () =>
      Promise.resolve(
        statusOf({
          enabled: true,
          devices: [
            { id: "d1", name: "<img src=x>", pairedAt: 0, lastSeenAt: undefined, connected: true },
            { id: "d2", name: "Ali's iPhone", pairedAt: 0, lastSeenAt: 1000, connected: false },
          ],
        }),
      );
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis["revokeRemoteDevice"] = (
      ...args: unknown[]
    ) => {
      calls.push({ call: "revokeRemoteDevice", args });
      return Promise.resolve({ ok: true, value: undefined });
    };
    initSettings();
    await openSettings();
    await settle();

    const rows = document.querySelectorAll("#settings-remote-devices .settings-row");
    expect(rows).toHaveLength(2);
    // The name is never innerHTML'd: a device can name itself anything.
    expect(rows[0]?.querySelector("img")).toBeNull();
    expect(rows[0]?.textContent).toContain("<img src=x>");

    const revokeButtons = document.querySelectorAll<HTMLButtonElement>(
      "#settings-remote-devices .settings-add",
    );
    expect(revokeButtons).toHaveLength(2);
    revokeButtons[1]?.click();
    await Promise.resolve();

    expect(calls.find((entry) => entry.call === "revokeRemoteDevice")?.args).toEqual(["d2"]);
  });

  it("disables the Revoke button for the round trip, and shows an ok:false failure's text in the row", async () => {
    const config = sample();
    harness(config);
    let resolveRevoke: ((value: { ok: boolean; text?: string }) => void) | undefined;
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis["remoteStatus"] = () =>
      Promise.resolve(
        statusOf({
          enabled: true,
          devices: [
            { id: "d1", name: "Ali's iPhone", pairedAt: 0, lastSeenAt: undefined, connected: true },
          ],
        }),
      );
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis["revokeRemoteDevice"] = () =>
      new Promise((resolve) => {
        resolveRevoke = resolve;
      });
    initSettings();
    await openSettings();
    await settle();

    const revoke = document.querySelector<HTMLButtonElement>(
      "#settings-remote-devices .settings-add",
    );
    if (revoke === null) throw new Error("no revoke button");
    revoke.click();
    expect(revoke.disabled).toBe(true);

    resolveRevoke?.({ ok: false, text: "T" });
    await Promise.resolve();
    await Promise.resolve();

    expect(revoke.disabled).toBe(false);
    expect(document.querySelector("#settings-remote-devices .settings-row")?.textContent).toContain(
      "T",
    );
  });

  it("shows a problem note, hidden when there is none", async () => {
    const config = sample();
    harness(config);
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis["remoteStatus"] = () =>
      Promise.resolve(statusOf({ enabled: true, problem: "devices-unreadable" }));
    initSettings();
    await openSettings();
    await settle();

    const problem = document.getElementById("settings-remote-problem") as HTMLElement;
    expect(problem.hidden).toBe(false);
    expect(problem.textContent).toBe(
      MESSAGES.remoteProblem("devices-unreadable", PRIMARY_LANGUAGE),
    );
  });

  describe("the certificate note (Task 4 rule 5)", () => {
    it("shows nothing while not listening", async () => {
      await openWithStatus(statusOf({}));
      const note = document.getElementById("settings-remote-certificate") as HTMLElement;
      expect(note.hidden).toBe(true);
      expect(note.textContent).toBe("");
    });

    // Review round 1, Important #1: the bridge reports "needs-certificate"
    // for the whole time the proxy toggle is on and the bridge simply is
    // not listening yet (disabled, or enabled with zero paired devices) —
    // not only for a live self-signed/no-SAN certificate. Before the fix
    // this rendered "the certificate is self-signed or has no DNS name"
    // about a certificate nobody was serving; `listening === undefined`
    // must win first and hide the note instead.
    it("shows nothing while not listening, even when status.sidecarProxy is needs-certificate", async () => {
      await openWithStatus(statusOf({ sidecarProxy: "needs-certificate" }));
      const note = document.getElementById("settings-remote-certificate") as HTMLElement;
      expect(note.hidden).toBe(true);
      expect(note.textContent).toBe("");
    });

    it("shows the real-certificate line for a configured certificate with a DNS name", async () => {
      await openWithStatus(
        statusOf({
          sidecarProxy: "on",
          listening: {
            host: "127.0.0.1",
            port: 7717,
            fingerprint: "ab",
            certificate: { source: "configured", hostname: "mac.tail.ts.net" },
          },
        }),
      );
      const note = document.getElementById("settings-remote-certificate") as HTMLElement;
      expect(note.hidden).toBe(false);
      expect(note.textContent).toBe(
        MESSAGES.remoteCertificateReal("mac.tail.ts.net", PRIMARY_LANGUAGE),
      );
      expect(note.className).not.toContain("settings-note--warning");
    });

    it("shows the self-signed line while listening on a self-signed certificate and the proxy is off", async () => {
      await openWithStatus(
        statusOf({
          listening: {
            host: "127.0.0.1",
            port: 7717,
            fingerprint: "ab",
            certificate: { source: "self-signed", hostname: undefined },
          },
        }),
      );
      const note = document.getElementById("settings-remote-certificate") as HTMLElement;
      expect(note.hidden).toBe(false);
      expect(note.textContent).toBe(MESSAGES.remoteCertificateSelfSigned(PRIMARY_LANGUAGE));
    });

    // M5: rule 5 routes a *configured* certificate with no DNS SAN to the
    // same self-signed line as an actually self-signed one — "real" means
    // both configured AND carrying a hostname.
    it("shows the self-signed line for a configured certificate with no DNS name", async () => {
      await openWithStatus(
        statusOf({
          listening: {
            host: "127.0.0.1",
            port: 7717,
            fingerprint: "ab",
            certificate: { source: "configured", hostname: undefined },
          },
        }),
      );
      const note = document.getElementById("settings-remote-certificate") as HTMLElement;
      expect(note.hidden).toBe(false);
      expect(note.textContent).toBe(MESSAGES.remoteCertificateSelfSigned(PRIMARY_LANGUAGE));
    });

    it("shows the needs-certificate warning only when status.sidecarProxy is needs-certificate", async () => {
      await openWithStatus(
        statusOf({
          sidecarProxy: "needs-certificate",
          listening: {
            host: "127.0.0.1",
            port: 7717,
            fingerprint: "ab",
            certificate: { source: "self-signed", hostname: undefined },
          },
        }),
      );
      const note = document.getElementById("settings-remote-certificate") as HTMLElement;
      expect(note.hidden).toBe(false);
      expect(note.textContent).toBe(MESSAGES.remoteProxyNeedsCertificate(PRIMARY_LANGUAGE));
      expect(note.className).toContain("settings-note--warning");
    });

    // M4: the bracketed claim this test used to carry ("render the warning
    // from the toggle/draft instead of status.sidecarProxy") was not
    // exercised by any test — `sample()`'s draft always has the toggle off.
    // This is that actual case: the draft's toggle is on (an unsaved
    // change, or one the bridge hasn't caught up to yet) but the bridge's
    // own status says the proxy is off — status must win, both for the
    // warning (none shown) and for which certificate line is shown.
    it("renders from status, not the draft's toggle, when the two disagree", async () => {
      const config = sample();
      config.remote = { ...config.remote, sidecarProxy: true };
      harness(config);
      (window as unknown as { jarvis: Record<string, unknown> }).jarvis["remoteStatus"] = () =>
        Promise.resolve(
          statusOf({
            sidecarProxy: "off",
            listening: {
              host: "127.0.0.1",
              port: 7717,
              fingerprint: "ab",
              certificate: { source: "self-signed", hostname: undefined },
            },
          }),
        );
      initSettings();
      await openSettings();
      await settle();

      const note = document.getElementById("settings-remote-certificate") as HTMLElement;
      expect(note.hidden).toBe(false);
      expect(note.textContent).toBe(MESSAGES.remoteCertificateSelfSigned(PRIMARY_LANGUAGE));
      expect(note.className).not.toContain("settings-note--warning");
    });
  });

  describe("the Tailscale certificate row", () => {
    function els() {
      return {
        status: document.getElementById("settings-remote-cert-status") as HTMLElement,
        button: document.getElementById("settings-remote-cert-button") as HTMLButtonElement,
        error: document.getElementById("settings-remote-cert-error") as HTMLElement,
        hint: document.getElementById("settings-remote-cert-hint") as HTMLElement,
      };
    }

    it("no certificate: 'Certificate: none' and the Get button", async () => {
      const config = withRemote({ tls: {} });
      harness(config);
      initSettings();
      await openSettings();
      await settle();

      const { status, button } = els();
      expect(status.textContent).toBe(MESSAGES.remoteCertNone(PRIMARY_LANGUAGE));
      expect(button.textContent).toBe(MESSAGES.remoteCertGetButton(PRIMARY_LANGUAGE));
    });

    it("a certificate this app issued (under .../tls/<name>.crt): names it, and shows Renew", async () => {
      const config = withRemote({
        tls: {
          certPath: "/x/.config/jarvis/tls/m1.tailnet.ts.net.crt",
          keyPath: "/x/.config/jarvis/tls/m1.tailnet.ts.net.key",
        },
      });
      harness(config);
      initSettings();
      await openSettings();
      await settle();

      const { status, button } = els();
      expect(status.textContent).toBe(
        MESSAGES.remoteCertNamed("m1.tailnet.ts.net", PRIMARY_LANGUAGE),
      );
      expect(button.textContent).toBe(MESSAGES.remoteCertRenewButton(PRIMARY_LANGUAGE));
    });

    it("a hand-configured certificate elsewhere: shows the raw path, and Renew", async () => {
      const config = withRemote({
        tls: { certPath: "/etc/ssl/mac.crt", keyPath: "/etc/ssl/mac.key" },
      });
      harness(config);
      initSettings();
      await openSettings();
      await settle();

      const { status, button } = els();
      expect(status.textContent).toBe(
        MESSAGES.remoteCertPath("/etc/ssl/mac.crt", PRIMARY_LANGUAGE),
      );
      expect(button.textContent).toBe(MESSAGES.remoteCertRenewButton(PRIMARY_LANGUAGE));
    });

    it("hints to get a certificate when bindAddress is a Tailscale address and none is configured", async () => {
      const config = withRemote({ bindAddress: "100.84.17.203", tls: {} });
      harness(config);
      initSettings();
      await openSettings();
      await settle();

      const { hint } = els();
      expect(hint.hidden).toBe(false);
      expect(hint.textContent).toBe(MESSAGES.remoteCertHint(PRIMARY_LANGUAGE));
    });

    it("no hint on a Tailscale address once a certificate is configured", async () => {
      const config = withRemote({
        bindAddress: "100.84.17.203",
        tls: { certPath: "/etc/ssl/mac.crt", keyPath: "/etc/ssl/mac.key" },
      });
      harness(config);
      initSettings();
      await openSettings();
      await settle();

      expect(els().hint.hidden).toBe(true);
    });

    it("no hint on a non-Tailscale address, even with no certificate", async () => {
      const config = withRemote({ bindAddress: "192.168.1.20", tls: {} });
      harness(config);
      initSettings();
      await openSettings();
      await settle();

      expect(els().hint.hidden).toBe(true);
    });

    it("clicking Get: busy state, then a reloaded settings on success — status and the sidecar-proxy switch update", async () => {
      const config = withRemote({ tls: {}, sidecarProxy: false });
      const { calls } = harness(config);
      const reloaded = withRemote({
        tls: {
          certPath: "/x/.config/jarvis/tls/m1.tailnet.ts.net.crt",
          keyPath: "/x/.config/jarvis/tls/m1.tailnet.ts.net.key",
        },
        sidecarProxy: true,
      });
      let getSettingsCalls = 0;
      (window as unknown as { jarvis: Record<string, unknown> }).jarvis["getSettings"] = () => {
        getSettingsCalls += 1;
        return Promise.resolve(getSettingsCalls === 1 ? config : reloaded);
      };
      initSettings();
      await openSettings();
      await settle();

      const { button, status } = els();
      button.click();
      // Busy immediately, before the promise resolves.
      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe(MESSAGES.remoteCertBusy("get", PRIMARY_LANGUAGE));

      await settle();

      expect(calls.some((c) => c.call === "tailscaleCert")).toBe(true);
      expect(getSettingsCalls).toBe(2);
      expect(status.textContent).toBe(
        MESSAGES.remoteCertNamed("m1.tailnet.ts.net", PRIMARY_LANGUAGE),
      );
      expect(button.textContent).toBe(MESSAGES.remoteCertRenewButton(PRIMARY_LANGUAGE));
      expect(button.disabled).toBe(false);
      expect((document.getElementById("settings-remote-proxy") as HTMLInputElement).checked).toBe(
        true,
      );
    });

    it("clicking Renew calls the same channel as Get (no argument selects which)", async () => {
      const config = withRemote({
        tls: { certPath: "/etc/ssl/mac.crt", keyPath: "/etc/ssl/mac.key" },
      });
      const { calls } = harness(config);
      initSettings();
      await openSettings();
      await settle();

      els().button.click();
      await settle();

      const call = calls.find((c) => c.call === "tailscaleCert");
      expect(call?.args).toEqual([]);
    });

    it("no-tailscale: shows 'Install Tailscale on this Mac', button re-enabled and unchanged", async () => {
      const config = withRemote({ tls: {} });
      harness(config);
      (window as unknown as { jarvis: Record<string, unknown> }).jarvis["tailscaleCert"] = () =>
        Promise.resolve({ ok: false, kind: "no-tailscale", detail: "not installed" });
      initSettings();
      await openSettings();
      await settle();

      els().button.click();
      await settle();

      const { status, button, error } = els();
      expect(error.hidden).toBe(false);
      expect(error.textContent).toBe(MESSAGES.remoteCertNoTailscale(PRIMARY_LANGUAGE));
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe(MESSAGES.remoteCertGetButton(PRIMARY_LANGUAGE));
      expect(status.textContent).toBe(MESSAGES.remoteCertNone(PRIMARY_LANGUAGE));
    });

    it("not-connected: shows 'Connect Tailscale first'", async () => {
      const config = withRemote({ tls: {} });
      harness(config);
      (window as unknown as { jarvis: Record<string, unknown> }).jarvis["tailscaleCert"] = () =>
        Promise.resolve({ ok: false, kind: "not-connected", detail: "stopped" });
      initSettings();
      await openSettings();
      await settle();

      els().button.click();
      await settle();

      expect(els().error.textContent).toBe(MESSAGES.remoteCertNotConnected(PRIMARY_LANGUAGE));
    });

    it("failed: shows the generic text plus the CLI's own detail", async () => {
      const config = withRemote({ tls: {} });
      harness(config);
      (window as unknown as { jarvis: Record<string, unknown> }).jarvis["tailscaleCert"] = () =>
        Promise.resolve({ ok: false, kind: "failed", detail: "some CLI error" });
      initSettings();
      await openSettings();
      await settle();

      els().button.click();
      await settle();

      expect(els().error.textContent).toBe(
        `${MESSAGES.remoteCertFailed(PRIMARY_LANGUAGE)} some CLI error`,
      );
    });

    it("https-disabled: renders a clickable link that opens the Tailscale admin console through openTab, never window.open", async () => {
      const config = withRemote({ tls: {} });
      const { calls } = harness(config);
      (window as unknown as { jarvis: Record<string, unknown> }).jarvis["tailscaleCert"] = () =>
        Promise.resolve({ ok: false, kind: "https-disabled", detail: "does not support…" });
      const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
      initSettings();
      await openSettings();
      await settle();

      els().button.click();
      await settle();

      const { error } = els();
      expect(error.hidden).toBe(false);
      const parts = MESSAGES.remoteCertHttpsDisabled(PRIMARY_LANGUAGE);
      expect(error.textContent).toBe(`${parts.before}${parts.link}${parts.after}`);
      const link = error.querySelector(".settings-link-button") as HTMLButtonElement;
      expect(link).not.toBeNull();
      expect(link.tagName).toBe("BUTTON");
      expect(link.textContent).toBe(parts.link);

      link.click();
      await settle();

      expect(windowOpen).not.toHaveBeenCalled();
      const openTabCall = calls.find((c) => c.call === "openTab");
      expect(openTabCall?.args).toEqual([
        PERSONAL_PROJECT,
        "https://login.tailscale.com/admin/dns",
      ]);
      windowOpen.mockRestore();
    });

    it("a stale error clears on the next click", async () => {
      const config = withRemote({ tls: {} });
      harness(config);
      let first = true;
      (window as unknown as { jarvis: Record<string, unknown> }).jarvis["tailscaleCert"] = () => {
        const outcome = first
          ? { ok: false, kind: "no-tailscale", detail: "x" }
          : {
              ok: true,
              certPath: "/x/.config/jarvis/tls/m.crt",
              keyPath: "/x/.config/jarvis/tls/m.key",
              name: "m",
            };
        first = false;
        return Promise.resolve(outcome);
      };
      initSettings();
      await openSettings();
      await settle();

      els().button.click();
      await settle();
      expect(els().error.hidden).toBe(false);

      els().button.click();
      // Cleared synchronously, before the second call resolves.
      expect(els().error.hidden).toBe(true);
      await settle();
    });
  });

  describe("the idle auto-disable state line (Task 4 rule 4)", () => {
    it("hides the line when status.idle is undefined", async () => {
      await openWithStatus(statusOf({ enabled: true }));
      const state = document.getElementById("settings-remote-idle-state") as HTMLElement;
      expect(state.hidden).toBe(true);
      expect(state.textContent).toBe("");
    });

    it("shows the armed line with the formatted disable time", async () => {
      const disableAt = Date.UTC(2026, 0, 1, 12, 0, 0);
      await openWithStatus(statusOf({ enabled: true, idle: { kind: "armed", disableAt } }));
      const state = document.getElementById("settings-remote-idle-state") as HTMLElement;
      expect(state.hidden).toBe(false);
      expect(state.textContent).toBe(MESSAGES.remoteIdleArmed(disableAt, PRIMARY_LANGUAGE));
    });

    // Ruling 5 [bite-proof: skip the draft flip; a subsequent save writes
    // `enabled: true`]: the bridge already closed its own listener before
    // this status arrived, so the panel must catch the draft — and the
    // switch the user sees — up to that fact, not just describe it in a note.
    it("shows the disabled line and flips the draft's enabled switch off when the draft still says on", async () => {
      const at = Date.UTC(2026, 0, 1, 12, 0, 0);
      const config = withRemote({ enabled: true });
      const { calls } = harness(config);
      (window as unknown as { jarvis: Record<string, unknown> }).jarvis["remoteStatus"] = () =>
        Promise.resolve(
          statusOf({ enabled: true, idle: { kind: "disabled", at, afterMinutes: 30 } }),
        );
      initSettings();
      await openSettings();
      await settle();

      const enabledCheckbox = document.getElementById(
        "settings-remote-enabled",
      ) as HTMLInputElement;
      expect(enabledCheckbox.checked).toBe(false);
      expect(text("settings-remote-state")).toBe(MESSAGES.remoteState(false, PRIMARY_LANGUAGE));
      const state = document.getElementById("settings-remote-idle-state") as HTMLElement;
      expect(state.hidden).toBe(false);
      expect(state.textContent).toBe(MESSAGES.remoteIdleDisabled(at, 30, PRIMARY_LANGUAGE));

      // The flip reached the draft, not only the checkbox on screen — a
      // save now really writes enabled: false.
      expect((await save(calls)).remote.enabled).toBe(false);
    });

    it("makes no change and does not loop when the draft is already off", async () => {
      const at = Date.UTC(2026, 0, 1, 12, 0, 0);
      const config = withRemote({ enabled: false });
      harness(config);
      (window as unknown as { jarvis: Record<string, unknown> }).jarvis["remoteStatus"] = () =>
        Promise.resolve(
          statusOf({ enabled: false, idle: { kind: "disabled", at, afterMinutes: 30 } }),
        );
      initSettings();
      await openSettings();
      await settle();

      // A runaway re-render loop would call renderRemotePairArea (and so
      // $("settings-remote-idle-state")) far more than the small, fixed
      // number of times a single openSettings() legitimately does (once
      // from renderSettings, once from the post-refresh re-render).
      const getSpy = vi.spyOn(document, "getElementById");
      await openSettings();
      await settle();
      const idleStateReads = getSpy.mock.calls.filter(
        ([id]) => id === "settings-remote-idle-state",
      ).length;
      getSpy.mockRestore();

      expect(idleStateReads).toBeGreaterThan(0);
      expect(idleStateReads).toBeLessThan(10);
      const enabledCheckbox = document.getElementById(
        "settings-remote-enabled",
      ) as HTMLInputElement;
      expect(enabledCheckbox.checked).toBe(false);
    });
  });

  describe("a device's push status (ruling h)", () => {
    it("shows a third note naming the platform when the device has registered for push", async () => {
      const config = sample();
      harness(config);
      (window as unknown as { jarvis: Record<string, unknown> }).jarvis["remoteStatus"] = () =>
        Promise.resolve(
          statusOf({
            enabled: true,
            devices: [
              {
                id: "d1",
                name: "Ali's iPhone",
                pairedAt: 0,
                lastSeenAt: undefined,
                connected: true,
                push: "ios",
              },
            ],
          }),
        );
      initSettings();
      await openSettings();
      await settle();

      const row = document.querySelector("#settings-remote-devices .settings-row");
      expect(row?.textContent).toContain(MESSAGES.remoteDevicePush("ios", PRIMARY_LANGUAGE));
    });

    it("adds no node at all for a device with no push registration", async () => {
      const config = sample();
      harness(config);
      (window as unknown as { jarvis: Record<string, unknown> }).jarvis["remoteStatus"] = () =>
        Promise.resolve(
          statusOf({
            enabled: true,
            devices: [
              {
                id: "d1",
                name: "Ali's iPhone",
                pairedAt: 0,
                lastSeenAt: undefined,
                connected: true,
              },
            ],
          }),
        );
      initSettings();
      await openSettings();
      await settle();

      const row = document.querySelector("#settings-remote-devices .settings-row");
      // name, state, revoke, failure — the same count as before this task,
      // not the 5 a push-registered device's row has.
      expect(row?.children).toHaveLength(4);
    });
  });

  it("keeps focus in the Other… field across a bind-choices rebuild (Minor A)", async () => {
    await open();
    otherRadio().checked = true;
    change(otherRadio());
    otherField().focus();
    expect(document.activeElement).toBe(otherField());

    // Typing a new address commits on "change" and rebuilds the whole
    // group from scratch — before the fix, that rebuild always snapped
    // focus onto the checked *radio*, even though it started in this field.
    otherField().value = "10.0.0.9";
    change(otherField());

    expect(document.activeElement).toBe(otherField());
  });

  it("carries the warning and the no-credential line", async () => {
    await open();

    expect(text("settings-remote-warning")).toBe(MESSAGES.remoteWarning(PRIMARY_LANGUAGE));
    expect(text("settings-remote-no-credential")).toBe(
      MESSAGES.remoteNoCredential(PRIMARY_LANGUAGE),
    );
    expect(text("settings-remote-title")).toBe(MESSAGES.remoteTitle(PRIMARY_LANGUAGE));
  });

  it("still renders when the address listing fails, with the configured address under Other…", async () => {
    harness();
    initSettings();
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis["remoteBindChoices"] = () =>
      Promise.reject(new Error("no listing"));
    await openSettings();
    await settle();

    // Tailscale, Local Wi-Fi (both disabled — the list is empty) and Other….
    expect(radios()).toHaveLength(3);
    expect(tailscaleRadio().disabled).toBe(true);
    expect(wifiRadio().disabled).toBe(true);
    expect(otherRadio().checked).toBe(true);
    expect(otherField().value).toBe("127.0.0.1");
  });

  // The thing that matters end to end: what the panel saves, parseConfig loads.
  it("saves a draft parseConfig accepts", async () => {
    const calls = await open();
    const lan = radios().find((radio) => radio.value === "192.168.100.69");
    if (lan === undefined) throw new Error("no lan radio");
    lan.checked = true;
    change(lan);

    const saved = await save(calls);
    const reparsed = parseConfig({
      agents: saved.registry.agents,
      brain: { cwd: saved.brain.cwd },
      remote: saved.remote,
    });
    expect(reparsed.remote.bindAddress).toBe("192.168.100.69");
  });

  // Task 1 review requirement: toRawConfig treats a draft missing `remote`
  // as default, so a save that silently dropped the key would erase a
  // hand-written remote: section. The draft must carry it through untouched.
  it("carries a hand-written remote section through an unrelated field's save", async () => {
    const calls = await open(withRemote({ port: 8443 }));

    const cwd = document.getElementById("settings-brain-cwd") as HTMLInputElement;
    cwd.value = "/new/cwd";
    change(cwd);

    expect((await save(calls)).remote.port).toBe(8443);
  });
});
