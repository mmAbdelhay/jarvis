import type { Session } from "electron";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bridgeEvents,
  bridgePopupWindow,
  hostedUserAgent,
  type HostedViewEvent,
  type PopupPolicy,
  type WebContentsLike,
  type WindowOpenDetails,
  type WindowOpenResponse,
} from "./browser-host.js";

// A popup that opens as a tab loses window.opener, and a sign-in or Meet
// window reports back through exactly that. So what asked to be a window
// becomes one — unless the user turned popups off.
describe("popup windows", () => {
  const windowOptions = { width: 1 };
  let contents: FakeContents;
  let events: HostedViewEvent[];
  let allowed: boolean;
  const policy: PopupPolicy = { allow: () => allowed, windowOptions };
  const open = (details: WindowOpenDetails): WindowOpenResponse | undefined =>
    contents.popupHandler?.(details);

  beforeEach(() => {
    contents = new FakeContents();
    events = [];
    allowed = true;
    bridgeEvents(
      contents,
      { canGoBack: () => false, canGoForward: () => false },
      (event) => events.push(event),
      policy,
    );
  });

  it("opens a window.open that asked for a window as a real window", () => {
    expect(
      open({ url: "https://accounts.google.com/o/oauth2", disposition: "new-window" }),
    ).toEqual({
      action: "allow",
      overrideBrowserWindowOptions: windowOptions,
    });
    expect(events).toEqual([]);
  });

  // The usual sign-in pattern: open an empty window, then navigate it.
  it("allows the empty window a sign-in opens first", () => {
    expect(open({ url: "about:blank", disposition: "new-window" })).toMatchObject({
      action: "allow",
    });
  });

  it("still opens target=_blank as a tab", () => {
    expect(open({ url: "https://example.com/help", disposition: "foreground-tab" })).toEqual({
      action: "deny",
    });
    expect(events).toEqual([{ kind: "popup", url: "https://example.com/help" }]);
  });

  it("opens popups as tabs once the user turns them off", () => {
    allowed = false;

    expect(open({ url: "https://meet.google.com/x", disposition: "new-window" })).toEqual({
      action: "deny",
    });
    expect(events).toEqual([{ kind: "popup", url: "https://meet.google.com/x" }]);
  });

  it("never gives a non-web scheme a window", () => {
    expect(open({ url: "file:///etc/passwd", disposition: "new-window" })).toEqual({
      action: "deny",
    });
  });

  // A popup window gets no tab of its own, but it must not be a way around
  // the navigation gate or the popup decision.
  it("guards a popup window the same way as the page", () => {
    const popup = new FakeContents();
    bridgePopupWindow(popup, (event) => events.push(event), policy);

    let prevented = false;
    popup.fire("will-navigate", { preventDefault: () => (prevented = true) }, "file:///etc/passwd");
    expect(prevented).toBe(true);
    expect(
      popup.popupHandler?.({ url: "https://example.com", disposition: "new-window" }),
    ).toMatchObject({
      action: "allow",
    });
    expect(
      popup.popupHandler?.({ url: "https://example.com/doc", disposition: "foreground-tab" }),
    ).toEqual({
      action: "deny",
    });
    expect(events).toEqual([{ kind: "popup", url: "https://example.com/doc" }]);
  });
});

class FakeContents implements WebContentsLike {
  #handlers = new Map<string, ((...args: never[]) => void)[]>();
  popupHandler: ((details: WindowOpenDetails) => WindowOpenResponse) | undefined;
  /** What getURL() answers — settable per test, the way real WebContents'
   *  current URL would vary. */
  url = "https://a.test/page";
  /** A stand-in for the view's real Session: opaque here, just an identity
   *  the tests can assert was threaded through unchanged. */
  session = { id: "fake-session" } as unknown as Session;

