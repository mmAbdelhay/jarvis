// The remote bridge's transport. This entry point is pure: address
// classification, the wire protocol, their shared types, and the bridge
// lifecycle itself (which never opens a socket on its own — it only ever
// calls the `listen`/`loadCertificate` it is handed). server.ts,
// certificate.ts, node-io.ts and probe-client.ts (M4+) are unreachable from
// here by value import; desktop/src/main.ts reaches them through
// `@jarvis/remote/listen` instead, so requiring `@jarvis/remote` alone can
// never open a port.
export * from "./address.js";
export { createBridge, IDLE_DISABLE_MAX_MINUTES } from "./bridge.js";
export type {
  Bridge,
  BridgeConfig,
  BridgeDeps,
  Listen,
  ListenOptions,
  Listener,
  PairingResult,
  RemoteDeviceStatus,
  RemoteIdleStatus,
  RemotePairingStatus,
  RemoteProblem,
  RemoteStatus,
} from "./bridge.js";
// `createConnection` itself was previously reachable only transitively
// (bridge.ts -> hub.ts -> connection.ts, already inside this file's own
// reachability graph below) but never re-exported directly — every other
// top-level factory here (createBridge, createOutbox, createSidecarRegistry)
// is. M8 Task 9's desktop integration test needs the real connection state
// machine over an injected socket double, the same way connection.test.ts
// drives it inside this package, so it is named here too.
export {
  AUDIT_INPUT_KEYS_PER_CONNECTION,
  AUDIT_KEY_MAX_CHARS,
  AUDIT_PROBE_LINES_PER_CONNECTION,
  createConnection,
} from "./connection.js";
export type {
  AuditPolicy,
  AuthenticatedDevice,
  AuthorizeKey,
  Connection,
  ConnectionDeps,
  ErrorText,
  RequestHandler,
  RequestOutcome,
} from "./connection.js";
export type { CertificateConfig, CertificateMaterial } from "./certificate.js";
export type { DevicePush, DeviceSummary } from "./devices.js";
export * from "./interfaces.js";
export type { Clock, RandomBytes, RemoteFs, SocketLike, Timers } from "./io.js";
export { createOutbox, OUTBOX_TICK_MS } from "./outbox.js";
export type { Outbox, OutboxDeps } from "./outbox.js";
export {
  buildExpoRequests,
  createPushSender,
  EXPO_PUSH_BATCH,
  EXPO_PUSH_URL,
  EXPO_RECEIPTS_BATCH,
  EXPO_RECEIPTS_URL,
  MAX_PUSHES_PER_TOKEN_PER_MINUTE,
  PUSH_FLUSH_MS,
  PUSH_QUEUE_MAX,
  PUSH_REQUEST_TIMEOUT_MS,
  PUSH_RETRY_DELAYS_MS,
  PUSH_TTL_SECONDS,
  RECEIPT_DELAY_MS,
  parseExpoReceipts,
  parseExpoTickets,
  sendExpoPush,
} from "./push.js";
export type {
  ExpoPushMessage,
  ExpoReceipt,
  ExpoTicket,
  FetchLike,
  PushSender,
  PushSenderDeps,
  SendOutcome,
} from "./push.js";
export {
  dropHead,
  isKeyedPolicy,
  isSubscriptionKey,
  MAX_KEYED_SUBSCRIPTIONS,
  STREAM_MAX_BYTES,
  SUBSCRIPTION_KEY_PATTERN,
  utf8Bytes,
} from "./policy.js";
export type {
  ChannelPolicies,
  ChannelPolicy,
  LatestPolicy,
  ReliablePolicy,
  StreamPolicy,
} from "./policy.js";
export * from "./protocol.js";
export {
  cookieFor,
  parseProxyPath,
  requestHeaders,
  responseHeaders,
  setCookieHeader,
  takeKey,
} from "./proxy-rewrite.js";
export type { Headers } from "./proxy-rewrite.js";
// Type-only: `proxy.ts` itself (node:http/node:net) stays unreachable from
// this main entry — a type import carries nothing into compiled output, so
// this is what lets BridgeDeps.createProxy be typed here without pulling a
// listener in (same rule server.ts/listen.ts already follow).
export type { SidecarProxy, SidecarProxyDeps } from "./proxy.js";
export {
  COOKIE_PATTERN,
  createSidecarRegistry,
  HANDLE_MAX_AGE_MS,
  HANDLE_PATTERN,
  KEY_PATTERN,
  KEY_TTL_MS,
  MAX_HANDLES_PER_DEVICE,
} from "./sidecar-registry.js";
export type {
  PublishedSidecar,
  ResolvedSidecar,
  SidecarKind,
  SidecarRegistry,
  SidecarTarget,
} from "./sidecar-registry.js";
