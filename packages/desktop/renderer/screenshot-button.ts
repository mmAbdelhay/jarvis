import type { RendererApi } from "../src/ipc.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { attachHoverTip } from "./hover-tip.js";
import { setScreenshotToastOpen } from "./views.js";

// The topbar screenshot button. The menu is native (main pops it), so a
// hosted page can never cover it; the result popover is DOM, so while it is
// showing the hosted page is kept off screen (views.ts), as the other topbar
// menus do. The renderer only ever holds a thumbnail and an opaque id.

type ScreenshotApi = Partial<
  Pick<RendererApi, "showScreenshotMenu" | "saveScreenshot" | "onScreenshotResult">
>;

const AUTO_HIDE_MS = 8000;

/** Wires #screenshot-button and #screenshot-toast. Absent markup is a no-op;
 *  an absent api (the phone web client) hides the button. */
export function initScreenshotButton(
  api: ScreenshotApi,
  language: "ar" | "en" = PRIMARY_LANGUAGE,
): void {
  const button = document.getElementById("screenshot-button");
  if (button === null) return;
  const { showScreenshotMenu, saveScreenshot, onScreenshotResult } = api;
  if (
    typeof showScreenshotMenu !== "function" ||
    typeof saveScreenshot !== "function" ||
    typeof onScreenshotResult !== "function"
  ) {
    button.hidden = true;
    return;
  }
  const toast = document.getElementById("screenshot-toast");
  const thumbEl = document.getElementById("screenshot-thumb");
  const text = document.getElementById("screenshot-text");
  const save = document.getElementById("screenshot-save");
  const dismiss = document.getElementById("screenshot-dismiss");
  if (!toast || !(thumbEl instanceof HTMLImageElement) || !text || !save || !dismiss) return;

  const thumb: HTMLImageElement = thumbEl;
  const label = MESSAGES.screenshotButtonLabel(language);
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.setAttribute("aria-haspopup", "menu");
  toast.setAttribute("aria-label", label);
  save.textContent = MESSAGES.screenshotSaveAs(language);
  dismiss.setAttribute("aria-label", MESSAGES.screenshotDismiss(language));
  dismiss.setAttribute("title", MESSAGES.screenshotDismiss(language));
  thumb.alt = MESSAGES.screenshotPreviewAlt(language);

  let currentId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let held = false; // hovered or focused: the clock is paused
  let hovered = false;
  let focused = false;

  const stopClock = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const startClock = (): void => {
    stopClock();
    if (held) return;
    timer = setTimeout(() => hide(false), AUTO_HIDE_MS);
  };

  const hide = (returnFocus: boolean): void => {
    stopClock();
    held = false;
    hovered = false;
    focused = false;
    if (toast.hidden) return;
    const hadFocus = toast.contains(document.activeElement);
    toast.hidden = true;
    currentId = undefined;
    setScreenshotToastOpen(false);
    if (returnFocus && hadFocus && button instanceof HTMLElement) button.focus();
  };

  const place = (): void => {
    const rect = button.getBoundingClientRect();
    const rtl = document.documentElement.dir === "rtl";
    toast.style.top = `${Math.round(rect.bottom + 6)}px`;
    if (rtl) {
      toast.style.left = `${Math.round(rect.left)}px`;
      toast.style.right = "auto";
    } else {
      toast.style.right = `${Math.round(window.innerWidth - rect.right)}px`;
      toast.style.left = "auto";
    }
  };

  const show = (options: { id?: string; thumbnail?: string; message: string }): void => {
    currentId = options.id;
    held = hovered || focused;
    const withImage = options.thumbnail !== undefined;
    thumb.hidden = !withImage;
    if (withImage) thumb.src = options.thumbnail ?? "";
    else thumb.removeAttribute("src");
    save.hidden = options.id === undefined;
    text.textContent = options.message;
    place();
    const wasHidden = toast.hidden;
    toast.hidden = false;
    if (wasHidden) setScreenshotToastOpen(true);
    startClock();
  };

  attachHoverTip(button);
  button.dataset["tip"] = label;
  button.addEventListener("click", () => {
    hide(false);
    const rect = button.getBoundingClientRect();
    void showScreenshotMenu(Math.round(rect.left), Math.round(rect.bottom + 4)).catch(
      (error: unknown) => console.error(`screenshot menu: ${String(error)}`),
    );
  });

  onScreenshotResult((outcome) => {
    if (outcome.ok) {
      show({
        id: outcome.id,
        thumbnail: outcome.thumbnail,
        message: MESSAGES.screenshotCopied(language),
      });
    } else if (outcome.reason !== "cancelled") {
      show({ message: outcome.message });
    }
  });

  save.addEventListener("click", () => {
    const id = currentId;
    if (id === undefined) return;
    stopClock();
    void saveScreenshot(id)
      .then((result) => {
        if (currentId !== id) return;
        if (result.ok) {
          text.textContent = MESSAGES.screenshotSaved(result.name, language);
        } else if (result.reason !== "cancelled") {
          text.textContent = result.message;
          if (result.reason === "invalid") save.hidden = true;
        }
        startClock();
      })
      .catch((error: unknown) => {
        console.error(`screenshot save: ${String(error)}`);
        startClock();
      });
  });
  dismiss.addEventListener("click", () => hide(true));

  // Hovered or focused: the clock is paused, and restarts when both end.
  const sync = (): void => {
    held = hovered || focused;
    if (held) stopClock();
    else startClock();
  };
  toast.addEventListener("mouseenter", () => {
    hovered = true;
    sync();
  });
  toast.addEventListener("mouseleave", () => {
    hovered = false;
    sync();
  });
  toast.addEventListener("focusin", () => {
    focused = true;
    sync();
  });
  toast.addEventListener("focusout", (event) => {
    const next = (event as FocusEvent).relatedTarget;
    focused = next instanceof Node && toast.contains(next);
    sync();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !toast.hidden) {
      event.preventDefault();
      hide(true);
    }
  });
}
