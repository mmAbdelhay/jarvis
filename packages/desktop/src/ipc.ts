import type { Session, SystemMetrics, Turn } from "@jarvis/core";

export type IpcChannels = {
  "metrics:update": SystemMetrics;
  "sessions:update": Session[];
  "turn:new": Turn;
};

export type RendererApi = {
  send(text: string): Promise<void>;
  onMetrics(cb: (m: SystemMetrics) => void): void;
  onSessions(cb: (s: Session[]) => void): void;
  onTurn(cb: (t: Turn) => void): void;
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
