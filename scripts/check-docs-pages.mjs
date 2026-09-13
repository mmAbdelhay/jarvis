// Every page the docs site publishes must be a file git tracks.
//
// The site is built with srcDir at the repository root, so VitePress sees
// every markdown file on disk — including ones .gitignore deliberately keeps
// out of the repository. docs/superpowers/ is the one that matters: internal
// design specs and implementation plans, local by intent. Left out of
// srcExclude they would be published silently, and the build would succeed.
//
// The prefixes below mirror srcExclude in .vitepress/config.ts, so this sees
// the same set of pages the site does. What it adds is the property that
// actually matters and that no denylist can promise: nothing reaches the site
// which is not already public in the repository. A new private directory
// nobody remembered to exclude fails here instead of shipping.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Mirrors `srcExclude` in .vitepress/config.ts, as repository-relative paths. */
const EXCLUDED = [
  "docs/superpowers",
  "packages",
  "spikes",
  "design",
  "config",
  "scripts",
  ".github",
  ".claude",
  ".agents",
  ".superpowers",
  ".vitepress",
  ".git",
  "node_modules",
];

const isExcluded = (path) =>
  EXCLUDED.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

/** Every markdown file VitePress would turn into a page. */
function pagesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const path = relative(root, full).split("\\").join("/");
    if (isExcluded(path)) continue;
    if (statSync(full).isDirectory()) found.push(...pagesUnder(full));
    else if (entry.endsWith(".md")) found.push(path);
  }
  return found;
}

const tracked = new Set(
  execFileSync("git", ["ls-files", "*.md"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean),
);

const pages = pagesUnder(root);
const untracked = pages.filter((path) => !tracked.has(path));

if (untracked.length > 0) {
  console.error(
    `${untracked.length} markdown file(s) would be published by the docs site but are\n` +
      "not tracked by git. Either commit them, or add them to srcExclude in\n" +
      ".vitepress/config.ts and to EXCLUDED in this script:\n\n" +
      untracked.map((path) => `  ${path}`).join("\n") +
      "\n",
  );
  process.exit(1);
}

console.log(`  • ${pages.length} pages, all git-tracked`);
