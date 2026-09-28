import type { Session } from "electron";
import { isSafeHref, type TabKind } from "@jarvis/core";

export type Rect = { x: number; y: number; width: number; height: number };

/** What a hosted page tells the host about itself. Deliberately small: the
 *  five facts the tab strip and address bar draw, plus the popup request. */
export type HostedViewEvent =
  | { kind: "navigated"; url: string; canGoBack: boolean; canGoForward: boolean }
  | { kind: "title"; title: string }
  | { kind: "loading"; loading: boolean }
  | { kind: "failed"; detail: string }
  | { kind: "popup"; url: string }
  /** Chromium noticed media start or stop in this page. Only a prompt to
   *  ask the page what it actually has — it fires for audio as readily as
   *  for video. See ViewReconciler's "media" case. */
  | { kind: "media"; playing: boolean }
  /** Chromium resolved this page's real favicon — including a site that
   *  declares it in HTML rather than serving /favicon.ico. `session` is
   *  the view's own, carried on the event because the reconciler otherwise has
   *  no route to it: HostedView deliberately exposes no WebContents. */
  | { kind: "favicon"; pageUrl: string; iconUrl: string; session: Session }
  /** The page asked Chromium for full screen (a video's own button, or any
   *  requestFullscreen call), or left it. Chromium handles the page's side;
   *  this exists because the view is positioned by the renderer, which is
   *  the only thing that can hand the page the whole window instead of the
   *  rectangle under the tab strip. */
  | { kind: "fullscreen"; fullscreen: boolean }
  /** This page's DevTools were closed by something other than the renderer
   *  asking — the user closing their undocked window. The renderer is the
   *  side that remembers which tabs have DevTools open, so it has to hear. */
  | { kind: "devtoolsClosed" };

/** Where a page's DevTools sit: beside the page in the Workspace layout, or
 *  in a window of their own. One choice for every tab, as in Chrome. */
export type DevToolsDock = "undocked" | "left" | "bottom" | "right";

export function isDevToolsDock(value: unknown): value is DevToolsDock {
  return value === "undocked" || value === "left" || value === "bottom" || value === "right";
}

/**
 * One page's worth of browser, as this host needs it. Electron is behind
 * this interface (see createElectronViewFactory) so the whole view lifecycle
 * — partitions, visibility, the facts reported back to the tab state — is
 * testable in plain Vitest with no window and no Chromium (see
 * view-reconciler.ts).
 */
export type HostedView = {
  loadURL(url: string): void;
  setBounds(bounds: Rect): void;
  setVisible(visible: boolean): void;
  goBack(): void;
  goForward(): void;
  reload(): void;
  destroy(): void;
  onEvent(listener: (event: HostedViewEvent) => void): void;
  /** Opens or closes this page's DevTools. They are rendered into a second
   *  view the host positions itself, rather than a detached window, so that
   *  they can be sized as part of the layout. */
  setDevTools(open: boolean): void;
  /** Where the DevTools view sits, in window pixels — measured by the
   *  renderer exactly as the page slot is. */
  setDevToolsBounds(bounds: Rect): void;
  /** Docked, the DevTools view lives in the main window at the bounds
   *  above; undocked, it moves into a window of its own. */
  setDevToolsDock(dock: DevToolsDock): void;
  /** Asks the page whether it has a <video> element that is genuinely
   *  playing — decoding frames, not merely present or merely audible.
   *  Answered by the page, because nothing outside it can tell. */
  hasPlayingVideo(): Promise<boolean>;
  /** Puts the page's playing video into Chromium's own Picture-in-Picture
   *  window: a small always-on-top window outside the app entirely, which
   *  is what makes the video survive switching tabs, routes and apps. */
  requestPictureInPicture(): void;
};

export type ViewFactory = (partition: string, kind: TabKind) => HostedView;

export type NavigationFacts = { canGoBack(): boolean; canGoForward(): boolean };

