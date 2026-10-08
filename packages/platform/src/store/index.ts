// @jarvis/platform/store: jarvisd's SQLite-backed pieces (node:sqlite, built
// into Node 24 — no native module). Kept out of @jarvis/platform/model so
// that subpath stays sqlite-free (os-bundle-graph.test.ts).
export * from "./vector-cache.js";
export * from "./ollama-embedder.js";
