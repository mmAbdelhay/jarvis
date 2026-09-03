import { describe, expect, it } from "vitest";
import { createDockerClient, type CommandRunner } from "./docker.js";

/** One `docker inspect` element, trimmed to the fields list() reads. */
function inspected(over: Record<string, unknown> = {}): unknown {
  return {
    Id: "abc123",
    Name: "/acme-app-1",
    State: { Status: "running" },
    Config: {
      Image: "acme-app:latest",
      Labels: {
        "com.docker.compose.project": "acme",
        "com.docker.compose.project.working_dir": "/Users/u/projects/acme",
      },
    },
    NetworkSettings: {
      Ports: { "8000/tcp": [{ HostIp: "0.0.0.0", HostPort: "8000" }] },
    },
    ...over,
  };
}

/** A runner that answers a scripted list of calls in order and records them. */
function runnerFor(replies: { code: number; stdout: string; stderr: string }[]): {
  run: CommandRunner;
  calls: { command: string; args: string[] }[];
} {
  const calls: { command: string; args: string[] }[] = [];
  let next = 0;
  return {
    calls,
    run: (command, args) => {
      calls.push({ command, args });
      const reply = replies[next++];
      if (reply === undefined) throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
      return Promise.resolve(reply);
    },
  };
}

describe("createDockerClient.list", () => {
  it("asks for ids first, then inspects exactly those ids", async () => {
    const { run, calls } = runnerFor([
      { code: 0, stdout: "abc123\ndef456\n", stderr: "" },
      { code: 0, stdout: JSON.stringify([inspected()]), stderr: "" },
    ]);

    await createDockerClient(run).list();

    expect(calls[0]).toEqual({ command: "docker", args: ["ps", "-aq"] });
    expect(calls[1]).toEqual({ command: "docker", args: ["inspect", "abc123", "def456"] });
  });

  it("reads name, image, state, ports and compose labels", async () => {
    const { run } = runnerFor([
      { code: 0, stdout: "abc123\n", stderr: "" },
      { code: 0, stdout: JSON.stringify([inspected()]), stderr: "" },
    ]);

    const result = await createDockerClient(run).list();

    expect(result).toEqual({
      ok: true,
      containers: [
        {
          name: "acme-app-1",
          id: "abc123",
          image: "acme-app:latest",
          state: "running",
          status: "running",
          ports: ["0.0.0.0:8000->8000/tcp"],
          composeProject: "acme",
          composeWorkingDir: "/Users/u/projects/acme",
        },
      ],
    });
  });

  it("does not inspect when there are no containers", async () => {
    const { run, calls } = runnerFor([{ code: 0, stdout: "\n", stderr: "" }]);

    const result = await createDockerClient(run).list();

    expect(result).toEqual({ ok: true, containers: [] });
    expect(calls).toHaveLength(1);
  });

  it("leaves compose fields undefined for a container compose did not start", async () => {
    const { run } = runnerFor([
      { code: 0, stdout: "abc123\n", stderr: "" },
      {
        code: 0,
        stdout: JSON.stringify([
          inspected({ Config: { Image: "redis:7", Labels: {} } }),
        ]),
        stderr: "",
      },
    ]);

    const result = await createDockerClient(run).list();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.containers[0]?.composeProject).toBeUndefined();
    expect(result.containers[0]?.composeWorkingDir).toBeUndefined();
  });

  it("reports a missing binary as not-installed", async () => {
    const run: CommandRunner = () =>
      Promise.reject(Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));

    const result = await createDockerClient(run).list();

    expect(result).toEqual({
      ok: false,
      reason: "not-installed",
      detail: "spawn docker ENOENT",
    });
  });

  it("reports a refused daemon as daemon-down, carrying its own words", async () => {
    const { run } = runnerFor([
      {
        code: 1,
        stdout: "",
        stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
      },
    ]);

    const result = await createDockerClient(run).list();

    expect(result).toEqual({
      ok: false,
      reason: "daemon-down",
      detail: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
    });
  });

  it("treats an unpublished port as no port at all", async () => {
    const { run } = runnerFor([
      { code: 0, stdout: "abc123\n", stderr: "" },
      {
        code: 0,
        stdout: JSON.stringify([
          inspected({ NetworkSettings: { Ports: { "5432/tcp": null } } }),
        ]),
        stderr: "",
      },
    ]);

    const result = await createDockerClient(run).list();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.containers[0]?.ports).toEqual([]);
  });
});
