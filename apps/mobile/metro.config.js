const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

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

module.exports = config;
