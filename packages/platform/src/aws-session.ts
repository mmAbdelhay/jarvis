import { parse } from "yaml";
import { runCommand } from "./spawn.js";

/** What an AWS identifier is allowed to look like before it may reach
 *  awsLoginCommand. Everything this module extracts — a profile out of an
 *  exec block, a cluster name and region out of an ARN — is written verbatim
 *  into a live shell, and a kubeconfig is often pasted in from a wiki, a CI
 *  artifact or a teammate rather than written by hand. Real cluster names,
 *  profile names and regions are strict subsets of these patterns, so a value
 *  that fails one is not a legitimate one being rejected: it is a `;`, a
 *  `$(…)` or a newline that would otherwise have been a second command.
 *  Anything refused here falls back to the behavior that predates auto-login
 *  — no profile, no args, nothing to check, straight on to the cluster. */
const AWS_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const AWS_REGION = /^[a-z0-9-]+$/;

/** The AWS_PROFILE a context's exec credential plugin runs with, or
 *  undefined if the context has none — either it isn't in the kubeconfig,
 *  its user has no exec block, the exec block sets no AWS_PROFILE, or the
 *  value it sets is not a plain AWS identifier (see AWS_NAME). A context
 *  this returns undefined for is not this module's concern: cluster open
 *  proceeds exactly as it did before this module existed. Tolerant of
 *  malformed input the same way parseKubeContexts (headlamp.ts) is — a
 *  kubeconfig this cannot fully understand should cost the user the
 *  auto-login, not the ability to open the cluster it can't parse. */
export function profileForContext(kubeconfigYaml: string, context: string): string | undefined {
  let document: unknown;
  try {
    document = parse(kubeconfigYaml);
  } catch {
    return undefined;
  }
  if (typeof document !== "object" || document === null) return undefined;

  const contexts = (document as Record<string, unknown>)["contexts"];
  if (!Array.isArray(contexts)) return undefined;
  const contextEntry = contexts.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>)["name"] === context,
  ) as Record<string, unknown> | undefined;
  const inner = contextEntry?.["context"];
  const userRef =
    typeof inner === "object" && inner !== null
      ? (inner as Record<string, unknown>)["user"]
      : undefined;
  if (typeof userRef !== "string") return undefined;

  const users = (document as Record<string, unknown>)["users"];
  if (!Array.isArray(users)) return undefined;
  const userEntry = users.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>)["name"] === userRef,
  ) as Record<string, unknown> | undefined;
  const userBlock = userEntry?.["user"];
  const exec =
    typeof userBlock === "object" && userBlock !== null
      ? (userBlock as Record<string, unknown>)["exec"]
      : undefined;
  const env =
    typeof exec === "object" && exec !== null ? (exec as Record<string, unknown>)["env"] : undefined;
  if (!Array.isArray(env)) return undefined;

  const profileEntry = env.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>)["name"] === "AWS_PROFILE",
  ) as Record<string, unknown> | undefined;
  const value = profileEntry?.["value"];
  return typeof value === "string" && AWS_NAME.test(value) ? value : undefined;
}

const EKS_ARN = /^arn:aws:eks:([^:]+):[^:]*:cluster\/(.+)$/;

/** The cluster name and region `aws eks update-kubeconfig` needs, read off
 *  the ARN a context already carries. undefined for a context that isn't an
 *  EKS ARN (a local `kind` context, for instance) — there is no
 *  update-kubeconfig target for it — and for one whose name or region is not
 *  a plain AWS identifier (see AWS_NAME). */
export function eksUpdateKubeconfigArgs(context: string): { name: string; region: string } | undefined {
  const match = EKS_ARN.exec(context);
  if (match === null) return undefined;
  const [, region, name] = match;
  if (region === undefined || name === undefined) return undefined;
  if (!AWS_NAME.test(name) || !AWS_REGION.test(region)) return undefined;
  return { name, region };
}

/** The exact line typed into the terminal. `&&` so a failed saml2aws login
 *  never runs update-kubeconfig against stale credentials. */
export function awsLoginCommand(name: string, region: string, profile: string): string {
  return `saml2aws login && aws eks update-kubeconfig --name ${name} --region ${region} --profile ${profile}`;
}

export type AwsSessionChecker = (profile: string, region?: string) => Promise<boolean>;

/** `aws sts get-caller-identity --profile <profile> [--region <region>]`,
 *  exit 0 -> true. `env` is a parameter, not `process.env`, for the same
 *  reason headlamp.ts's real spawner takes one: the exec credential plugin
 *  is resolved on PATH, and a GUI app's PATH is not a login shell's. */
export function createAwsSessionChecker(env: NodeJS.ProcessEnv): AwsSessionChecker {
  return async (profile, region) => {
    const args =
      region === undefined
        ? ["sts", "get-caller-identity", "--profile", profile]
        : ["sts", "get-caller-identity", "--profile", profile, "--region", region];
    try {
      const { code } = await runCommand("aws", args, env);
      return code === 0;
    } catch {
      return false;
    }
  };
}

/** Calls `check` every `intervalMs` until it returns true or `timeoutMs`
 *  elapses. Real timers, like waitUntilReady (code-server.ts) — not
 *  unit-tested through a real 3-minute clock, only through fake timers in
 *  this module's own test and through a fake whole-function replacement at
 *  every call site. */
export function createAwsSessionPoller(
  check: AwsSessionChecker,
  options?: { intervalMs?: number; timeoutMs?: number },
): AwsSessionChecker {
  const intervalMs = options?.intervalMs ?? 3_000;
  const timeoutMs = options?.timeoutMs ?? 180_000;
  return async (profile, region) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await check(profile, region)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };
}
