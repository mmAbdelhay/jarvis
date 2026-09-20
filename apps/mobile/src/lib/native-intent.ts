// The pure decision behind `app/+native-intent.tsx` (fix round 2 —
// Important 2; earlier context: final review I1/I2, fix round 1). Expo
// Router calls this for every incoming *system* path — cold start and
// warm start alike, arriving from outside the app (Safari, another app, a
// notification) — before it ever becomes a route or route params. It is
// never on the path the app takes to navigate itself: every
// `router.push`/`router.replace` call in this app (dashboard.tsx,
// sessions.tsx, settings.tsx, pair.tsx, _layout.tsx) goes straight to
// Expo Router's own navigator and never reaches this function.
//
// Fix round 1 tried to enumerate every spelling a system path could take
// to resolve to `session`/`sessions` (scheme case, slash count, a dev
// `--/` tunnel...) and kept finding another one: the round 2 re-review
// traced expo-router's own resolution pipeline (`fromDeepLink` → `new
// URL(p, "file:")` → its route regex) and found eight more bypasses —
// a backslash in place of a slash, `../`/`.` path segments, a leading
// space, an embedded tab, the Expo dev-client's own `?url=` unwrap (not
// gated to dev builds), and a plain `https://` universal link. None of
// those can be closed by adding another deny-list row, because the
// router's own path parser is not this file's to reimplement.
//
// So this is an allow-list, not a deny-list. The *only* system path this
// function ever recognises is the exact pairing-link form the existing
// pairing rule already accepts (`jarvis://pair?...`) — and even that form
// is never passed through unchanged: its secret-bearing query string is
// stashed off to the one-shot holder and the path becomes the bare
// `/pair`. Every other system path — whatever its spelling, however the
// router would otherwise resolve it — becomes the same safe default the
// old deny-list already used for a refusal: the bare root `/`. A forged
// or malformed system path can therefore never reach Expo Router's params
// for any route.
import { stashPairingLink } from "./pairing-link-holder";

const PAIRING_LINK_PREFIX = "jarvis://pair?";

export function redirectSystemPath(path: string): string {
  if (path.startsWith(PAIRING_LINK_PREFIX)) {
    stashPairingLink(path);
    return "/pair";
  }
  return "/";
}