/** What a window.open asks for, as far as the popup decision reads it.
 *  `disposition` is Chromium's: "new-window" for a window.open that asked
 *  for a window, "foreground-tab"/"background-tab" for target=_blank and
 *  modifier-clicks. */
export type WindowOpenDetails = { url: string; disposition?: string };

export type WindowOpenResponse =
  | { action: "deny" }
  | { action: "allow"; overrideBrowserWindowOptions?: Record<string, unknown> };

/**
 * Whether a page's popups become real windows. `allow` is asked on every
 * popup rather than once, so it can follow a setting. `windowOptions` are
 * handed to Electron untouched — this module only decides, it never builds
 * a window.
 */
export type PopupPolicy = {
  allow(): boolean;
  windowOptions?: Record<string, unknown>;
};

/** The slice of Electron's WebContents a popup window needs guarding on. */
export type PopupContentsLike = {
  on(event: string, listener: (...args: never[]) => void): unknown;
  setWindowOpenHandler(handler: (details: WindowOpenDetails) => WindowOpenResponse): void;
};

/** The slice of Electron's WebContents this module uses. Narrow on purpose:
 *  it is what makes the event mapping testable without a window. */
export type WebContentsLike = PopupContentsLike & {
  /** The page's current URL — what a resolved favicon is cached against. */
  getURL(): string;
  /** This view's own session, so a favicon fetch goes through the same
   *  cookies as the page it belongs to (see cacheFavicon's caller). */
  session: Session;
};

/** Chromium's ERR_ABORTED — emitted for an ordinary superseded or cancelled
 *  load, not a failure the user should see. */
const ERR_ABORTED = -3;

/**
 * Chromium events to HostedViewEvent. All the judgement lives here — which
 * failures are real, which frames count, when the history flags are read —
 * so it is a pure function over an emitter rather than something only a
 * running window could exercise. electron-view.ts wires it to the real
 * WebContents.
 */
export function bridgeEvents(
  contents: WebContentsLike,
  navigation: NavigationFacts,
  emit: (event: HostedViewEvent) => void,
  popups?: PopupPolicy,
): void {
  const navigated = (url: string): void => {
    emit({
      kind: "navigated",
      url,
      canGoBack: navigation.canGoBack(),
      canGoForward: navigation.canGoForward(),
    });
  };

  const on = (event: string, listener: (...args: never[]) => void): void => {
    contents.on(event, listener);
  };

  // Chromium fires these on the WebContents whose page went full screen. It
  // has already resized its own compositing; what it cannot know is that
  // this WebContentsView is laid out by a renderer above it, so the page
  // would otherwise fill the tab slot and nothing else.
  on("enter-html-full-screen", (() => {
    emit({ kind: "fullscreen", fullscreen: true });
  }) as (...args: never[]) => void);

  on("leave-html-full-screen", (() => {
    emit({ kind: "fullscreen", fullscreen: false });
  }) as (...args: never[]) => void);

  on("page-title-updated", ((_event: unknown, title: string) => {
    emit({ kind: "title", title });
  }) as (...args: never[]) => void);

  // Chromium has already resolved the page's real icon by the time this
  // fires — including sites that declare it in HTML rather than serving
  // /favicon.ico — so this is both the most accurate source and free.
  // icons can be empty (a page with no favicon at all); [0] is Chromium's
  // own preferred candidate. The Array.isArray guard is not paranoia about
  // Chromium: this is an untyped IPC payload, and `[0]` on a *string*
  // silently yields one character — an "icon url" of "h" that fails to
  // fetch and records a week-long miss against the origin, suppressing the
  // real icon for that whole week.
  on("page-favicon-updated", ((_event: unknown, icons: unknown) => {
    if (!Array.isArray(icons)) return;
    const iconUrl: unknown = icons[0];
    if (typeof iconUrl !== "string" || iconUrl === "") return;
    emit({ kind: "favicon", pageUrl: contents.getURL(), iconUrl, session: contents.session });
  }) as (...args: never[]) => void);

  on("media-started-playing", (() => {
    emit({ kind: "media", playing: true });
  }) as (...args: never[]) => void);

  // media-paused covers ending as well as pausing: Chromium fires it when
  // playback stops for any reason.
  on("media-paused", (() => {
    emit({ kind: "media", playing: false });
  }) as (...args: never[]) => void);

  on("did-start-loading", (() => {
    emit({ kind: "loading", loading: true });
  }) as (...args: never[]) => void);

  on("did-stop-loading", (() => {
    emit({ kind: "loading", loading: false });
  }) as (...args: never[]) => void);

  on("did-navigate", ((_event: unknown, url: string) => {
    navigated(url);
  }) as (...args: never[]) => void);

  on("did-navigate-in-page", ((_event: unknown, url: string, isMainFrame: boolean) => {
    if (isMainFrame) navigated(url);
  }) as (...args: never[]) => void);

  on("did-fail-load", ((
    _event: unknown,
    errorCode: number,
    errorDescription: string,
    _validatedURL: string,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return;
    emit({ kind: "failed", detail: errorDescription });
  }) as (...args: never[]) => void);

  guardPopups(contents, emit, popups);
}

