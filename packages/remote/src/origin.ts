// The Origin rule for `/rpc` and `/pair` upgrades (plan conflict 4): no
// Origin (a non-browser client), exactly the native app's fixed Origin, or
// exactly the web client's origin while the web gate has one configured.
// Everything else is refused — above all the bridge's own origin, where
// sidecar pages run. Comparison is exact: no case folding, no trailing
// slash, and a repeated header (an array) never passes.
import { NATIVE_ORIGIN } from "@jarvis/wire";

export function originAllowed(
  header: string | string[] | undefined,
  webOrigin: string | undefined,
): boolean {
  if (header === undefined) return true;
  if (typeof header !== "string") return false;
  return header === NATIVE_ORIGIN || (webOrigin !== undefined && header === webOrigin);
}
