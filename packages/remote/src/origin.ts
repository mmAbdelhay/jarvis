// The Origin rule for `/rpc` and `/pair` upgrades (plan conflict 4): no
// Origin (a non-browser client), exactly the native app's fixed Origin, or
// exactly the web client's origin while the web gate has one configured.
// Everything else is refused — above all the bridge's own origin, where
// sidecar pages run. Comparison is exact: no case folding, no trailing
// slash, and a repeated header (an array) never passes.
import { NATIVE_ORIGIN } from "@jarvis/wire";

/** Which allowed Origin an upgrade carried: none at all, the native app's, or the web client's. */
export type OriginClass = "none" | "native" | "web";

/** The upgrade's Origin class, or `undefined` when the Origin is refused. */
export function originClass(
  header: string | string[] | undefined,
  webOrigin: string | undefined,
): OriginClass | undefined {
  if (header === undefined) return "none";
  if (typeof header !== "string") return undefined;
  if (header === NATIVE_ORIGIN) return "native";
  if (webOrigin !== undefined && header === webOrigin) return "web";
  return undefined;
}

export function originAllowed(
  header: string | string[] | undefined,
  webOrigin: string | undefined,
): boolean {
  return originClass(header, webOrigin) !== undefined;
}
