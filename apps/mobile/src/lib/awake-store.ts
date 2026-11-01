// Keep awake (Task 18): whether the laptop holds its screen and machine
// awake, from `awake:status` and the reliable `awake:changed` push, plus the
// one phone action — the dashboard toggle (`awake:set`). The shape lives in
// the desktop package, so it is mirrored here and rebuilt field by field
// from `unknown` (reviews-store.ts's discipline): a malformed value is
// dropped, never thrown on.
import type { MessageKey } from "./i18n";
import type { RpcClient } from "./rpc-client";

export type AwakeMode = "off" | "on" | "agents";
export type AwakeStatus = {
  mode: AwakeMode;
  active: boolean;
  reason: "off" | "on" | "agent-running" | "no-agent";
  simulateInput: boolean;
  inputState: "idle" | "ok" | "needs-permission" | "unsupported";
};

const MODES: readonly string[] = ["off", "on", "agents"];
const REASONS: readonly string[] = ["off", "on", "agent-running", "no-agent"];
const INPUT_STATES: readonly string[] = ["idle", "ok", "needs-permission", "unsupported"];

function oneOf<T extends string>(value: unknown, allowed: readonly string[]): value is T {
  return typeof value === "string" && allowed.includes(value);
}

export function parseAwakeStatus(value: unknown): AwakeStatus | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const { mode, active, reason, simulateInput, inputState } = raw;
  if (!oneOf<AwakeStatus["mode"]>(mode, MODES)) return undefined;
  if (typeof active !== "boolean") return undefined;
  if (!oneOf<AwakeStatus["reason"]>(reason, REASONS)) return undefined;
  if (typeof simulateInput !== "boolean") return undefined;
  if (!oneOf<AwakeStatus["inputState"]>(inputState, INPUT_STATES)) return undefined;
  return { mode, active, reason, simulateInput, inputState };
}

/** The hint line under the toggle. */
export function awakeHintKey(status: AwakeStatus): MessageKey {
  if (status.simulateInput && status.inputState === "needs-permission") {
    return "awake.hintPermission";
  }
  switch (status.reason) {
    case "off":
      return "awake.hintOff";
    case "on":
      return "awake.hintOn";
    case "agent-running":
      return "awake.hintAgent";
    case "no-agent":
      return "awake.hintNoAgent";
  }
}

export type AwakeState = { status?: AwakeStatus; busy: boolean; error: boolean };

export type AwakeStore = {
  state: AwakeState;
  load(): Promise<void>;
  /** Off → the last mode that was on ("on" when none was seen); on → off. */
  toggle(): Promise<void>;
  subscribe(cb: () => void): () => void;
};

export function createAwakeStore(deps: {
  client: Pick<RpcClient, "call" | "onPush" | "subscribe" | "unsubscribe">;
}): AwakeStore {
  const state: AwakeState = { busy: false, error: false };
  const listeners = new Set<() => void>();
  let lastOn: "on" | "agents" | undefined;
  let stopPush: (() => void) | undefined;

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  function take(value: unknown): boolean {
    const status = parseAwakeStatus(value);
    if (status === undefined) return false;
    state.status = status;
    if (status.mode !== "off") lastOn = status.mode;
    state.error = false;
    return true;
  }

  async function load(): Promise<void> {
    const result = await deps.client.call("awake:status", []);
    if (!result.ok || !take(result.value)) state.error = true;
    emit();
  }

  async function toggle(): Promise<void> {
    if (state.busy) return;
    const mode: AwakeMode =
      state.status?.mode === "off" || state.status === undefined ? (lastOn ?? "on") : "off";
    state.busy = true;
    emit();
    const result = await deps.client.call("awake:set", [{ mode }]);
    state.busy = false;
    if (!result.ok || !take(result.value)) state.error = true;
    emit();
  }

  function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    if (listeners.size === 1) {
      stopPush = deps.client.onPush("awake:changed", (payload) => {
        if (take(payload)) emit();
        else void load();
      });
      deps.client.subscribe("awake:changed");
    }
    return () => {
      listeners.delete(cb);
      if (listeners.size === 0) {
        stopPush?.();
        stopPush = undefined;
        deps.client.unsubscribe("awake:changed");
      }
    };
  }

  return { state, load, toggle, subscribe };
}
