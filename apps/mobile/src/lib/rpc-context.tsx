// Hands the one `RpcClient` `_layout.tsx` builds at start, and the
// connection store built over it, down to whichever screen needs them
// (Task 6: "_layout.tsx ... provides the connection store through
// context"). Mirrors language-context.tsx's shape: a plain context plus a
// hook, no logic of its own. `undefined` outside the provider is a
// programmer error — every screen is a descendant of RootLayout, which
// always provides a value before rendering the `Stack`.
import { createContext, useContext } from "react";
import type { ConnectionStore } from "./connection-store";
import type { RpcClient } from "./rpc-client";

export type RpcContextValue = { client: RpcClient; connectionStore: ConnectionStore };

export const RpcContext = createContext<RpcContextValue | undefined>(undefined);

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
