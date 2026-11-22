// Read once at startup: is this page the desktop app's machine view
// (machine-view.ts)? Only the browser build reads the user agent.
import { Platform } from "react-native";
import { machineViewFor } from "./machine-view";

export const IN_MACHINE_VIEW: boolean = machineViewFor(
  Platform.OS,
  (globalThis as { navigator?: { userAgent?: unknown } }).navigator?.userAgent,
);
