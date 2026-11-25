// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGES } from "../src/messages.js";
import type { ScreenshotOutcome } from "../src/screenshot.js";
import { initScreenshotButton } from "./screenshot-button.js";
import { setScreenshotToastOpen } from "./views.js";

vi.mock("./views.js", () => ({ setScreenshotToastOpen: vi.fn() }));

const OK: ScreenshotOutcome = {
  ok: true,
  id: "abc",
  thumbnail: "data:image/png;base64,AAAA",
  width: 100,
  height: 50,
};

function mount(): void {
  document.body.innerHTML = `
    <div class="topbar"><button id="screenshot-button" class="icon-btn" type="button" aria-haspopup="menu"></button></div>
    <div id="screenshot-toast" class="shot-toast" role="status" hidden>
      <img id="screenshot-thumb" alt="" />
      <span id="screenshot-text"></span>
      <button id="screenshot-save" type="button"></button>
      <button id="screenshot-dismiss" type="button"></button>
    </div>`;
}

function api(over: Record<string, unknown> = {}) {
  let push: ((o: ScreenshotOutcome) => void) | undefined;
  const fake = {
    showScreenshotMenu: vi.fn(async () => undefined),
    saveScreenshot: vi.fn(async () => ({ ok: true as const, path: "/a/b.png", name: "b.png" })),
    onScreenshotResult: vi.fn((cb: (o: ScreenshotOutcome) => void) => {
      push = cb;
    }),
    ...over,
  };
  return { fake, push: (o: ScreenshotOutcome) => push?.(o) };
}

const el = (id: string) => document.getElementById(id) as HTMLElement;

