// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteStatus } from "@jarvis/remote";
import {
  initRemoteStatus,
  latestRemoteStatus,
  onRemoteStatusChange,
  renderPairingConfirmation,
  renderRemoteIndicator,
  withNameInBdi,
} from "./remote-status.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { showView } from "./views.js";

function closedStatus(): RemoteStatus {
  return {
    enabled: false,
    listening: undefined,
    pairing: { kind: "closed" },
    devices: [],
    problem: undefined,
    // M11 Task 2 minimal compile fix (Task 4 owns the real desktop wiring).
    sidecarProxy: "off",
  };
}

// The countdown bar arms a real setInterval on open (remote-status.ts has
// no app.ts tick to reuse — see the comment above countdownTimer there) —
// closing whatever dialog a test left open, after every test in this file,
// keeps that interval from outliving its test and firing against a since-
// replaced #remote-confirm-countdown-bar in a later test's fresh harness().
afterEach(() => {
  if (document.getElementById("remote-confirm") !== null) {
    renderPairingConfirmation({ ...closedStatus(), pairing: { kind: "closed" } });
  }
});

function harness(): void {
  document.body.innerHTML = `
    <button id="nav-settings"></button>
    <button id="remote-pill" hidden><span class="remote-glyph"></span><span id="remote-pill-text"></span></button>
    <div id="remote-confirm" hidden>
      <div id="remote-confirm-title"></div>
      <div id="remote-confirm-subtitle"></div>
      <div id="remote-confirm-device-label"></div>
      <div id="remote-confirm-body"></div>
      <div id="remote-confirm-from-label"></div>
      <div id="remote-confirm-from"></div>
      <div id="remote-confirm-countdown-bar"></div>
      <span id="remote-confirm-warning-text"></span>
      <button id="remote-confirm-approve"></button>
      <button id="remote-confirm-deny"></button>
    </div>`;
}

describe("renderRemoteIndicator", () => {
  beforeEach(() => harness());

  it("hides the pill when nothing is listening", () => {
    renderRemoteIndicator(closedStatus());
    expect((document.getElementById("remote-pill") as HTMLElement).hidden).toBe(true);
  });

  it("shows only host:port and moves the listening sentence to the title", () => {
    renderRemoteIndicator({
      ...closedStatus(),
      listening: {
        host: "127.0.0.1",
        port: 7717,
        fingerprint: "ab",
        certificate: { source: "self-signed", hostname: undefined },
      },
    });
    const pill = document.getElementById("remote-pill") as HTMLElement;
    expect(pill.hidden).toBe(false);
    expect(document.getElementById("remote-pill-text")?.textContent).toBe("127.0.0.1:7717");
    expect(pill.title).toBe(MESSAGES.remoteIndicator("127.0.0.1", 7717, false, PRIMARY_LANGUAGE));
    expect(pill.querySelector(".remote-glyph")?.classList).toContain("remote-glyph--good");
  });

  it("uses an amber dot and idle deadline sentence while auto-disable is armed", () => {
    const disableAt = new Date("2026-09-19T18:30:00").getTime();
    renderRemoteIndicator({
      ...closedStatus(),
      listening: {
        host: "127.0.0.1",
        port: 7717,
        fingerprint: "ab",
        certificate: { source: "self-signed", hostname: undefined },
      },
      idle: { kind: "armed", disableAt },
    });
    const pill = document.getElementById("remote-pill") as HTMLElement;
    expect(pill.title).toContain("18:30");
    expect(pill.querySelector(".remote-glyph")?.classList).toContain("remote-glyph--warn");
  });

  it("keeps the last host:port with a grey dot after idle auto-disable", () => {
    renderRemoteIndicator({
      ...closedStatus(),
      listening: {
        host: "127.0.0.1",
        port: 7717,
        fingerprint: "ab",
        certificate: { source: "self-signed", hostname: undefined },
      },
    });
    renderRemoteIndicator({
      ...closedStatus(),
      idle: { kind: "disabled", at: 0, afterMinutes: 30 },
    });
    const pill = document.getElementById("remote-pill") as HTMLElement;
    expect(pill.hidden).toBe(false);
    expect(document.getElementById("remote-pill-text")?.textContent).toBe("127.0.0.1:7717");
    expect(pill.title).toContain("off");
    expect(pill.querySelector(".remote-glyph")?.classList).toContain("remote-glyph--off");
  });
});