  on(event: string, listener: (...args: never[]) => void): this {
    const list = this.#handlers.get(event) ?? [];
    list.push(listener);
    this.#handlers.set(event, list);
    return this;
  }
  setWindowOpenHandler(handler: (details: WindowOpenDetails) => WindowOpenResponse): void {
    this.popupHandler = handler;
  }
  getURL(): string {
    return this.url;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const listener of this.#handlers.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }
}

describe("bridgeEvents", () => {
  let contents: FakeContents;
  let events: HostedViewEvent[];
  let back: boolean;
  let forward: boolean;

  beforeEach(() => {
    contents = new FakeContents();
    events = [];
    back = false;
    forward = false;
    bridgeEvents(contents, { canGoBack: () => back, canGoForward: () => forward }, (event) =>
      events.push(event),
    );
  });

  // A page going full screen is Chromium's business, not ours — but the
  // view it renders into is positioned by the renderer, which has to be
  // told so it can give the page the whole window instead of the tab slot.
  // Without this the video stayed exactly where it was and only Jarvis's
  // own chrome went away, which reads as "the app went full screen".
  it("reports a page entering and leaving full screen", () => {
    contents.fire("enter-html-full-screen");
    contents.fire("leave-html-full-screen");

    expect(events).toEqual([
      { kind: "fullscreen", fullscreen: true },
      { kind: "fullscreen", fullscreen: false },
    ]);
  });

  it("reports a title change", () => {
    contents.fire("page-title-updated", {}, "GitHub");

    expect(events).toEqual([{ kind: "title", title: "GitHub" }]);
  });

  // Chromium has already resolved the real icon by the time this fires.
  // The event carries the page's own URL and session because HostedView
  // exposes neither to BrowserHost — this is the only place either is read.
  it("reports the favicon Chromium resolved, with the page's URL and session", () => {
    contents.url = "https://a.test/page";
    contents.fire("page-favicon-updated", {}, [
      "https://a.test/icon.png",
      "https://a.test/other.png",
    ]);

    expect(events).toEqual([
      {
        kind: "favicon",
        pageUrl: "https://a.test/page",
        iconUrl: "https://a.test/icon.png",
        session: contents.session,
      },
    ]);
  });

  it("ignores a favicon event carrying no icons", () => {
    contents.fire("page-favicon-updated", {}, []);

    expect(events).toEqual([]);
  });

  // Minor 10: this is an untyped IPC payload. `[0]` on a *string* yields one
  // character, which used to become an "icon url" of "h" — a fetch that
  // fails and records a seven-day miss against the origin, suppressing the
  // site's real icon for that whole week.
  it.each([
    ["a bare string", "https://a.test/icon.png"],
    ["null", null],
    ["undefined", undefined],
    ["an object", { icon: "https://a.test/icon.png" }],
    ["an array of non-strings", [{ url: "https://a.test/icon.png" }]],
    ["an array holding an empty string", [""]],
  ])("ignores a favicon payload that is %s", (_name, payload) => {
    contents.fire("page-favicon-updated", {}, payload);

    expect(events).toEqual([]);
  });

  // Chromium tells us when media starts and stops. It is a prompt to ask
  // the page, not an answer in itself — see the host's own tests.
  it("reports media starting and stopping", () => {
    contents.fire("media-started-playing");
    contents.fire("media-paused");

    expect(events).toEqual([
      { kind: "media", playing: true },
      { kind: "media", playing: false },
    ]);
  });

  it("reports loading start and stop", () => {
    contents.fire("did-start-loading");
    contents.fire("did-stop-loading");

    expect(events).toEqual([
      { kind: "loading", loading: true },
      { kind: "loading", loading: false },
    ]);
  });

  it("reports a navigation with the history flags read at that moment", () => {
    back = true;
    contents.fire("did-navigate", {}, "https://github.com/login");

    expect(events).toEqual([
      { kind: "navigated", url: "https://github.com/login", canGoBack: true, canGoForward: false },
    ]);
  });

  // A single-page app changes URL without a document load; the address bar
  // has to follow, or it shows a stale page.
  it("reports an in-page navigation too", () => {
    contents.fire("did-navigate-in-page", {}, "https://github.com/issues#new", true);

    expect(events).toEqual([
      {
        kind: "navigated",
        url: "https://github.com/issues#new",
        canGoBack: false,
        canGoForward: false,
      },
    ]);
  });

  it("ignores an in-page navigation in a subframe", () => {
    contents.fire("did-navigate-in-page", {}, "https://ads.example/x", false);

    expect(events).toEqual([]);
  });

  it("reports a failed main-frame load with the description", () => {
    contents.fire("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://nope.example", true);

    expect(events).toEqual([{ kind: "failed", detail: "ERR_NAME_NOT_RESOLVED" }]);
  });

  it("ignores a failed subframe load", () => {
    contents.fire("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://ads.example", false);

    expect(events).toEqual([]);
  });

  // -3 is ERR_ABORTED, which Chromium emits for an ordinary user-cancelled
  // or superseded load. Surfacing it would put an error banner on a page
  // that is loading perfectly well.
  it("ignores an aborted load", () => {
    contents.fire("did-fail-load", {}, -3, "ERR_ABORTED", "https://github.com", true);

    expect(events).toEqual([]);
  });

  it("turns a window.open into a popup event and denies the native window", () => {
    const result = contents.popupHandler?.({ url: "https://example.com/help" });

    expect(result).toEqual({ action: "deny" });
    expect(events).toEqual([{ kind: "popup", url: "https://example.com/help" }]);
  });

  // Defence in depth: the address bar already gates schemes, and so does
  // BrowserHost.open. This covers the third route — a page navigating
  // itself — which neither of those sees.
  it("blocks a page navigating itself to a non-web scheme", () => {
    let prevented = false;
    contents.fire(
      "will-navigate",
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      "file:///etc/passwd",
    );

    expect(prevented).toBe(true);
  });

  it("allows a page to navigate itself to an https URL", () => {
    let prevented = false;
    contents.fire(
      "will-navigate",
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      "https://example.com",
    );

    expect(prevented).toBe(false);
  });
});

describe("hostedUserAgent", () => {
  const real =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) jarvis/0.0.0 Chrome/142.0.0.0 Electron/44.0.0 Safari/537.36";

  it("drops the Electron product token", () => {
    expect(hostedUserAgent(real)).not.toContain("Electron");
  });

  it("keeps every other product token, including Chrome", () => {
    const result = hostedUserAgent(real);
    expect(result).toContain("Chrome/142.0.0.0");
    expect(result).toContain("Safari/537.36");
    expect(result).toContain("jarvis/0.0.0");
  });

  it("leaves a user agent without the token alone", () => {
    const chrome =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
    expect(hostedUserAgent(chrome)).toBe(chrome);
  });

  it("leaves no double space where the token was", () => {
    expect(hostedUserAgent(real)).not.toContain("  ");
  });
});
