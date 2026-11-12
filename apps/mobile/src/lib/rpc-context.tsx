// Hands the current machine's scope (machine-sessions.ts) down to whichever
// screen needs it: its `RpcClient`, and the connection store and auth session
// built over it. `_layout.tsx` provides it under the keyed tree, so a screen
// only ever sees the scope it was mounted for. Mirrors language-context.tsx's
// shape: a plain context plus a hook, no logic of its own. `undefined` outside
// the provider is a programmer error — every screen is a descendant of
// RootLayout, which always provides a value before rendering the `Stack`.
import { createContext, useContext } from "react";
import type { AuthSession } from "./auth-session";
import type { ConnectionStore } from "./connection-store";
import type { MachineId } from "./machine-index";
import type { RpcClient } from "./rpc-client";

export type RpcContextValue = {
  /** The machine this scope belongs to; null when there is none. */
  machineId: MachineId | null;
  client: RpcClient;
  connectionStore: ConnectionStore;
  // Phase 0 owner login: this machine's auth session (unlock, idle lock).
  authSession: AuthSession;
  /** Connects again from the stored pairing (the banner's "Tap to retry"),
   *  routing to /pair when there is none. */
  reconnect(): Promise<void>;
};

export const RpcContext = createContext<RpcContextValue | undefined>(undefined);

export function useMachineId(): MachineId | null {
  const value = useContext(RpcContext);
  if (value === undefined) {
    throw new Error("useMachineId() called outside RpcContext.Provider");
  }
  return value.machineId;
}

export function useRpcClient(): RpcClient {
  const value = useContext(RpcContext);
  if (value === undefined) {
    throw new Error("useRpcClient() called outside RpcContext.Provider");
  }
  return value.client;
}

export function useConnectionStore(): ConnectionStore {
  const value = useContext(RpcContext);
  if (value === undefined) {
    throw new Error("useConnectionStore() called outside RpcContext.Provider");
  }
  return value.connectionStore;
}

export function useAuthSession(): AuthSession {
  const value = useContext(RpcContext);
  if (value === undefined) {
    throw new Error("useAuthSession() called outside RpcContext.Provider");
  }
  return value.authSession;
}

export function useReconnect(): () => Promise<void> {
  const value = useContext(RpcContext);
  if (value === undefined) {
    throw new Error("useReconnect() called outside RpcContext.Provider");
  }
  return value.reconnect;
}
