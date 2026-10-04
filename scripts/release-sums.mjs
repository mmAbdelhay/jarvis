// `node scripts/release-sums.mjs [--out SHA256SUMS] <files...>` — the checksum
// file every release uploads beside its downloads.
//
// The desktop updater refuses to install a download whose SHA-256 it cannot
// find in the release's `SHA256SUMS`, so a release without this file can be
// downloaded by hand but never installed from Settings.
//
// The format is `sha256sum`'s: 64 lowercase hex digits, two spaces, the bare
// file name. The updater matches the asset's exact name, which is why the
// directory is dropped — a path would never match. Lines are sorted by name so
// the same files always produce the same text.
//
// Every file is hashed before anything is written: a missing file fails the
// whole run rather than leaving a `SHA256SUMS` that silently lacks a line.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt === -1 ? undefined : args[outAt + 1];
const files = outAt === -1 ? args : args.filter((_, i) => i !== outAt && i !== outAt + 1);

if (files.length === 0 || (outAt !== -1 && !out)) {
  console.error("Usage: node scripts/release-sums.mjs [--out SHA256SUMS] <files...>");
  process.exit(1);
}

const hash = (path) =>
  new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => digest.update(chunk))
      .on("end", () => resolve(digest.digest("hex")));
  });

let lines;
try {
  lines = await Promise.all(
    files.map(async (path) => ({ name: basename(path), sum: await hash(path) })),
  );
} catch (error) {
  console.error(`release-sums: ${error.message}`);
  process.exit(1);
}

const text = lines
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  .map(({ name, sum }) => `${sum}  ${name}\n`)
  .join("");

if (out) await writeFile(out, text);
else process.stdout.write(text);
