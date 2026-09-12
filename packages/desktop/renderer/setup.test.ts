// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrerequisiteStatus } from "@jarvis/platform";
import { closeSetup, initSetup, openSetup, openSetupIfNeeded } from "./setup.js";

function harness(statuses: PrerequisiteStatus[], platform: NodeJS.Platform = "linux") {
  document.body.innerHTML = `
    <div id="setup-overlay" hidden>
      <h2 id="setup-title"></h2>
      <button id="setup-skip"></button>
      <p id="setup-intro"></p>
      <p id="setup-notice" hidden></p>
      <div id="setup-list"></div>
      <pre id="setup-output" hidden></pre>
      <button id="setup-install"></button>
    </div>`;

  const installed: string[] = [];
  const bridge = {
    platform,
    checkPrerequisites: vi.fn(async () => statuses),
    installPrerequisite: vi.fn(async (id: string) => {
      installed.push(id);
      return { ok: true };
    }),
    onInstallOutput: vi.fn(),
  };
  return { bridge, installed };
}

const status = (over: Partial<PrerequisiteStatus> & { id: PrerequisiteStatus["id"] }) => ({
  installed: false,
  installable: false,
  ...over,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the setup overlay", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("does nothing at all on a document without it", async () => {
    // Every harness in this codebase lays down only the markup its own
    // subject needs. A boot step that threw here would fail dozens of tests
    // for a screen they never open.
    document.body.innerHTML = "<div></div>";
    const bridge = {
      platform: "linux" as NodeJS.Platform,
      checkPrerequisites: vi.fn(async () => []),
      installPrerequisite: vi.fn(async () => ({ ok: true })),
      onInstallOutput: vi.fn(),
    };

    expect(() => initSetup(bridge)).not.toThrow();
    expect(await openSetupIfNeeded(bridge, true)).toBe(false);
    expect(bridge.checkPrerequisites).not.toHaveBeenCalled();
  });

  it("opens on a first run", async () => {
    const { bridge } = harness([status({ id: "agent", installed: true })]);
    expect(await openSetupIfNeeded(bridge, true)).toBe(true);
    expect(document.getElementById("setup-overlay")?.hidden).toBe(false);
  });

  it("opens when the required tool is missing, first run or not", async () => {
    // An app with no agent CLI has nothing to offer, and finding that out one
    // failed session at a time is the experience this replaces.
    const { bridge } = harness([status({ id: "agent", installable: true })]);
    expect(await openSetupIfNeeded(bridge, false)).toBe(true);
  });

  it("stays shut on a later run with everything required present", async () => {
    const { bridge } = harness([
      status({ id: "agent", installed: true }),
      status({ id: "dbgate", installable: true }),
    ]);
    expect(await openSetupIfNeeded(bridge, false)).toBe(false);
  });

  it("ticks what it can install and nothing it cannot", async () => {
    const { bridge } = harness([
      status({ id: "agent", installable: true }),
      status({ id: "ffmpeg", manual: "sudo apt install ffmpeg" }),
      status({ id: "docker", installed: true }),
    ]);
    await openSetup(bridge);

    const boxes = [...document.querySelectorAll<HTMLInputElement>(".setup-row__box")];
    expect(boxes[0]?.checked).toBe(true);
    expect(boxes[1]?.checked).toBe(false);
    expect(boxes[2]?.checked).toBe(false);
  });

  it("will not let the required row be unticked", async () => {
    // Unticking the one thing without which the app has no purpose is not a
    // choice worth offering.
    const { bridge } = harness([status({ id: "agent", installable: true })]);
    await openSetup(bridge);

    const box = document.querySelector<HTMLInputElement>(".setup-row__box");
    expect(box?.disabled).toBe(true);
    expect(box?.checked).toBe(true);
  });

  it("shows a root install as a line to copy, never as a checkbox", async () => {
    const { bridge } = harness([status({ id: "ffmpeg", manual: "sudo apt install ffmpeg" })]);
    await openSetup(bridge);

    expect(document.querySelector(".setup-row__manual code")?.textContent).toBe(
      "sudo apt install ffmpeg",
    );
    expect(document.querySelector<HTMLInputElement>(".setup-row__box")?.disabled).toBe(true);
  });

  it("installs only the ticked rows", async () => {
    const { bridge, installed } = harness([
      status({ id: "dbgate", installable: true }),
      status({ id: "code-server", installable: true }),
    ]);
    await openSetup(bridge);

    const boxes = [...document.querySelectorAll<HTMLInputElement>(".setup-row__box")];
    boxes[1]!.checked = false;
    boxes[1]!.dispatchEvent(new Event("change"));

    initSetup(bridge);
    document.getElementById("setup-install")?.click();
    await settle();
    await settle();

    expect(installed).toEqual(["dbgate"]);
  });

  it("keeps going after a row fails, and says which", async () => {
    // One row failing must not abandon the rest the user ticked.
    const { bridge } = harness([
      status({ id: "dbgate", installable: true }),
      status({ id: "code-server", installable: true }),
    ]);
    bridge.installPrerequisite = vi.fn(async (id: string) =>
      id === "dbgate" ? { ok: false, detail: "npm ERR! EACCES" } : { ok: true },
    );
    await openSetup(bridge);
    initSetup(bridge);
    document.getElementById("setup-install")?.click();
    await settle();
    await settle();
    await settle();

    expect(bridge.installPrerequisite).toHaveBeenCalledTimes(2);
    expect(document.getElementById("setup-state-dbgate")?.textContent).toContain("EACCES");
  });

  it("skips without installing anything", async () => {
    const { bridge, installed } = harness([status({ id: "dbgate", installable: true })]);
    await openSetup(bridge);
    initSetup(bridge);

    document.getElementById("setup-skip")?.click();

    expect(document.getElementById("setup-overlay")?.hidden).toBe(true);
    expect(installed).toEqual([]);
  });

  it("says Jarvis does not run on Windows, and only there", async () => {
    const linux = harness([status({ id: "agent", installable: true })], "linux");
    await openSetup(linux.bridge);
    expect(document.getElementById("setup-notice")?.hidden).toBe(true);

    const windows = harness([status({ id: "agent", installable: true })], "win32");
    await openSetup(windows.bridge);
    const notice = document.getElementById("setup-notice");
    expect(notice?.hidden).toBe(false);
    expect(notice?.textContent).toMatch(/Windows/);
  });

  it("closes cleanly when it was never open", () => {
    document.body.innerHTML = "<div></div>";
    expect(() => closeSetup()).not.toThrow();
  });
});
