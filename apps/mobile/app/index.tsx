import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { loadPairing } from "@/lib/pairing-record";
import { expoSecureStore } from "@/lib/secure-store";

type Target = "/pair" | "/dashboard";

// The real check Task 5 replaces the always-"/pair" placeholder with: a
// stored pairing record (with its matching token) routes straight to the
// Dashboard; anything else — nothing stored, or an unusable record —
// routes to pairing.
export default function Index() {
  const [target, setTarget] = useState<Target | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let loaded: Awaited<ReturnType<typeof loadPairing>>;
      try {
        loaded = await loadPairing(expoSecureStore);
      } catch {
        // I5: a secure-store read failure is treated as "not paired" rather
        // than leaving the app on a blank screen forever. Logged without
        // any secret — just the fact that the read failed.
        console.warn("index: loadPairing failed, routing to /pair");
        loaded = undefined;
      }
      if (!cancelled) {
        setTarget(loaded === undefined ? "/pair" : "/dashboard");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (target === null) {
    return null;
  }

  return <Redirect href={target} />;
}
