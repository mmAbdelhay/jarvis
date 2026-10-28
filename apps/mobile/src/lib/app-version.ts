import Constants from "expo-constants";

export function installedVersion(): string {
  return Constants.expoConfig?.version ?? "0.0.0";
}
