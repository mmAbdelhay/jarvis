// Machine views: another Jarvis machine on the tailnet, opened full-window
// inside this one. Each is a WebContentsView loading that machine's own web
// client from `https://<name>:<webPort>`, in a partition of its own so its
// sign-in is kept apart from every project's and from every other machine's.
//
// The page is the other machine's, so it is treated as untrusted here: no
// preload, a sandbox, its own origin and nothing else (a link away opens in
// the system browser), no popups, no certificate override, and of every
// permission only that origin's microphone — voice is the one feature the
// web client needs a device for.
//
// Deliberately apart from ViewReconciler: that one suspends idle tabs, and a
// machine view is kept alive while hidden so switching back is instant.
// No electron here: main.ts injects the view constructor and the session
// lookup, so the rules are tested without Electron.
import { isSafeHref } from "@jarvis/core";
import { hostedUserAgent, type Rect } from "./browser-host.js";

export type MachineTarget = { name: string; webPort: number; v: number };

export type MachineViewState = {
  name: string;
  phase: "loading" | "ready" | "offline" | "certificate" | "version";
};

export type MachineViewOptions = {
  webPreferences: {
    partition: string;
    contextIsolation: true;
    nodeIntegration: false;
    sandbox: true;
  };
};

type NavigationEvent = { preventDefault(): void };
type FrameNavigationEvent = NavigationEvent & { url: string; isMainFrame: boolean };

/** What a permission request carries (Electron's PermissionRequest and
 *  MediaAccessPermissionRequest, the fields read here). */
export type MachinePermissionRequestDetails = {
  requestingUrl?: string;
  securityOrigin?: string;
  mediaTypes?: ("video" | "audio")[];
};

/** What a permission check carries (Electron's
 *  PermissionCheckHandlerHandlerDetails, the fields read here). */
export type MachinePermissionCheckDetails = {
  requestingUrl?: string;
  securityOrigin?: string;
  mediaType?: "video" | "audio" | "unknown";
};

export type MachineSessionLike = {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: MachinePermissionRequestDetails,
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      webContents: unknown,
      permission: string,
      requestingOrigin: string,
      details: MachinePermissionCheckDetails,
    ) => boolean,
  ): void;
  setUserAgent(userAgent: string): void;
};

