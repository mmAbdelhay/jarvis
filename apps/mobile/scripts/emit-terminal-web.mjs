#!/usr/bin/env node
// Runs after `expo export --platform web` (the export:web script). Writes
// the browser build's static terminal page next to the app, from the same
// inputs as build-terminal-html.mjs:
//   <out>/terminal.html, <out>/terminal.<hash>.js, <out>/terminal.<hash>.css
// then checks every .html file in <out> for an inline <script> and fails
// the export if it finds one (the web app's CSP allows none), and fails it
// if any file's path is over WEB_EXPORT_PATH_LIMIT (web-export-paths.cjs).
//
// Usage: node scripts/emit-terminal-web.mjs dist-web

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildTerminalWebPage, findInlineScripts } from "./terminal-html.mjs";
import { readTerminalInputs } from "./terminal-inputs.mjs";
import webExportPaths from "./web-export-paths.cjs";

function allFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...allFiles(full));
    else found.push(full);
  }
  return found;
}

async function main() {
  const outArg = process.argv[2];
  if (outArg === undefined) {
    console.error("usage: emit-terminal-web.mjs <export output dir>");
    process.exit(1);
  }
  const out = resolve(outArg);
  if (!statSync(out).isDirectory()) throw new Error(`${out} is not a directory`);

  const page = buildTerminalWebPage(await readTerminalInputs());
  writeFileSync(join(out, "terminal.html"), page.html);
  writeFileSync(join(out, page.scriptName), page.script);
  writeFileSync(join(out, page.styleName), page.style);
  console.log(`emit-terminal-web: wrote terminal.html, ${page.scriptName}, ${page.styleName}`);

  const offenders = [];
  const files = allFiles(out);
  for (const file of files.filter((name) => name.endsWith(".html"))) {
    for (const element of findInlineScripts(readFileSync(file, "utf8"))) {
      offenders.push(`${relative(out, file)}: ${element.slice(0, 80)}`);
    }
  }
  if (offenders.length > 0) {
    console.error(`emit-terminal-web: inline <script> found:\n${offenders.join("\n")}`);
    process.exit(1);
  }
  console.log("emit-terminal-web: no inline <script> in any exported .html");

  const { WEB_EXPORT_PATH_LIMIT, overlongPaths } = webExportPaths;
  const overlong = overlongPaths(files.map((file) => relative(out, file)));
  if (overlong.length > 0) {
    console.error(
      `emit-terminal-web: ${overlong.length} exported path(s) over ${WEB_EXPORT_PATH_LIMIT} characters (Windows MAX_PATH once installed):\n${overlong.join("\n")}`,
    );
    process.exit(1);
  }
  const longest = Math.max(...files.map((file) => relative(out, file).length));
  console.log(
    `emit-terminal-web: every exported path is within ${WEB_EXPORT_PATH_LIMIT} characters (longest ${longest})`,
  );
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exit(1);
});
