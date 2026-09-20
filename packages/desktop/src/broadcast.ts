import type { PushChannels } from "./channels.js";

export type PushSink = (channel: string, payload: unknown) => void;

export type BroadcasterDeps = {
  /** Where this window's renderer receives pushes. Expected to swallow a
   *  destroyed window rather than throw, but the broadcaster guards anyway:
   *  a throw here must not stop the other sinks. */
  toRenderer: PushSink;
};

export type Broadcaster = {
  /** To the renderer and every added sink. */
  send<C extends keyof PushChannels>(channel: C, payload: PushChannels[C]): void;
  /** To the renderer only. For events about *this window* — the first-run
   *  installer's output, the DevTools dock — which another client has no
   *  panel for and no use for. */
  local<C extends keyof PushChannels>(channel: C, payload: PushChannels[C]): void;
  /** Adds a destination for `send`. Returns its removal. */
  addSink(sink: PushSink): () => void;
};

/** The renderer as a sink. The one place in the app that calls
 *  webContents.send, which is what no-direct-send.test.ts enforces. The
 *  isDestroyed guard lives here so no call site has to remember it. */
export function rendererSink(window: {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
}): PushSink {
  return (channel, payload) => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  };
}

/**
 * The only place in the app that talks to the renderer's push channels.
 *
 * It exists so that adding a second client is one `addSink` call rather than
 * an edit to two dozen call sites — and no-direct-send.test.ts keeps it that
 * way by forbidding `webContents.send` anywhere but this file.
 *
 * Every delivery is guarded individually. A sink is a socket write, which can
 * fail for reasons that have nothing to do with the other destinations; one
 * dead client silencing the renderer would be a worse bug than the one this
 * file was written to prevent.
 */
export function createBroadcaster(deps: BroadcasterDeps): Broadcaster {
  const sinks = new Set<PushSink>();

  function deliver(sink: PushSink, channel: string, payload: unknown): void {
    try {
      sink(channel, payload);
    } catch (error) {
      console.error(
        `Push to ${channel} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    send(channel, payload) {
      deliver(deps.toRenderer, channel, payload);
      // Copied: a sink may remove itself from inside its own call.
      for (const sink of [...sinks]) deliver(sink, channel, payload);
    },

    local(channel, payload) {
      deliver(deps.toRenderer, channel, payload);
    },

    addSink(sink) {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
  };
}
