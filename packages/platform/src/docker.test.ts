import { describe, expect, it } from "vitest";
import { createDockerClient, type CommandRunner, type LogSpawner } from "./docker.js";

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

const noLogs: LogSpawner = () => ({ close: () => {} });

describe("createDockerClient.list", () => {
  it("asks for ids first, then inspects exactly those ids", async () => {
    const { run, calls } = runnerFor([
      { code: 0, stdout: "abc123\tUp 3 hours\ndef456\tExited (0) 2 minutes ago\n", stderr: "" },
      { code: 0, stdout: JSON.stringify([inspected()]), stderr: "" },
    ]);

    await createDockerClient(run, noLogs).list();

    expect(calls[0]).toEqual({
      command: "docker",
      args: ["ps", "-a", "--no-trunc", "--format", "{{.ID}}\t{{.Status}}"],
    });
    expect(calls[1]).toEqual({ command: "docker", args: ["inspect", "abc123", "def456"] });
  });

  it("reads name, image, state, human status, ports and compose labels", async () => {
    const { run } = runnerFor([
      { code: 0, stdout: "abc123\tUp 3 hours\n", stderr: "" },
      { code: 0, stdout: JSON.stringify([inspected()]), stderr: "" },
    ]);

    const result = await createDockerClient(run, noLogs).list();

    expect(result).toEqual({
      ok: true,
      containers: [
        {
          name: "acme-app-1",
          id: "abc123",
          image: "acme-app:latest",
          state: "running",
          status: "Up 3 hours",
          ports: ["0.0.0.0:8000->8000/tcp"],
          composeProject: "acme",
          composeWorkingDir: "/Users/u/projects/acme",
        },
      ],
    });
  });

  it("carries docker ps's human status, not inspect's terse enum", async () => {
    const { run } = runnerFor([
      {
        code: 0,
        stdout: "abc123\tUp 3 hours\ndef456\tExited (0) 2 minutes ago\n",
        stderr: "",
      },
      {
        code: 0,
        stdout: JSON.stringify([
          inspected(),
          inspected({ Id: "def456", Name: "/redis-1", State: { Status: "exited" } }),
        ]),
        stderr: "",
      },
    ]);

    const result = await createDockerClient(run, noLogs).list();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.containers.map((c) => [c.state, c.status])).toEqual([
      ["running", "Up 3 hours"],
      ["exited", "Exited (0) 2 minutes ago"],
    ]);
  });

  it("skips a malformed ps line rather than throwing", async () => {
    const { run, calls } = runnerFor([
      { code: 0, stdout: "\nnot-a-pair\nabc123\tUp 3 hours\n\t orphaned\n", stderr: "" },
      { code: 0, stdout: JSON.stringify([inspected()]), stderr: "" },
    ]);

    const result = await createDockerClient(run, noLogs).list();

    expect(calls[1]).toEqual({ command: "docker", args: ["inspect", "abc123"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.containers[0]?.status).toBe("Up 3 hours");
  });

  it("leaves the status empty for a container ps did not name", async () => {
    const { run } = runnerFor([
      { code: 0, stdout: "abc123\tUp 3 hours\n", stderr: "" },
      {
        code: 0,
        stdout: JSON.stringify([inspected({ Id: "zzz999" })]),
        stderr: "",
      },
    ]);

    const result = await createDockerClient(run, noLogs).list();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.containers[0]?.status).toBe("");
  });

  it("does not inspect when there are no containers", async () => {
    const { run, calls } = runnerFor([{ code: 0, stdout: "\n", stderr: "" }]);

    const result = await createDockerClient(run, noLogs).list();

    expect(result).toEqual({ ok: true, containers: [] });
    expect(calls).toHaveLength(1);
  });

  it("leaves compose fields undefined for a container compose did not start", async () => {
    const { run } = runnerFor([
      { code: 0, stdout: "abc123\tUp 3 hours\n", stderr: "" },
      {
        code: 0,
        stdout: JSON.stringify([
          inspected({ Config: { Image: "redis:7", Labels: {} } }),
        ]),
        stderr: "",
      },
    ]);

    const result = await createDockerClient(run, noLogs).list();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.containers[0]?.composeProject).toBeUndefined();
    expect(result.containers[0]?.composeWorkingDir).toBeUndefined();
  });

  it("reads the compose service label, and leaves it undefined when absent", async () => {
    const { run } = runnerFor([
      { code: 0, stdout: "abc123\tUp 3 hours\ndef456\tUp 2 days\n", stderr: "" },
      {
        code: 0,
        stdout: JSON.stringify([
          inspected({
            Config: {
              Image: "acme-app:latest",
              Labels: {
                "com.docker.compose.project": "acme",
                "com.docker.compose.project.working_dir": "/Users/u/projects/acme",
                "com.docker.compose.service": "app",
              },
            },
          }),
          inspected({ Id: "def456", Name: "/redis-1", Config: { Image: "redis:7", Labels: {} } }),
        ]),
        stderr: "",
      },
    ]);

    const result = await createDockerClient(run, noLogs).list();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.containers[0]?.composeService).toBe("app");
    expect(result.containers[1]?.composeService).toBeUndefined();
  });

  it("reports a missing binary as not-installed", async () => {
    const run: CommandRunner = () =>
      Promise.reject(Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));

    const result = await createDockerClient(run, noLogs).list();

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

    const result = await createDockerClient(run, noLogs).list();

    expect(result).toEqual({
      ok: false,
      reason: "daemon-down",
      detail: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
    });
  });

  it("treats an unpublished port as no port at all", async () => {
    const { run } = runnerFor([
      { code: 0, stdout: "abc123\tUp 3 hours\n", stderr: "" },
      {
        code: 0,
        stdout: JSON.stringify([
          inspected({ NetworkSettings: { Ports: { "5432/tcp": null } } }),
        ]),
        stderr: "",
      },
    ]);

    const result = await createDockerClient(run, noLogs).list();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.containers[0]?.ports).toEqual([]);
  });

  it("converts a rejection on the inspect call to daemon-down", async () => {
    const run: CommandRunner = (command, args) => {
      if (command === "docker" && args[0] === "ps") {
        return Promise.resolve({ code: 0, stdout: "abc123\tUp 3 hours\n", stderr: "" });
      }
      return Promise.reject(new Error("boom"));
    };

    const result = await createDockerClient(run, noLogs).list();

    expect(result).toEqual({
      ok: false,
      reason: "daemon-down",
      detail: "boom",
    });
  });
});

