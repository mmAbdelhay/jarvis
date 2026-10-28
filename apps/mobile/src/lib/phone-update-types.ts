// The phone updater's state and store, as the UI sees them. The store
// itself (checks, download, verify, install) is phone-update-store.ts; this
// file only names its shape, so the UI can be built and tested against it.

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current"; checkedAt: number }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; version: string; progress: number }
  | { kind: "verifying"; version: string }
  | { kind: "ready"; version: string }
  | {
      kind: "failed";
      reason: "offline" | "download" | "checksum" | "install";
      version?: string;
    };

export type PhoneUpdateView = {
  state: UpdateState;
  /** The installed app's version. */
  current: string;
  /** Only Android can download and install an update. */
  canInstall: boolean;
  /** False on web: the bridge's CSP blocks api.github.com, so the browser
   *  build never checks and shows the version only. */
  canCheck: boolean;
  /** When a check last succeeded; kept through every later state. */
  lastCheckedAt: number | undefined;
};

export type PhoneUpdateStore = {
  get(): PhoneUpdateView;
  /** Returns the unsubscribe. */
  subscribe(fn: (view: PhoneUpdateView) => void): () => void;
  check(): Promise<void>;
  update(): Promise<void>;
  start(): void;
  stop(): void;
};
