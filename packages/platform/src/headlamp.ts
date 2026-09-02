import { dirname, join } from "node:path";

/** One entry of a project's `clusters:` list in jarvis.yaml: a kubeconfig
 *  context the Cluster button may open, and the name shown for it. */
export type ClusterEntry = { name: string; context: string };

/** Project name to that project's clusters. A project absent from this
 *  record has its Cluster button disabled — there is nothing to open. */
export type ClustersConfig = Record<string, ClusterEntry[]>;

/**
 * A context name as Headlamp spells it in a URL: `/` becomes `--`, and
 * colons survive untouched, because a colon is legal in a path segment and
 * a slash is not. Observed against 0.45.0 — the EKS context
 * `…:cluster/app_dev` is served at `…:cluster--app_dev`.
 *
 * This is Headlamp's rule, not ours, and nothing promises it is stable.
 * It lives in one function with its own test so an upgrade that changes it
 * fails here loudly, rather than as a tab that quietly loads a 404.
 */
export function clusterUrlSegment(context: string): string {
  return context.replaceAll("/", "--");
}

/**
 * The value for `-skipped-kube-contexts`: every context in the kubeconfig
 * that this project does not declare, spelled the way the flag matches.
 *
 * The difference is computed on raw names — both inputs come from the
 * kubeconfig and from `clusters:`, so raw is the only form in which they
 * compare — and the result is then rewritten, because the flag silently
 * ignores any name containing `/`. Verified against 0.45.0: a raw EKS ARN
 * is not an error, it simply never filters, which would have left every
 * project's sidebar listing every cluster on the machine.
 *
 * Headlamp has no "only these" flag, so the filter has to be a complement.
 * A name in `keep` the kubeconfig does not have is absent from the result —
 * a stale `clusters:` entry should skip nothing, and it will fail visibly
 * when its own tab is opened.
 */
export function skippedContexts(all: readonly string[], keep: readonly string[]): string[] {
  const kept = new Set(keep);
  return all.filter((context) => !kept.has(context)).map(clusterUrlSegment);
}

/** Headlamp's front end ships beside its server inside the app bundle, so
 *  it is derived rather than configured: a bundle where the two had drifted
 *  apart would be broken anyway. */
export function frontendDirFor(binary: string): string {
  return join(dirname(binary), "frontend");
}

/**
 * Where the Headlamp bundle puts its server on each platform. The binary is
 * never distributed alone — every release is a desktop app — but they are
 * all Electron, so the path inside the bundle is the same shape everywhere
 * and only the install root differs. `headlamp.binary` overrides this.
 */
export function defaultHeadlampBinary(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === "darwin") {
    return "/Applications/Headlamp.app/Contents/Resources/headlamp-server";
  }
  if (platform === "win32") {
    return join(env["LOCALAPPDATA"] ?? "", "Programs", "Headlamp", "resources", "headlamp-server.exe");
  }
  return "/opt/Headlamp/resources/headlamp-server";
}
