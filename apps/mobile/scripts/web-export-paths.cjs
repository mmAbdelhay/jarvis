// Keeps every file the web export writes at a short path.
//
// The export is shipped inside the desktop app at <resources>/web, and on
// Windows an install directory is already ~60 characters deep. Metro names
// an asset after where it was resolved, so anything inside node_modules
// lands at assets/__node_modules/.pnpm/<package>@<version>_<hash>/... —
// over 200 characters, past MAX_PATH. Two halves:
//   - metro.config.js redirects such an asset, on web only, to a vendored
//     copy in assets/web-vendor (vendoredWebAsset).
//   - emit-terminal-web.mjs fails the export if any file's path is still
//     over WEB_EXPORT_PATH_LIMIT (overlongPaths).
// CommonJS so metro.config.js can require it.
"use strict";
const path = require("node:path");

const WEB_EXPORT_PATH_LIMIT = 100;

/** Export-relative paths (either separator) longer than `limit`, as "/" paths. */
function overlongPaths(relativePaths, limit = WEB_EXPORT_PATH_LIMIT) {
  return relativePaths
    .map((relativePath) => relativePath.split(/[\\/]/).join("/"))
    .filter((relativePath) => relativePath.length > limit);
}

/**
 * The web resolution of an asset: files inside node_modules are swapped for
 * the same file name in `vendorDir`; a file with no vendored copy throws,
 * naming it, so a new one is caught at build time rather than shipped long.
 */
function vendoredWebAsset(filePaths, vendorDir, exists) {
  return filePaths.map((filePath) => {
    const parts = filePath.split(/[\\/]/);
    if (!parts.includes("node_modules")) return filePath;
    const vendored = path.join(vendorDir, parts[parts.length - 1]);
    if (!exists(vendored)) {
      throw new Error(
        `web export: ${filePath} is an asset inside node_modules; copy it to ${vendorDir} (see its README.txt)`,
      );
    }
    return vendored;
  });
}

module.exports = { WEB_EXPORT_PATH_LIMIT, overlongPaths, vendoredWebAsset };
