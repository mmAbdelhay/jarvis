// The one address canonicaliser the remote bridge trusts, re-exported from
// @jarvis/wire (M6 ruling 5): the pure implementation now lives there so
// the phone app (React Native, no `node:net`) can share it. `bindChoices`
// (interfaces.ts) classifies a *local* interface address; this module
// answers a different question — "is this string the one canonical
// spelling of an IP literal?" — for addresses that arrive from outside: a
// config's `bindAddress`, a socket's remote address, a pairing link's
// `host`. Both the pairing-link check and the connection-source check must
// agree on what "the same address" means, so there is exactly one
// normaliser and everything else calls it rather than comparing strings
// directly.
export { canonicalAddress, isUnspecifiedAddress } from "@jarvis/wire";
