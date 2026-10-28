// A downloaded installer is only run if its SHA-256 matches the line for it
// in the release's SHA256SUMS. The file is hashed as a stream: an installer
// is a few hundred MB and need not sit in memory to be checked.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export { parseSums } from "@jarvis/wire";

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