/**
 * What a page's popup window gets: the same navigation gate as the page,
 * and the same popup decision for any popup it opens in turn. Nothing else
 * is bridged — its title and loading state belong to no tab.
 */
export function bridgePopupWindow(
  contents: PopupContentsLike,
  emit: (event: HostedViewEvent) => void,
  popups: PopupPolicy,
): void {
  guardPopups(contents, emit, popups);
}

function guardPopups(
  contents: PopupContentsLike,
  emit: (event: HostedViewEvent) => void,
  popups: PopupPolicy | undefined,
): void {
  // The third way a non-web scheme could be reached: not the address bar,
  // not TabHost.open, but the page navigating itself. isSafeHref is the
  // shared vocabulary; the explicit https? test is the decision, because
  // isSafeHref deliberately accepts relative and in-page links, which are
  // legitimate in a document but are not what arrives here.
  contents.on("will-navigate", ((event: { preventDefault(): void }, url: string) => {
    const target = url.trim();
    if (isSafeHref(target) && /^https?:/i.test(target)) return;
    event.preventDefault();
  }) as (...args: never[]) => void);

  contents.setWindowOpenHandler(({ url, disposition }) => {
    // A real window only for what asked to be one. A sign-in or a Meet
    // window has to stay a window: it reports back through window.opener,
    // and a tab has none. target=_blank asked for a tab and gets one.
    //
    // about:blank because the common sign-in pattern opens an empty window
    // first and navigates it afterwards — and that navigation then meets
    // will-navigate's gate like any other.
    if (
      popups?.allow() === true &&
      disposition === "new-window" &&
      (/^https?:/i.test(url.trim()) || url === "about:blank")
    ) {
      return popups.windowOptions === undefined
        ? { action: "allow" }
        : { action: "allow", overrideBrowserWindowOptions: popups.windowOptions };
    }
    emit({ kind: "popup", url });
    return { action: "deny" };
  });
}

/**
 * The user agent a hosted page should see: Electron's own, minus the
 * `Electron/<version>` product token.
 *
 * Hosted pages are ordinary web apps, and several of them sniff that token
 * to decide they are running as *their* desktop build rather than in a
 * browser. Headlamp is the one that broke: its frontend treats a UA
 * containing "Electron" as proof it is the Headlamp desktop app and sends
 * every API request to a hardcoded `http://localhost:4466` instead of the
 * origin it was served from. Jarvis starts headlamp-server on a free port,
 * so nothing answers there, the fetch throws, and the page reports the
 * cluster as "Unreachable" even though the server behind the tab is healthy.
 *
 * Dropping the token is honest — this is Chromium, and every other product
 * token stays — and it is the same trick Electron's own docs suggest for
 * embedding third-party sites.
 */
export function hostedUserAgent(electronUserAgent: string): string {
  return electronUserAgent.replace(/\s*Electron\/\S+/, "");
}