describe("createDockerClient actions", () => {
  it("runs the documented command for each lifecycle action", async () => {
    const cases = [
      ["start", ["start", "acme-app-1"]],
      ["stop", ["stop", "acme-app-1"]],
      ["restart", ["restart", "acme-app-1"]],
    ] as const;

    for (const [action, expected] of cases) {
      const { run, calls } = runnerFor([{ code: 0, stdout: "", stderr: "" }]);
      const result = await createDockerClient(run, noLogs)[action]("acme-app-1");
      expect(result).toEqual({ ok: true });
      expect(calls[0]).toEqual({ command: "docker", args: [...expected] });
    }
  });

  it("carries the daemon's own words out of a failed action", async () => {
    const { run } = runnerFor([
      { code: 1, stdout: "", stderr: "Error response from daemon: No such container: nope\n" },
    ]);

    const result = await createDockerClient(run, noLogs).stop("nope");

    expect(result).toEqual({
      ok: false,
      detail: "Error response from daemon: No such container: nope",
    });
  });

  it("reports a missing binary as a failure rather than throwing", async () => {
    const run: CommandRunner = () =>
      Promise.reject(Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));

    await expect(createDockerClient(run, noLogs).start("app")).resolves.toEqual({
      ok: false,
      detail: "spawn docker ENOENT",
    });
  });

  it("brings a stack up from its project directory", async () => {
    const { run, calls } = runnerFor([{ code: 0, stdout: "", stderr: "" }]);

    await createDockerClient(run, noLogs).composeUp("/Users/u/projects/acme");

    expect(calls[0]).toEqual({
      command: "docker",
      args: ["compose", "--project-directory", "/Users/u/projects/acme", "up", "-d"],
    });
  });

  it("takes a stack down by project name", async () => {
    const { run, calls } = runnerFor([{ code: 0, stdout: "", stderr: "" }]);

    await createDockerClient(run, noLogs).composeDown("acme");

    expect(calls[0]).toEqual({
      command: "docker",
      args: ["compose", "-p", "acme", "down"],
    });
  });
});

describe("createDockerClient.follow", () => {
  it("follows a container's log from a bounded tail", () => {
    const spawned: { command: string; args: string[] }[] = [];
    const spawnLog: LogSpawner = (command, args) => {
      spawned.push({ command, args });
      return { close: () => {} };
    };

    createDockerClient(runnerFor([]).run, spawnLog).follow("acme-app-1", () => {});

    expect(spawned[0]).toEqual({
      command: "docker",
      args: ["logs", "-f", "--tail", "500", "acme-app-1"],
    });
  });

  it("hands chunks straight through and closes what it started", () => {
    const chunks: string[] = [];
    let closed = false;
    const spawnLog: LogSpawner = (_command, _args, onChunk) => {
      onChunk("first line\n");
      return { close: () => { closed = true; } };
    };

    const follower = createDockerClient(runnerFor([]).run, spawnLog).follow("app", (chunk) =>
      chunks.push(chunk),
    );
    follower.close();

    expect(chunks).toEqual(["first line\n"]);
    expect(closed).toBe(true);
  });
});