describe("renderPairingConfirmation", () => {
  beforeEach(() => harness());

  it("is hidden for an open pairing status", () => {
    renderPairingConfirmation({
      ...closedStatus(),
      pairing: { kind: "open", uri: "x", expiresAt: 0 },
    });
    expect((document.getElementById("remote-confirm") as HTMLElement).hidden).toBe(true);
  });

  it("is hidden for a closed pairing status", () => {
    renderPairingConfirmation(closedStatus());
    expect((document.getElementById("remote-confirm") as HTMLElement).hidden).toBe(true);
  });

  it("shows the device name as literal text, never as markup, and focuses Deny", () => {
    renderPairingConfirmation({
      ...closedStatus(),
      pairing: {
        kind: "confirming",
        requestId: "req-img",
        deviceName: "<img src=x>",
        address: "10.0.0.9:1",
        expiresAt: 0,
      },
    });
    const dialog = document.getElementById("remote-confirm") as HTMLElement;
    expect(dialog.hidden).toBe(false);
    const body = document.getElementById("remote-confirm-body") as HTMLElement;
    expect(body.querySelector("img")).toBeNull();
    expect(body.textContent).toContain("<img src=x>");
    expect(document.activeElement).toBe(document.getElementById("remote-confirm-deny"));
  });

  // P15/D4: the connecting address, shown alongside the phone-chosen name.
  it("shows the connecting address as a second line", () => {
    renderPairingConfirmation({
      ...closedStatus(),
      pairing: {
        kind: "confirming",
        requestId: "req-address",
        deviceName: "Phone",
        address: "203.0.113.7:51820",
        expiresAt: 0,
      },
    });
    const from = document.getElementById("remote-confirm-from") as HTMLElement;
    expect(from.textContent).toContain("203.0.113.7:51820");
  });

  it("renders the subtitle and the facts row labels through MESSAGES", () => {
    renderPairingConfirmation({
      ...closedStatus(),
      pairing: {
        kind: "confirming",
        requestId: "req-labels",
        deviceName: "Probe",
        address: "10.0.0.9:1",
        expiresAt: 0,
      },
    });
    expect(document.getElementById("remote-confirm-subtitle")?.textContent).toBe(
      MESSAGES.remoteConfirmSubtitle(PRIMARY_LANGUAGE),
    );
    expect(document.getElementById("remote-confirm-device-label")?.textContent).toBe(
      MESSAGES.remoteConfirmDeviceLabel(PRIMARY_LANGUAGE),
    );
    expect(document.getElementById("remote-confirm-from-label")?.textContent).toBe(
      MESSAGES.remoteConfirmFromLabel(PRIMARY_LANGUAGE),
    );
  });

  it("the countdown bar shrinks between two 1s ticks and turns amber under 30s remaining", () => {
    vi.useFakeTimers();
    try {
      const start = Date.UTC(2026, 0, 1, 12, 0, 0);
      vi.setSystemTime(start);
      renderPairingConfirmation({
        ...closedStatus(),
        pairing: {
          kind: "confirming",
          requestId: "req-countdown",
          deviceName: "Probe",
          address: "10.0.0.9:1",
          expiresAt: start + 50_000,
        },
      });
      const bar = document.getElementById("remote-confirm-countdown-bar") as HTMLElement;
      const initialWidth = Number.parseFloat(bar.style.inlineSize);
      expect(initialWidth).toBeCloseTo(100, 0);
      expect(bar.classList.contains("remote-confirm-countdown-bar--warn")).toBe(false);

      vi.advanceTimersByTime(10_000);
      const midWidth = Number.parseFloat(bar.style.inlineSize);
      expect(midWidth).toBeLessThan(initialWidth);
      expect(bar.classList.contains("remote-confirm-countdown-bar--warn")).toBe(false);

      vi.advanceTimersByTime(15_000); // 25s elapsed, 25s left of the 50s window — under the 30s warn line
      expect(bar.classList.contains("remote-confirm-countdown-bar--warn")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls decideRemotePairing exactly once on Approve, even double-clicked, and hides the dialog", () => {
    const api = {
      remoteStatus: vi.fn(async () => closedStatus()),
      onRemoteStatus: vi.fn(),
      decideRemotePairing: vi.fn(async () => undefined),
    };
    initRemoteStatus(api);
    renderPairingConfirmation({
      ...closedStatus(),
      pairing: {
        kind: "confirming",
        requestId: "req-approve-dbl",
        deviceName: "Probe",
        address: "10.0.0.9:1",
        expiresAt: 0,
      },
    });
    const approve = document.getElementById("remote-confirm-approve") as HTMLButtonElement;
    approve.click();
    approve.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(api.decideRemotePairing).toHaveBeenCalledTimes(1);
    expect(api.decideRemotePairing).toHaveBeenCalledWith("req-approve-dbl", true);
    expect((document.getElementById("remote-confirm") as HTMLElement).hidden).toBe(true);
  });

  it("Escape denies", () => {
    const api = {
      remoteStatus: vi.fn(async () => closedStatus()),
      onRemoteStatus: vi.fn(),
      decideRemotePairing: vi.fn(async () => undefined),
    };
    initRemoteStatus(api);
    renderPairingConfirmation({
      ...closedStatus(),
      pairing: {
        kind: "confirming",
        requestId: "req-escape",
        deviceName: "Probe",
        address: "10.0.0.9:1",
        expiresAt: 0,
      },
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(api.decideRemotePairing).toHaveBeenCalledTimes(1);
    expect(api.decideRemotePairing).toHaveBeenCalledWith("req-escape", false);
  });

  it("a different requestId resets the once-only guard", () => {
    const api = {
      remoteStatus: vi.fn(async () => closedStatus()),
      onRemoteStatus: vi.fn(),
      decideRemotePairing: vi.fn(async () => undefined),
    };
    initRemoteStatus(api);
    renderPairingConfirmation({
      ...closedStatus(),
      pairing: {
        kind: "confirming",
        requestId: "req-guard-a",
        deviceName: "One",
        address: "10.0.0.9:1",
        expiresAt: 0,
      },
    });
    document.getElementById("remote-confirm-approve")?.dispatchEvent(new Event("click"));

    renderPairingConfirmation({
      ...closedStatus(),
      pairing: {
        kind: "confirming",
        requestId: "req-guard-b",
        deviceName: "Two",
        address: "10.0.0.9:1",
        expiresAt: 0,
      },
    });
    document.getElementById("remote-confirm-approve")?.dispatchEvent(new Event("click"));

    expect(api.decideRemotePairing).toHaveBeenCalledTimes(2);
    expect(api.decideRemotePairing).toHaveBeenNthCalledWith(1, "req-guard-a", true);
    expect(api.decideRemotePairing).toHaveBeenNthCalledWith(2, "req-guard-b", true);
  });
});

describe("renderPairingConfirmation — decided requests and re-pushes", () => {
  beforeEach(() => harness());

  it("approve, then the same confirming status pushed again: stays hidden, no second decide", () => {
    const api = {
      remoteStatus: vi.fn(async () => closedStatus()),
      onRemoteStatus: vi.fn(),
      decideRemotePairing: vi.fn(async () => undefined),
    };
    initRemoteStatus(api);
    const confirming: RemoteStatus = {
      ...closedStatus(),
      pairing: {
        kind: "confirming",
        requestId: "req-decided-repush",
        deviceName: "Probe",
        address: "10.0.0.9:1",
        expiresAt: 0,
      },
    };
    renderPairingConfirmation(confirming);
    document.getElementById("remote-confirm-approve")?.dispatchEvent(new Event("click"));
    expect((document.getElementById("remote-confirm") as HTMLElement).hidden).toBe(true);

    // The bridge may still be broadcasting the same (now stale) confirming
    // status for a moment after the decision — the dialog must not come
    // back with buttons bound to a request the bridge already resolved.
    renderPairingConfirmation(confirming);

    expect((document.getElementById("remote-confirm") as HTMLElement).hidden).toBe(true);
    expect(api.decideRemotePairing).toHaveBeenCalledTimes(1);
  });

  it("two pushes with the same undecided requestId focus Deny once, and leave focus alone the second time", () => {
    const confirming: RemoteStatus = {
      ...closedStatus(),
      pairing: {
        kind: "confirming",
        requestId: "req-focus-twice",
        deviceName: "Probe",
        address: "10.0.0.9:1",
        expiresAt: 0,
      },
    };
    renderPairingConfirmation(confirming);
    const deny = document.getElementById("remote-confirm-deny") as HTMLButtonElement;
    const approve = document.getElementById("remote-confirm-approve") as HTMLButtonElement;
    expect(document.activeElement).toBe(deny);

    // The user tabs to Approve; a second push of the identical status must
    // not steal focus back to Deny.
    approve.focus();
    const focusSpy = vi.spyOn(deny, "focus");
    renderPairingConfirmation(confirming);

    expect(focusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(approve);
  });

  it("restores the focus that was active before the dialog opened, once it closes", () => {
    const api = {
      remoteStatus: vi.fn(async () => closedStatus()),
      onRemoteStatus: vi.fn(),
      decideRemotePairing: vi.fn(async () => undefined),
    };
    initRemoteStatus(api); // wires the Deny button's click listener
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    renderPairingConfirmation({
      ...closedStatus(),
      pairing: {
        kind: "confirming",
        requestId: "req-restore-focus",
        deviceName: "Probe",
        address: "10.0.0.9:1",
        expiresAt: 0,
      },
    });
    expect(document.activeElement).not.toBe(trigger);

    document.getElementById("remote-confirm-deny")?.dispatchEvent(new Event("click"));
    expect(document.activeElement).toBe(trigger);
  });

  it("Tab cycles focus between Approve and Deny while the dialog is open", () => {
    renderPairingConfirmation({
      ...closedStatus(),
      pairing: {
        kind: "confirming",
        requestId: "req-tab-trap",
        deviceName: "Probe",
        address: "10.0.0.9:1",
        expiresAt: 0,
      },
    });
    const deny = document.getElementById("remote-confirm-deny") as HTMLButtonElement;
    const approve = document.getElementById("remote-confirm-approve") as HTMLButtonElement;
    expect(document.activeElement).toBe(deny);

    deny.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(approve);

    approve.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(deny);
  });

  it("logs rather than throws when decideRemotePairing rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const api = {
      remoteStatus: vi.fn(async () => closedStatus()),
      onRemoteStatus: vi.fn(),
      decideRemotePairing: vi.fn(async () => {
        throw new Error("network");
      }),
    };
    initRemoteStatus(api);
    renderPairingConfirmation({
      ...closedStatus(),
      pairing: {
        kind: "confirming",
        requestId: "req-reject",
        deviceName: "Probe",
        address: "10.0.0.9:1",
        expiresAt: 0,
      },
    });
    document.getElementById("remote-confirm-approve")?.dispatchEvent(new Event("click"));
    await Promise.resolve();
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("renderPairingConfirmation — routing away from a hosted WebContentsView", () => {
  beforeEach(() => harness());
  afterEach(() => showView("dashboard"));

  it("clicks the Settings nav button on a new request while the Workspace route is showing", () => {
    showView("workspace");
    let clicked = 0;
    document.getElementById("nav-settings")?.addEventListener("click", () => {
      clicked += 1;
    });

    renderPairingConfirmation({
      ...closedStatus(),
      pairing: {
        kind: "confirming",
        requestId: "req-nav-workspace",
        deviceName: "Probe",
        address: "10.0.0.9:1",
        expiresAt: 0,
      },
    });

    expect(clicked).toBe(1);
  });

  it("does not navigate when the Dashboard route is already showing", () => {
    showView("dashboard");
    let clicked = 0;
    document.getElementById("nav-settings")?.addEventListener("click", () => {
      clicked += 1;
    });

    renderPairingConfirmation({
      ...closedStatus(),
      pairing: {
        kind: "confirming",
        requestId: "req-nav-dashboard",
        deviceName: "Probe",
        address: "10.0.0.9:1",
        expiresAt: 0,
      },
    });

    expect(clicked).toBe(0);
  });
});

describe("withNameInBdi", () => {
  it("wraps the name in a <bdi> between the given before/after text, never as markup", () => {
    const fragment = withNameInBdi("Hello ", "<img src=x>", "!");
    const div = document.createElement("div");
    div.append(fragment);
    expect(div.querySelector("img")).toBeNull();
    expect(div.querySelector("bdi")?.textContent).toBe("<img src=x>");
    expect(div.textContent).toBe("Hello <img src=x>!");
  });
});

describe("initRemoteStatus", () => {
  beforeEach(() => harness());

  it("pulls once, subscribes, stores the latest and notifies listeners", async () => {
    let pushed: ((status: RemoteStatus) => void) | undefined;
    const status = { ...closedStatus(), enabled: true };
    const api = {
      remoteStatus: vi.fn(async () => status),
      onRemoteStatus: vi.fn((cb: (status: RemoteStatus) => void) => {
        pushed = cb;
      }),
      decideRemotePairing: vi.fn(async () => undefined),
    };
    const heard: RemoteStatus[] = [];
    onRemoteStatusChange((s) => heard.push(s));

    initRemoteStatus(api);
    await Promise.resolve();
    await Promise.resolve();

    expect(latestRemoteStatus()).toEqual(status);
    expect(heard.at(-1)).toEqual(status);

    const pushedStatus = { ...closedStatus(), enabled: false };
    pushed?.(pushedStatus);
    expect(latestRemoteStatus()).toEqual(pushedStatus);
  });

  it("does not throw when the initial remoteStatus() call rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const api = {
      remoteStatus: vi.fn(async () => {
        throw new Error("boom");
      }),
      onRemoteStatus: vi.fn(),
      decideRemotePairing: vi.fn(async () => undefined),
    };
    expect(() => initRemoteStatus(api)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    // Logged rather than silently swallowed.
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("logs rather than throws when rendering a later pushed status fails", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let pushed: ((status: RemoteStatus) => void) | undefined;
    const api = {
      remoteStatus: vi.fn(async () => closedStatus()),
      onRemoteStatus: vi.fn((cb: (status: RemoteStatus) => void) => {
        pushed = cb;
      }),
      decideRemotePairing: vi.fn(async () => undefined),
    };
    initRemoteStatus(api);

    // The markup goes missing under the pushed handler specifically (e.g. a
    // route change tore down the topbar in some hypothetical future) —
    // handleStatus's own try/catch must keep this from taking the rest of
    // the push pipeline down.
    document.getElementById("remote-pill")?.remove();
    expect(() => pushed?.(closedStatus())).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
