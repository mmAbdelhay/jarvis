import Constants from "expo-constants";

export function installedVersion(): string {
  // Standalone builds always embed expoConfig, so the fallback is safe for other environments.
  return Constants.expoConfig?.version ?? "0.0.0";
}
