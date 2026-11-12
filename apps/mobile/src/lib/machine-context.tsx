// Hands the one `MachineSessions` `_layout.tsx` builds down to whichever screen
// needs it. It sits above the keyed tree, so it survives a switch. Mirrors
// language-context.tsx's shape: a plain context plus a hook, no logic of its
// own.
import { createContext, useContext } from "react";
import type { MachineSessions } from "./machine-sessions";
import type { NavigatorGate } from "./scope-routing";

export const MachinesContext = createContext<MachineSessions | undefined>(undefined);
export const NavigatorGateContext = createContext<NavigatorGate | undefined>(undefined);

export function useMachineSessions(): MachineSessions {
  const value = useContext(MachinesContext);
  if (value === undefined) {
    throw new Error("useMachineSessions() called outside MachinesContext.Provider");
  }
  return value;
}

/** For a route asked for on its own timing, from a screen. */
export function useNavigatorGate(): NavigatorGate {
  const value = useContext(NavigatorGateContext);
  if (value === undefined) {
    throw new Error("useNavigatorGate() called outside NavigatorGateContext.Provider");
  }
  return value;
}
