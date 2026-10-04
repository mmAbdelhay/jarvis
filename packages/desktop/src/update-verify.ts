// A downloaded installer is only run if its SHA-256 matches the line for it
// in the release's SHA256SUMS. The file is hashed as a stream: an installer
// is a few hundred MB and need not sit in memory to be checked.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** One sha256sum line: 64 hex, then "  name" (text) or " *name" (binary). */
const SUM_LINE = /^([0-9a-fA-F]{64}) [ *](.+)$/;

/** SHA256SUMS text → file name → lowercase hex. Malformed lines are skipped,
 *  and a name listed twice with different hashes is dropped as ambiguous. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const line of text.split("\n")) {
    const match = SUM_LINE.exec(line.replace(/\r$/, ""));
    if (match === null) continue;
    const hex = (match[1] as string).toLowerCase();
    const name = match[2] as string;
    const seen = sums.get(name);
    if (seen !== undefined && seen !== hex) conflicted.add(name);
    sums.set(name, hex);
  }
  for (const name of conflicted) sums.delete(name);
  return sums;
}

/** Lowercase hex SHA-256 of the file; rejects if it cannot be read. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** True only when the file hashes to `expectedHex` (any case). A read
 *  failure rejects rather than reading as a mismatch. */
export async function verifyFile(path: string, expectedHex: string): Promise<boolean> {
  return (await sha256File(path)) === expectedHex.toLowerCase();
}
