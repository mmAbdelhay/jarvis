// Hands the one `MachineSessions` `_layout.tsx` builds down to whichever screen
// needs it. It sits above the keyed tree, so it survives a switch. Mirrors
// language-context.tsx's shape: a plain context plus a hook, no logic of its
// own.
import { createContext, useContext } from "react";
import type { MachineSessions } from "./machine-sessions";

export const MachinesContext = createContext<MachineSessions | undefined>(undefined);

export function useMachineSessions(): MachineSessions {
  const value = useContext(MachinesContext);
  if (value === undefined) {
    throw new Error("useMachineSessions() called outside MachinesContext.Provider");
  }
  return value;
}
