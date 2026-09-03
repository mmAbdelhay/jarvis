// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderDockerPane, toTerminalText } from "./workspace-docker.js";

const view = {
  rows: [
    {
      name: "app",
      container: "acme-app-1",
      facts: {
        name: "acme-app-1",
        id: "abc",
        image: "app:latest",
        state: "running" as const,
        status: "running",
        ports: ["0.0.0.0:8000->8000/tcp"],
        composeProject: "acme",
        composeWorkingDir: "/p/acme",
      },
    },
    { name: "mysql", container: "acme-mysql-1", facts: undefined },
  ],
  composeProject: "acme",
  composeWorkingDir: "/p/acme",
};

function host(): HTMLElement {
  // Every action button routes a failure into #workspace-tool-status, the
  // same shared status line openApi/openDocker use in workspace.ts — so it
  // has to exist for a click to have anywhere to report to, exactly as
  // workspace.test.ts's own harness() provides it.
  if (document.getElementById("workspace-tool-status") === null) {
    const status = document.createElement("span");
    status.id = "workspace-tool-status";
    document.body.append(status);
  }
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("renderDockerPane", () => {
  // vi.spyOn on an already-spied method reuses the same mock rather than
  // resetting its call history, so a spy left over from an earlier test in
  // this file would otherwise be counted against a later one that asserts
  // "not called" — restoring after every test keeps each spy's history its
  // own.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a row per configured container", () => {
    const element = host();
    renderDockerPane(element, "tab-1", "acme", view);

    expect(element.querySelectorAll(".workspace-docker-row")).toHaveLength(2);
  });

  it("offers Stop and Restart for a running container, not Start", () => {
    const element = host();
    renderDockerPane(element, "tab-1", "acme", view);

    const row = element.querySelectorAll(".workspace-docker-row")[0] as HTMLElement;
    const labels = [...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toContain("Stop the container");
    expect(labels).toContain("Restart the container");
    expect(labels).not.toContain("Start the container");
  });

  it("offers Start for a container that is not running", () => {
    const element = host();
    renderDockerPane(element, "tab-1", "acme", {
      ...view,
      rows: [{ ...view.rows[0]!, facts: { ...view.rows[0]!.facts!, state: "exited", status: "exited" } }],
    });

    const labels = [...element.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toContain("Start the container");
    expect(labels).not.toContain("Stop the container");
  });

  it("shows Docker's own status string unchanged", () => {
    const element = host();
    renderDockerPane(element, "tab-1", "acme", {
      ...view,
      rows: [{ ...view.rows[0]!, facts: { ...view.rows[0]!.facts!, status: "Up 3 hours" } }],
    });

    expect(element.querySelector(".workspace-docker-row-status")?.textContent).toBe("Up 3 hours");
  });

  it("shows the published ports", () => {
    const element = host();
    renderDockerPane(element, "tab-1", "acme", view);

    expect(element.querySelector(".workspace-docker-row-ports")?.textContent).toBe(
      "0.0.0.0:8000->8000/tcp",
    );
  });

  it("shows no ports element for a container that publishes none", () => {
    const element = host();
    renderDockerPane(element, "tab-1", "acme", {
      ...view,
      rows: [{ ...view.rows[0]!, facts: { ...view.rows[0]!.facts!, ports: [] } }],
    });

    expect(element.querySelector(".workspace-docker-row-ports")).toBeNull();
  });

  it("keeps the log host attached across a re-render", () => {
    const element = host();
    renderDockerPane(element, "tab-1", "acme", view);
    const log = element.querySelector(".workspace-docker-log");
    expect(log).not.toBeNull();

    renderDockerPane(element, "tab-1", "acme", view);

    // The very same node, never removed and re-appended: a poll tick must
    // not disturb a selection the user made inside the log.
    expect(element.querySelector(".workspace-docker-log")).toBe(log);
    expect(element.querySelectorAll(".workspace-docker-log")).toHaveLength(1);
    expect(element.querySelectorAll(".workspace-docker-row")).toHaveLength(2);
  });

  it("drops the compose bar when a later view no longer has one", () => {
    const element = host();
    renderDockerPane(element, "tab-1", "acme", view);
    expect(element.querySelector(".workspace-docker-compose")).not.toBeNull();

    renderDockerPane(element, "tab-1", "acme", {
      ...view,
      composeProject: undefined,
      composeWorkingDir: undefined,
    });

    expect(element.querySelector(".workspace-docker-compose")).toBeNull();
  });

  it("keeps exactly one compose bar across repeated renders", () => {
    const element = host();
    renderDockerPane(element, "tab-1", "acme", view);
    renderDockerPane(element, "tab-1", "acme", view);

    expect(element.querySelectorAll(".workspace-docker-compose")).toHaveLength(1);
  });

  it("marks a configured container Docker does not have", () => {
    const element = host();
    renderDockerPane(element, "tab-1", "acme", view);

    const row = element.querySelectorAll(".workspace-docker-row")[1] as HTMLElement;
    expect(row.classList.contains("workspace-docker-row--missing")).toBe(true);
  });

  it("shows compose controls when there is one compose project", () => {
    const element = host();
    renderDockerPane(element, "tab-1", "acme", view);

    expect(element.querySelector(".workspace-docker-compose")).not.toBeNull();
  });

  it("hides compose controls when there is not", () => {
    const element = host();
    renderDockerPane(element, "tab-1", "acme", {
      ...view,
      composeProject: undefined,
      composeWorkingDir: undefined,
    });

    expect(element.querySelector(".workspace-docker-compose")).toBeNull();
  });

  it("confirms before stopping, and does nothing when refused", () => {
    const stop = vi.fn();
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis = { dockerStop: stop };
    vi.spyOn(window, "confirm").mockReturnValue(false);

    const element = host();
    renderDockerPane(element, "tab-1", "acme", view);
    const button = [...element.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Stop the container");
    button?.click();

    expect(stop).not.toHaveBeenCalled();
  });

  it("stops once the confirmation is accepted", () => {
    const stop = vi.fn(() => Promise.resolve({ ok: true, value: undefined }));
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis = { dockerStop: stop };
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const element = host();
    renderDockerPane(element, "tab-1", "acme", view);
    const button = [...element.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Stop the container");
    button?.click();

    expect(stop).toHaveBeenCalledWith("acme", "acme-app-1");
  });

  it("starts without asking", () => {
    const start = vi.fn(() => Promise.resolve({ ok: true, value: undefined }));
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis = { dockerStart: start };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    const element = host();
    renderDockerPane(element, "tab-1", "acme", {
      ...view,
      rows: [{ ...view.rows[0]!, facts: { ...view.rows[0]!.facts!, state: "exited", status: "exited" } }],
    });
    [...element.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Start the container")?.click();

    expect(start).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("surfaces a failed action in the shared status line", async () => {
    const stop = vi.fn(() =>
      Promise.resolve({ ok: false as const, text: "The container is gone.", language: "en" as const }),
    );
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis = { dockerStop: stop };
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const element = host();
    renderDockerPane(element, "tab-1", "acme", view);
    const button = [...element.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Stop the container");
    button?.click();
    await flush();

    expect(document.getElementById("workspace-tool-status")?.textContent).toBe("The container is gone.");
  });

  it("leaves the status line alone when the action succeeds", async () => {
    const start = vi.fn(() => Promise.resolve({ ok: true as const, value: undefined }));
    (window as unknown as { jarvis: Record<string, unknown> }).jarvis = { dockerStart: start };

    const element = host();
    renderDockerPane(element, "tab-1", "acme", {
      ...view,
      rows: [{ ...view.rows[0]!, facts: { ...view.rows[0]!.facts!, state: "exited", status: "exited" } }],
    });
    [...element.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Start the container")?.click();
    await flush();

    expect(document.getElementById("workspace-tool-status")?.textContent).toBe("");
  });
});

describe("toTerminalText", () => {
  // `docker logs` is spawned on a pipe, not a pty, so its lines arrive with a
  // bare LF. Written to xterm unchanged they render as a staircase: each line
  // starts at the column the previous one ended on. Found by driving the real
  // app — jsdom cannot render xterm, so no pane-level test can see it.
  it("gives a bare LF the CR a terminal needs", () => {
    expect(toTerminalText("line one\nline two\n")).toBe("line one\r\nline two\r\n");
  });

  it("leaves an existing CRLF alone rather than doubling it", () => {
    expect(toTerminalText("line one\r\nline two\r\n")).toBe("line one\r\nline two\r\n");
  });

  it("passes through a chunk with no line ending", () => {
    expect(toTerminalText("partial line")).toBe("partial line");
  });

  it("does not invent a newline for a lone CR", () => {
    expect(toTerminalText("progress\r")).toBe("progress\r");
  });
});

describe("the pane's heading", () => {
  it("counts the running containers against the declared total", () => {
    const element = host();
    renderDockerPane(element, "tab-1", "acme", view);

    expect(element.querySelector(".workspace-docker-count")?.textContent).toBe("1 of 2 running");
  });

  it("counts a declared container Docker does not have as not running", () => {
    const element = host();
    renderDockerPane(element, "tab-1", "acme", {
      ...view,
      rows: [view.rows[1]!, view.rows[1]!],
    });

    expect(element.querySelector(".workspace-docker-count")?.textContent).toBe("0 of 2 running");
  });
});

describe("the row's state dot", () => {
  it("marks a running container with the good state", () => {
    const element = host();
    renderDockerPane(element, "tab-1", "acme", view);

    const dot = element.querySelectorAll(".workspace-docker-row")[0]?.querySelector(".dot");
    expect(dot?.className).toContain("dot--running");
  });

  it("marks a stopped container distinctly from a running one", () => {
    const element = host();
    renderDockerPane(element, "tab-1", "acme", {
      ...view,
      rows: [{ ...view.rows[0]!, facts: { ...view.rows[0]!.facts!, state: "exited" } }],
    });

    const dot = element.querySelector(".workspace-docker-row .dot");
    expect(dot?.className).toContain("dot--stopped");
    expect(dot?.className).not.toContain("dot--running");
  });

  it("marks a container Docker does not have as missing", () => {
    const element = host();
    renderDockerPane(element, "tab-1", "acme", view);

    const dot = element.querySelectorAll(".workspace-docker-row")[1]?.querySelector(".dot");
    expect(dot?.className).toContain("dot--missing");
  });
});

describe("the log pane's empty state", () => {
  it("says nothing is selected before a row is picked", () => {
    const element = host();
    renderDockerPane(element, "tab-2", "acme", view);

    expect(element.querySelector(".workspace-docker-empty")?.textContent).toBe(
      "No container selected",
    );
  });

  it("keeps the empty state out of the way once a row is selected", () => {
    const element = host();
    renderDockerPane(element, "tab-3", "acme", view);
    (element.querySelector(".workspace-docker-row") as HTMLElement).click();

    expect(element.querySelector(".workspace-docker-empty")).toBeNull();
  });
});
