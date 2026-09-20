// Where the Agent SDK's native `claude` binary really lives when Jarvis is
// packaged. The SDK (0.3.x) ships its CLI as a platform-specific optional
// dependency (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`) and
// resolves it relative to its own `sdk.mjs`. Inside the packaged app that
// resolution lands inside `app.asar`, and an asar entry cannot be executed:
// `spawn` fails with `ENOTDIR` before a byte reaches the model, so every
// capacity read came back "unavailable" and the brain could not start.
// electron-builder already unpacks the binary to `app.asar.unpacked/...`
// (it unpacks every executable it finds), but nothing tells the SDK so —
// this module does, through `options.pathToClaudeCodeExecutable`. In a
// plain checkout (`pnpm start`, tests) the mapping is a no-op and the SDK
// gets the same path it would have found on its own.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Pure: an `app.asar` path becomes its `app.asar.unpacked` twin; anything else is returned unchanged. */
export function unpackedPath(path: string): string {
  return path.replace(/([\\/])app\.asar(?=[\\/])/, "$1app.asar.unpacked");
}

/** The optional-dependency package the SDK looks for on this platform (the musl and android variants are not needed where Jarvis ships). */
export function nativeSdkPackage(platform: string, arch: string): string {
  return `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
}

/**
 * The absolute path to hand the SDK as `pathToClaudeCodeExecutable`, or
 * undefined when the native package cannot be resolved (then the SDK's own
 * resolution — and its own error message — apply unchanged).
 */
export function resolveClaudeExecutable(
  deps: {
    platform?: string;
    arch?: string;
    /** Resolves a module specifier from the SDK's own location; injected for tests. */
    resolve?: (specifier: string) => string;
  } = {},
): string | undefined {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const resolve = deps.resolve ?? defaultResolve;
  try {
    const manifest = resolve(`${nativeSdkPackage(platform, arch)}/package.json`);
    const binary = platform === "win32" ? "claude.exe" : "claude";
    return unpackedPath(join(dirname(manifest), binary));
  } catch {
    return undefined;
  }
}

function defaultResolve(specifier: string): string {
  // Resolved from the SDK's own entry point, not from this file: the native
  // package is the SDK's dependency, so under pnpm's strict layout it is
  // only reachable from there.
  const here = createRequire(import.meta.url);
  const sdkEntry = here.resolve("@anthropic-ai/claude-agent-sdk");
  return createRequire(sdkEntry).resolve(specifier);
}
