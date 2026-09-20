// M12 Task 5 (task-5-brief.md, "Interfaces"): the pure classifier behind
// `_layout.tsx`'s one `AppState` listener. `RpcClient.setAppActive` (Task
// 5's own change to rpc-client.ts) only ever hears "activate" or
// "suspend" — this is the one place that decides which raw
// `AppStateStatus` values mean which, so the mapping is unit-tested once
// instead of re-derived at the call site.
//
// The mapping below is per task-5-brief Rule 1, not a repeat of M8 final
// review's own ruling ("iOS `AppState` 'inactive' is treated as
// background") — that call was specific to a live recording (stopping
// early loses nothing — Retry is offered), where "broader than
// background" was the safer default there. Dropping every subscription on
// a transient `inactive` blip (a notification-shade pull, an
// incoming-call banner) would flap the socket's watching set far more
// than a recording's own start/stop, for no laptop-side benefit — so
// `inactive`, like `unknown` and `extension`, maps to `"none"` here and
// leaves the client's suspended flag exactly as it was.
import type { AppStateStatus } from "react-native";

export type AppActivity = "activate" | "suspend" | "none";

export function appActivityFor(next: AppStateStatus): AppActivity {
  if (next === "active") return "activate";
  if (next === "background") return "suspend";
  return "none";
}
