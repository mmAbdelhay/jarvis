// The second package entry — everything that touches the network, the
// filesystem for real, or third-party TLS/cert code. `@jarvis/remote`'s
// main entry (index.ts) never reaches any of this, so importing the
// package alone can never open a port; only `desktop/src/main.ts` imports
// from `@jarvis/remote/listen`.
export { listenTls } from "./server.js";
export { loadCertificate, type CertificateDeps } from "./certificate.js";
export { nodeFs, nodeTimers } from "./node-io.js";
export { createSidecarProxy } from "./proxy.js";
