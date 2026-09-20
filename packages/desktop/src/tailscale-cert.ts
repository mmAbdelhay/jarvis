// Turns this machine's Tailscale connection into a real TLS certificate for
// the remote bridge's sidecar proxy — `remote.tls.certPath`/`keyPath`
// (config.ts), served through packages/remote/src/certificate.ts's
// "configured" path and trusted by the phone through its own OS store
// (see docs/guide/remote-access.md's "tailscale cert walkthrough"). Every
// dependency here is injected (`exec`, `fs`, `homedir`, `platform`), so the
// tests below never spawn a real `tailscale` binary or touch a real
// ~/.config/jarvis — see tailscale-cert.test.ts.
import { join } from "node:path";
import { errorMessage } from "./messages.js";

/** No shell, bounded — main.ts wires this to @jarvis/platform's
 *  `runCommandWithLimits`, the same bounded-timeout runner every other
 *  untrusted-duration subprocess in this app already goes through. */
export type TailscaleExec = (
  command: string,
  args: string[],
  limits: { timeoutMs: number; maxOutputBytes: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type TailscaleFs = {
  /** Rejects unless `path` exists — used only to probe the macOS app
   *  bundle's fixed CLI path. */
  access(path: string): Promise<void>;
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
};

export type TailscaleCertDeps = {
  exec: TailscaleExec;
  fs: TailscaleFs;
  homedir: () => string;
  /** Only darwin gets the fixed app-bundle path below; every other platform
   *  is assumed to have `tailscale` on PATH, the way every other spawned
   *  command in this app resolves its own binary. */
  platform: NodeJS.Platform;
};

export type TailscaleCertResult =
  | { ok: true; certPath: string; keyPath: string; name: string }
  | {
      ok: false;
      kind: "no-tailscale" | "not-connected" | "https-disabled" | "failed";
      detail: string;
    };

const MAC_CLI_PATH = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const PROBE_LIMITS = { timeoutMs: 5_000, maxOutputBytes: 4_096 };
const STATUS_LIMITS = { timeoutMs: 10_000, maxOutputBytes: 1_000_000 };
const CERT_TIMEOUT_MS = 60_000;
const CERT_LIMITS = { timeoutMs: CERT_TIMEOUT_MS, maxOutputBytes: 65_536 };

/**
 * The CLI's own path (macOS) or bare name (everywhere else), ready to hand
 * to `deps.exec` — or `undefined` when Tailscale is not installed on this
 * machine at all.
 */
export async function findTailscaleCli(deps: TailscaleCertDeps): Promise<string | undefined> {
  if (deps.platform === "darwin") {
    try {
      await deps.fs.access(MAC_CLI_PATH);
      return MAC_CLI_PATH;
    } catch {
      return undefined;
    }
  }
  // Linux (and every other platform): `tailscale` on PATH, resolved by the
  // OS the same way every other bare command name this app spawns already
  // is (child_process.spawn's execvp semantics) — so "is it installed" is
  // answered by actually trying to run it rather than searching PATH here.
  try {
    const result = await deps.exec("tailscale", ["version"], PROBE_LIMITS);
    return result.code === 0 ? "tailscale" : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This machine's own MagicDNS name, with the trailing dot `status --json`
 * always reports stripped — or `undefined` when Tailscale is not running,
 * not logged in, or its status cannot be read/parsed at all.
 */
export async function tailnetName(
  deps: TailscaleCertDeps,
  cli: string,
): Promise<string | undefined> {
  let result: { code: number; stdout: string };
  try {
    result = await deps.exec(cli, ["status", "--json"], STATUS_LIMITS);
  } catch {
    return undefined;
  }
  if (result.code !== 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const self = (parsed as Record<string, unknown>)["Self"];
  if (typeof self !== "object" || self === null) return undefined;
  const dnsName = (self as Record<string, unknown>)["DNSName"];
  if (typeof dnsName !== "string" || dnsName === "") return undefined;
  return dnsName.endsWith(".") ? dnsName.slice(0, -1) : dnsName;
}

/** `~/.config/jarvis/tls` — where a certificate this module issues lives. */
export function defaultCertDir(deps: Pick<TailscaleCertDeps, "homedir">): string {
  return join(deps.homedir(), ".config/jarvis/tls");
}

/** The text's own last non-empty line — never the whole output, which can
 *  carry a multi-line usage dump this UI has no room to show. */
function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines[lines.length - 1] ?? "";
}

const HTTPS_DISABLED_MARKER = "does not support getting TLS certs";

/**
 * Runs `tailscale cert --cert-file <dir>/<name>.crt --key-file
 * <dir>/<name>.key <name>` — the same command whether this is the first
 * certificate or a renewal, since Tailscale renews an existing name in
 * place. `dir` is created (and tightened) to 0700 first; both files are
 * tightened to 0600 once the CLI has written them. Never logs the key's own
 * contents anywhere — only paths, and only the CLI's own last output line
 * on failure.
 */
export async function issueCertificate(
  deps: TailscaleCertDeps,
  cli: string,
  { name, dir }: { name: string; dir: string },
): Promise<TailscaleCertResult> {
  const certPath = join(dir, `${name}.crt`);
  const keyPath = join(dir, `${name}.key`);

  try {
    await deps.fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // fs.mkdir's `mode` only applies to a directory it actually creates —
    // an already-existing dir keeps whatever mode it had, so this tightens
    // it unconditionally rather than trusting mkdir alone.
    await deps.fs.chmod(dir, 0o700);
  } catch (error) {
    return { ok: false, kind: "failed", detail: lastLine(errorMessage(error)) };
  }

  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await deps.exec(
      cli,
      ["cert", "--cert-file", certPath, "--key-file", keyPath, name],
      CERT_LIMITS,
    );
  } catch (error) {
    return { ok: false, kind: "failed", detail: lastLine(errorMessage(error)) };
  }

  if (result.code !== 0) {
    const detail = lastLine(result.stderr === "" ? result.stdout : result.stderr);
    const kind = detail.includes(HTTPS_DISABLED_MARKER) ? "https-disabled" : "failed";
    return { ok: false, kind, detail };
  }

  try {
    await deps.fs.chmod(certPath, 0o600);
    await deps.fs.chmod(keyPath, 0o600);
  } catch (error) {
    return { ok: false, kind: "failed", detail: lastLine(errorMessage(error)) };
  }

  return { ok: true, certPath, keyPath, name };
}

/**
 * The whole flow the `remote:tailscaleCert` channel (dispatch.ts) drives:
 * find the CLI, read this machine's own MagicDNS name, issue (or renew) the
 * certificate under it. Composed here, once, so the channel handler is a
 * single call — the `writeConfig` step that follows a success lives in
 * dispatch.ts instead, since only main.ts's serialized writeConfig closure
 * (the same one Settings' own save and remote-idle.ts's onIdleDisabled use)
 * may ever touch jarvis.yaml.
 */
export async function obtainCertificate(deps: TailscaleCertDeps): Promise<TailscaleCertResult> {
  const cli = await findTailscaleCli(deps);
  if (cli === undefined) {
    return { ok: false, kind: "no-tailscale", detail: "Tailscale is not installed" };
  }
  const name = await tailnetName(deps, cli);
  if (name === undefined) {
    return { ok: false, kind: "not-connected", detail: "Tailscale is not connected" };
  }
  return issueCertificate(deps, cli, { name, dir: defaultCertDir(deps) });
}
