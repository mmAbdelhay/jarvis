// Regenerates renderer/vendor/material-icons from an unpacked material-icon-theme
// package:  node scripts/vendor-material-icons.mjs <package directory>
// The package is read as data only; see material-icons-lib.mjs.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vendorIcons } from "./material-icons-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const from = process.argv[2];
if (from === undefined) {
  console.error("usage: node scripts/vendor-material-icons.mjs <material-icon-theme directory>");
  process.exit(2);
}
const result = vendorIcons({
  from: resolve(from),
  to: join(here, "..", "renderer", "vendor", "material-icons"),
});
console.log(`vendored ${result.icons} icons from material-icon-theme ${result.version}`);
