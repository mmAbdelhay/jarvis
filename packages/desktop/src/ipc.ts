import type { Session, SystemMetrics, Turn } from "@jarvis/core";

export type VoiceNotice = { text: string; language: "ar" | "en" };

export type IpcChannels = {
  "metrics:update": SystemMetrics;
  "sessions:update": Session[];
  "turn:new": Turn;
  "voice:listening": boolean;
  "voice:notice": VoiceNotice;
};

export type RendererApi = {
  send(text: string, language: "ar" | "en"): Promise<void>;
  // Drives the exact same start/stop path as the Alt+Space / Alt+Shift+Space
  // global hotkey — the renderer's mic button is a second control on one
  // voice implementation, not a separate click-to-talk feature.
  startVoice(): Promise<void>;
  stopVoice(): Promise<void>;
  onMetrics(cb: (m: SystemMetrics) => void): void;
  onSessions(cb: (s: Session[]) => void): void;
  onTurn(cb: (t: Turn) => void): void;
  onListening(cb: (listening: boolean) => void): void;
  // A transient status, distinct from a turn: e.g. "recorded but heard
  // nothing" — shown briefly in the voice-state element, never added to
  // the conversation as a hollow turn.
  onNotice(cb: (notice: VoiceNotice) => void): void;
  // Session history is pulled on demand (when the history panel opens),
  // not pushed like sessions:update — there is no live subscriber to keep
  // in sync, only a snapshot to render once.
  getHistory(): Promise<Session[]>;
};

export type WiringDeps = {
  send(channel: string, payload: unknown): void;
  readMetrics(): Promise<SystemMetrics>;
  intervalMs: number;
  onSessionsChange(cb: (sessions: Session[]) => void): () => void;
  onTurn(cb: (turn: Turn) => void): () => void;
};

export function buildWiring(deps: WiringDeps): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  const unsubscribes: (() => void)[] = [];

  return {
    start() {
      unsubscribes.push(deps.onSessionsChange((s) => deps.send("sessions:update", s)));
      unsubscribes.push(deps.onTurn((t) => deps.send("turn:new", t)));

      timer = setInterval(() => {
        deps.readMetrics()
          .then((metrics) => deps.send("metrics:update", metrics))
          .catch(() => {
            // A failed sample is skipped; the next tick tries again.
          });
      }, deps.intervalMs);
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      while (unsubscribes.length > 0) unsubscribes.pop()?.();
    },
  };
}
