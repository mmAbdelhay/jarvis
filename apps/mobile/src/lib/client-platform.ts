// Which build this is — the native app or the browser build (Task 13) —
// decided once from `Platform.OS`, which the caller passes in (platform is
// always a parameter, never read here), so every rule that differs by
// platform is a pure, tested function of this value.

export type ClientPlatform = "native" | "web";

export function clientPlatformFor(os: string): ClientPlatform {
  return os === "web" ? "web" : "native";
}

/** The `client` string sent in the `hello` and `pair` frames: exactly
 * `"web"` for the browser build (the server labels web devices by it),
 * `jarvis-mobile/<version>/<os>` for the native app, unchanged. */
export function clientStringFor(os: string, version: string): string {
  if (clientPlatformFor(os) === "web") return "web";
  return `jarvis-mobile/${version}/${os}`;
}
