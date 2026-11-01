// Which background service an instance owns.
//
// launchd labels, systemd user units and HKCU Run values are per OS account,
// not per HOME: a dev or test instance run with another HOME (HOME=/tmp/...
// scripts/start.mjs) that found no daemon under it once bootstrapped and
// kickstarted the shared label, which restarted the user's real daemon and
// killed every terminal it held. So the account's own home keeps the plain
// names it always had, and any other HOME gets names of its own.
import { createHash } from "node:crypto";

function withoutTrailingSeparators(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed === "" ? path : trimmed;
}

/** undefined for the OS account's own home (os.userInfo().homedir, which
 *  ignores $HOME); otherwise the first 8 hex of sha256(home), to suffix
 *  every service name with. */
export function serviceInstanceId(home: string, accountHome: string): string | undefined {
  const own = withoutTrailingSeparators(home);
  if (own === withoutTrailingSeparators(accountHome)) return undefined;
  return createHash("sha256").update(own).digest("hex").slice(0, 8);
}
