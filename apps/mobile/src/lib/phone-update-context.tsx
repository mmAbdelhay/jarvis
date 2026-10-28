// Hands the app's one phone-update store (built once in `_layout.tsx`)
// to Settings and Home, and starts it for the app's lifetime. Mirrors
// voice-context.tsx: a context plus hooks, no decisions of its own.
import { createContext, useContext, useEffect, useState } from "react";
import type React from "react";
import type { PhoneUpdateStore, PhoneUpdateView } from "./phone-update-types";

const PhoneUpdateContext = createContext<PhoneUpdateStore | undefined>(undefined);

export function PhoneUpdateProvider(props: {
  store: PhoneUpdateStore;
  children: React.ReactNode;
}): React.JSX.Element {
  const { store } = props;
  useEffect(() => {
    store.start();
    return () => {
      store.stop();
    };
  }, [store]);
  return <PhoneUpdateContext.Provider value={store}>{props.children}</PhoneUpdateContext.Provider>;
}

export function usePhoneUpdateStore(): PhoneUpdateStore {
  const value = useContext(PhoneUpdateContext);
  if (value === undefined) {
    throw new Error("usePhoneUpdateStore() called outside PhoneUpdateProvider");
  }
  return value;
}

/** One value picked from the store's view, kept live. Re-renders only when
 *  the picked value changes (Object.is), so Home's banner does not re-render
 *  on every download percent. `select` must be stable (useCallback). */
export function usePhoneUpdateSelect<T>(select: (view: PhoneUpdateView) => T): T {
  const store = usePhoneUpdateStore();
  const [value, setValue] = useState<T>(() => select(store.get()));
  useEffect(() => {
    setValue(() => select(store.get()));
    return store.subscribe((view) => setValue(() => select(view)));
  }, [store, select]);
  return value;
}

/** The store's current view, kept live. */
export function usePhoneUpdate(): PhoneUpdateView {
  const store = usePhoneUpdateStore();
  const [view, setView] = useState<PhoneUpdateView>(store.get());
  useEffect(() => {
    setView(store.get());
    return store.subscribe(setView);
  }, [store]);
  return view;
}
