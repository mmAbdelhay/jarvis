const { existsSync } = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { vendoredWebAsset } = require("./scripts/web-export-paths.cjs");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Monorepo: Metro must watch the whole workspace (so changes to
// packages/wire are picked up) and resolve modules from both this app's
// node_modules and the root's. Hierarchical lookup stays ON (Expo's
// monorepo default, and what expo-doctor checks): pnpm keeps a package's
// peers beside it under node_modules/.pnpm/<pkg>/node_modules, which only
// a walk up from the importing file can find — with it off, the first
// device bundle failed on expo-router → @expo/metro-runtime → @expo/log-box.
config.watchFolders = [repoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(repoRoot, "node_modules"),
];

// Web only: an image that resolves inside node_modules (expo-router's own
// icons) is served from its vendored copy in assets/web-vendor, so the
// export writes it at a short path instead of under
// assets/__node_modules/.pnpm/... — see scripts/web-export-paths.cjs.
// Native builds resolve exactly as before.
const webVendorDir = path.resolve(projectRoot, "assets", "web-vendor");
const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolution = (upstreamResolveRequest ?? context.resolveRequest)(
    context,
    moduleName,
    platform,
  );
  if (platform !== "web" || resolution.type !== "assetFiles") return resolution;
  return {
    ...resolution,
    filePaths: vendoredWebAsset(resolution.filePaths, webVendorDir, existsSync),
  };
};

module.exports = config;