describe("the topbar screenshot button", () => {
  const toastOpen = vi.mocked(setScreenshotToastOpen);
  beforeEach(() => {
    vi.useFakeTimers();
    mount();
    toastOpen.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("labels the button and opens the native menu under it on click", () => {
    const { fake } = api();
    initScreenshotButton(fake as never);
    const button = el("screenshot-button");
    expect(button.getAttribute("aria-label")).toBe(MESSAGES.screenshotButtonLabel("en"));
    expect(button.getAttribute("title")).toBe(MESSAGES.screenshotButtonLabel("en"));
    button.getBoundingClientRect = () => ({ left: 100, bottom: 40, right: 132, top: 8 }) as DOMRect;
    button.click();
    expect(fake.showScreenshotMenu).toHaveBeenCalledWith(100, 44);
  });

  it("hides the button when the api is missing (phone web client)", () => {
    initScreenshotButton({} as never);
    expect(el("screenshot-button").hidden).toBe(true);
    const { fake } = api({ showScreenshotMenu: undefined });
    mount();
    initScreenshotButton(fake as never);
    expect(el("screenshot-button").hidden).toBe(true);
  });

  it("is a no-op without its markup", () => {
    document.body.innerHTML = "";
    expect(() => initScreenshotButton(api().fake as never)).not.toThrow();
  });

  it("shows the thumbnail, Copied to clipboard, Save as and Dismiss for a capture", () => {
    const { fake, push } = api();
    initScreenshotButton(fake as never);
    push(OK);
    const toast = el("screenshot-toast");
    expect(toast.hidden).toBe(false);
    expect(toast.getAttribute("role")).toBe("status");
    expect(el("screenshot-thumb").getAttribute("src")).toBe(OK.ok ? OK.thumbnail : "");
    expect(el("screenshot-thumb").getAttribute("alt")).toBe(MESSAGES.screenshotPreviewAlt("en"));
    expect(el("screenshot-text").textContent).toBe("Copied to clipboard");
    expect(el("screenshot-save").textContent).toBe("Save as…");
    expect(el("screenshot-dismiss").getAttribute("aria-label")).toBe("Dismiss");
    expect(toastOpen).toHaveBeenLastCalledWith(true);
  });

  it("stays silent for a cancelled capture", () => {
    const { fake, push } = api();
    initScreenshotButton(fake as never);
    push({ ok: false, reason: "cancelled" });
    expect(el("screenshot-toast").hidden).toBe(true);
  });

  it("says why when a capture failed or needs permission, without a thumbnail or Save", () => {
    const { fake, push } = api();
    initScreenshotButton(fake as never);
    push({ ok: false, reason: "permission", message: "Allow Jarvis in Screen Recording" });
    expect(el("screenshot-toast").hidden).toBe(false);
    expect(el("screenshot-text").textContent).toBe("Allow Jarvis in Screen Recording");
    expect(el("screenshot-thumb").hidden).toBe(true);
    expect(el("screenshot-save").hidden).toBe(true);
  });

  it("Save as sends only the id, and confirms with the saved name", async () => {
    const { fake, push } = api();
    initScreenshotButton(fake as never);
    push(OK);
    el("screenshot-save").click();
    expect(fake.saveScreenshot).toHaveBeenCalledWith("abc");
    await vi.advanceTimersByTimeAsync(0);
    expect(el("screenshot-text").textContent).toBe(MESSAGES.screenshotSaved("b.png", "en"));
    expect(el("screenshot-toast").hidden).toBe(false);
  });

  it("a cancelled save dialog changes nothing", async () => {
    const { fake, push } = api({
      saveScreenshot: vi.fn(async () => ({ ok: false as const, reason: "cancelled" as const })),
    });
    initScreenshotButton(fake as never);
    push(OK);
    el("screenshot-save").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(el("screenshot-text").textContent).toBe("Copied to clipboard");
  });

  it("shows the message of a failed save", async () => {
    const { fake, push } = api({
      saveScreenshot: vi.fn(async () => ({
        ok: false as const,
        reason: "failed" as const,
        message: "Could not save: disk full",
      })),
    });
    initScreenshotButton(fake as never);
    push(OK);
    el("screenshot-save").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(el("screenshot-text").textContent).toBe("Could not save: disk full");
  });

  it("auto-hides after about eight seconds and gives the hosted page back", () => {
    const { fake, push } = api();
    initScreenshotButton(fake as never);
    push(OK);
    vi.advanceTimersByTime(7900);
    expect(el("screenshot-toast").hidden).toBe(false);
    vi.advanceTimersByTime(200);
    expect(el("screenshot-toast").hidden).toBe(true);
    expect(toastOpen).toHaveBeenLastCalledWith(false);
  });

  it("does not auto-hide while hovered or focused, and restarts the clock after", () => {
    const { fake, push } = api();
    initScreenshotButton(fake as never);
    push(OK);
    const toast = el("screenshot-toast");
    toast.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(30000);
    expect(toast.hidden).toBe(false);
    toast.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(7900);
    expect(toast.hidden).toBe(false);
    vi.advanceTimersByTime(200);
    expect(toast.hidden).toBe(true);

    push(OK);
    el("screenshot-save").focus();
    toast.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    vi.advanceTimersByTime(30000);
    expect(toast.hidden).toBe(false);
    toast.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    vi.advanceTimersByTime(8100);
    expect(toast.hidden).toBe(true);
  });

  it("Dismiss and Escape close it", () => {
    const { fake, push } = api();
    initScreenshotButton(fake as never);
    push(OK);
    el("screenshot-dismiss").click();
    expect(el("screenshot-toast").hidden).toBe(true);
    push(OK);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(el("screenshot-toast").hidden).toBe(true);
    expect(toastOpen).toHaveBeenLastCalledWith(false);
  });

  it("Escape returns focus to the button when focus was inside the popover", () => {
    const { fake, push } = api();
    initScreenshotButton(fake as never);
    push(OK);
    el("screenshot-save").focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.activeElement).toBe(el("screenshot-button"));
  });

  it("a new capture replaces the popover and restarts the clock", () => {
    const { fake, push } = api();
    initScreenshotButton(fake as never);
    push(OK);
    vi.advanceTimersByTime(6000);
    push({ ...OK, id: "def" } as ScreenshotOutcome);
    vi.advanceTimersByTime(6000);
    expect(el("screenshot-toast").hidden).toBe(false);
    el("screenshot-save").click();
    expect(fake.saveScreenshot).toHaveBeenCalledWith("def");
  });

  it("opening the menu closes a showing popover", () => {
    const { fake, push } = api();
    initScreenshotButton(fake as never);
    push(OK);
    el("screenshot-button").click();
    expect(el("screenshot-toast").hidden).toBe(true);
  });

  it("positions the popover under the button, mirrored in RTL", () => {
    const { fake, push } = api();
    initScreenshotButton(fake as never);
    el("screenshot-button").getBoundingClientRect = () =>
      ({ left: 700, right: 732, bottom: 40, top: 8 }) as DOMRect;
    push(OK);
    const toast = el("screenshot-toast");
    expect(toast.style.top).toBe("46px");
    expect(toast.style.left).toBe("auto");
    expect(toast.style.right).toBe(`${window.innerWidth - 732}px`);
    document.documentElement.dir = "rtl";
    push(OK);
    expect(toast.style.left).toBe("700px");
    expect(toast.style.right).toBe("auto");
    document.documentElement.dir = "";
  });
});
