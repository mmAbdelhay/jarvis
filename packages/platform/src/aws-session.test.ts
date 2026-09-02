import { describe, expect, it } from "vitest";
import { awsLoginCommand, eksUpdateKubeconfigArgs, profileForContext } from "./aws-session.js";

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
});

describe("awsLoginCommand", () => {
  it("chains saml2aws login and aws eks update-kubeconfig with &&", () => {
    expect(awsLoginCommand("app_dev", "eu-west-1", "saml")).toBe(
      "saml2aws login && aws eks update-kubeconfig --name app_dev --region eu-west-1 --profile saml",
    );
  });
});