export type MachineContentsLike = {
  readonly session: MachineSessionLike;
  on(event: "will-navigate", listener: (event: NavigationEvent, url: string) => void): void;
  on(
    event: "will-redirect" | "will-frame-navigate",
    listener: (details: FrameNavigationEvent) => void,
  ): void;
  on(event: "did-finish-load", listener: () => void): void;
  on(
    event: "did-fail-load",
    listener: (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => void,
  ): void;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
  loadURL(url: string): Promise<void>;
  getUserAgent(): string;
  setUserAgent(userAgent: string): void;
};

/** A constructed view, already a child of the window. */
export type MachineViewHandle = {
  readonly webContents: MachineContentsLike;
  setVisible(visible: boolean): void;
  setBounds(rect: Rect): void;
  /** Removes it from the window and closes its page. */
  destroy(): void;
};

export type MachineViewsDeps = {
  createView(options: MachineViewOptions): MachineViewHandle;
  session(partition: string): MachineSessionLike;
  protocolVersion: number;
  /** The system browser. Called only with an https URL. */
  openExternal(url: string): void;
  /** The clock, in ms; Date.now unless a test supplies one. */
  now?: () => number;
};

export type MachineViews = {
  show(target: MachineTarget): void;
  showLocal(): void;
  setBounds(rect: Rect): void;
  close(name: string): void;
  onState(listener: (state: MachineViewState) => void): () => void;
};

export const MACHINE_VIEW_USER_AGENT_TOKEN = "JarvisMachineView/1";

const DNS_NAME = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;
const MAX_DNS_NAME = 253;
const MAX_EXTERNAL_URL = 2048;
/** A machine page may open the system browser once per this long. */
const EXTERNAL_OPEN_GAP_MS = 1000;
const ERR_ABORTED = -3;

/** Chromium's net errors -200 to -299 are the certificate errors. */
function isCertificateError(code: number): boolean {
  return code <= -200 && code >= -299;
}

export function isMachineTarget(value: unknown): value is MachineTarget {
  if (typeof value !== "object" || value === null) return false;
  const { name, webPort, v } = value as Record<string, unknown>;
  return (
    typeof name === "string" &&
    name.length <= MAX_DNS_NAME &&
    DNS_NAME.test(name) &&
    typeof webPort === "number" &&
    Number.isInteger(webPort) &&
    webPort >= 1 &&
    webPort <= 65535 &&
    typeof v === "number"
  );
}

function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** An https URL the system browser may be handed. */
function isExternalUrl(url: string): boolean {
  const target = url.trim();
  if (target.length > MAX_EXTERNAL_URL || !isSafeHref(target)) return false;
  try {
    return new URL(target).protocol === "https:";
  } catch {
    return false;
  }
}

type Entry = {
  view: MachineViewHandle;
  origin: string;
  phase: MachineViewState["phase"];
};

export function createMachineViews(deps: MachineViewsDeps): MachineViews {
  const entries = new Map<string, Entry>();
  const listeners = new Set<(state: MachineViewState) => void>();
  const guardedSessions = new WeakSet<MachineSessionLike>();
  let bounds: Rect | undefined;

  const emit = (state: MachineViewState): void => {
    for (const listener of [...listeners]) listener(state);
  };
  const setPhase = (name: string, phase: MachineViewState["phase"]): void => {
    const entry = entries.get(name);
    if (entry !== undefined) entry.phase = phase;
    emit({ name, phase });
  };
  const now = deps.now ?? Date.now;
  /** The machine the user chose to see. Its native view paints over the
   *  renderer's loading/failure overlay, so it is made visible only while
   *  this one is `ready`. */
  let shown: string | undefined;
  const hideAll = (): void => {
    for (const entry of entries.values()) entry.view.setVisible(false);
  };
  const syncVisible = (name: string): void => {
    const entry = entries.get(name);
    if (entry === undefined) return;
    entry.view.setVisible(shown === name && entry.phase === "ready");
  };

  /** The permission rule, read against the machine's current origin. */
  const guardSession = (session: MachineSessionLike, name: string): void => {
    if (guardedSessions.has(session)) return;
    guardedSessions.add(session);
    const isOwn = (origins: (string | undefined)[]): boolean => {
      const own = entries.get(name)?.origin;
      const present = origins.filter((origin) => origin !== undefined);
      return own !== undefined && present.length > 0 && present.every((origin) => origin === own);
    };
    session.setPermissionRequestHandler((_contents, permission, callback, details) => {
      const types = details.mediaTypes ?? [];
      const own = isOwn([originOf(details.requestingUrl), originOf(details.securityOrigin)]);
      callback(
        (permission === "media" && types.includes("audio") && !types.includes("video") && own) ||
          // Copying out of the terminal; reading the clipboard stays denied.
          (permission === "clipboard-sanitized-write" && own),
      );
    });
    session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      const own = isOwn([
        originOf(requestingOrigin),
        originOf(details.requestingUrl),
        originOf(details.securityOrigin),
      ]);
      return (
        own &&
        ((permission === "media" && details.mediaType === "audio") ||
          permission === "clipboard-sanitized-write")
      );
    });
  };

  const create = (name: string, origin: string): Entry => {
    const partition = `persist:machine:${name}`;
    const view = deps.createView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // No preload: nothing of Jarvis is exposed to another machine's page.
      },
    });
    const entry: Entry = { view, origin, phase: "loading" };
    entries.set(name, entry);

    const contents = view.webContents;
    const session = deps.session(partition);
    guardSession(session, name);
    const agent = `${hostedUserAgent(contents.getUserAgent())} ${MACHINE_VIEW_USER_AGENT_TOKEN}`;
    contents.setUserAgent(agent);
    session.setUserAgent(agent);

    let lastOpenAt: number | undefined;
    const openOutside = (url: string): void => {
      if (!isExternalUrl(url)) return;
      const at = now();
      if (lastOpenAt !== undefined && at - lastOpenAt < EXTERNAL_OPEN_GAP_MS) return;
      lastOpenAt = at;
      deps.openExternal(url.trim());
    };
    const isOwnOrigin = (url: string): boolean => originOf(url) === entry.origin;
    contents.on("will-navigate", (event, url) => {
      if (isOwnOrigin(url)) return;
      event.preventDefault();
      openOutside(url);
    });
    contents.on("will-redirect", (details) => {
      if (isOwnOrigin(details.url)) return;
      details.preventDefault();
      if (details.isMainFrame) openOutside(details.url);
    });
    // Fires for the main frame too, after will-navigate has already opened
    // it outside; so this one only prevents.
    contents.on("will-frame-navigate", (details) => {
      if (isOwnOrigin(details.url)) return;
      details.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      openOutside(url);
      return { action: "deny" };
    });
    contents.on("did-finish-load", () => {
      setPhase(name, "ready");
      syncVisible(name);
    });
    contents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === ERR_ABORTED) return;
      setPhase(name, isCertificateError(errorCode) ? "certificate" : "offline");
      syncVisible(name);
    });

    if (bounds !== undefined) view.setBounds(bounds);
    emit({ name, phase: "loading" });
    // A failure arrives on did-fail-load; the rejection carries nothing more.
    contents.loadURL(`${origin}/`).catch(() => {});
    return entry;
  };

  const close = (name: string): void => {
    const entry = entries.get(name);
    if (entry === undefined) return;
    entries.delete(name);
    if (shown === name) shown = undefined;
    entry.view.destroy();
  };

  return {
    show(target) {
      if (!isMachineTarget(target)) return;
      const name = target.name.toLowerCase();
      hideAll();
      shown = undefined;
      if (target.v !== deps.protocolVersion) {
        emit({ name, phase: "version" });
        return;
      }
      const origin = new URL(`https://${name}:${target.webPort}`).origin;
      let entry = entries.get(name);
      if (entry !== undefined && entry.origin !== origin) {
        close(name);
        entry = undefined;
      }
      if (entry === undefined) {
        entry = create(name, origin);
      } else if (entry.phase === "offline" || entry.phase === "certificate") {
        // Choosing a failed machine again is the retry.
        entry.phase = "loading";
        emit({ name, phase: "loading" });
        entry.view.webContents.loadURL(`${origin}/`).catch(() => {});
      } else {
        emit({ name, phase: entry.phase });
      }
      shown = name;
      if (bounds !== undefined) entry.view.setBounds(bounds);
      syncVisible(name);
    },
    showLocal() {
      shown = undefined;
      hideAll();
    },
    setBounds(rect) {
      bounds = rect;
      for (const entry of entries.values()) entry.view.setBounds(rect);
    },
    close(name) {
      if (typeof name === "string") close(name.toLowerCase());
    },
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
