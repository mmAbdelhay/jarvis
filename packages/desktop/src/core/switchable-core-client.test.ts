import { describe, expect, it } from "vitest";
import type { WorkspaceState } from "@jarvis/core";
import type { PushSink } from "../broadcast.js";
import type { CoreClient, DesktopHost } from "./core-client.js";
import { switchableCoreClient } from "./switchable-core-client.js";
import type { ViewRequest } from "./tab-host.js";

function fakeClient(name: string, state: WorkspaceState) {
  const pushes = new Set<PushSink>();
  const changes = new Set<(state: WorkspaceState) => void>();
  const views = new Set<(request: ViewRequest) => void>();
  const calls: string[] = [];
  const hosts: DesktopHost[] = [];
  const client: CoreClient = {
    firstRun: name === "a",
    hostConfig: () => ({ allowPopups: name === "a", suspendTabsAfterMs: 0 }),
    invoke: async (channel, args) => {
      calls.push(`${channel}(${JSON.stringify(args)})`);
      return name;
    },
    onPush(listener) {
      pushes.add(listener);
      return () => pushes.delete(listener);
    },
    broadcast: (channel) => calls.push(`broadcast ${channel}`),
    workspace: {
      state: () => state,
      onChange(listener) {
        changes.add(listener);
        return () => changes.delete(listener);
      },
      onViewRequest(listener) {
        views.add(listener);
        return () => views.delete(listener);
      },
      reportPage: (id) => calls.push(`reportPage ${id}`),
      suspend: (id) => calls.push(`suspend ${id}`),
      open: (project) => calls.push(`open ${project}`),
    },
    favicons: {
      put: async () => ({ ok: true, value: undefined }),
      putMiss: async () => ({ ok: true, value: undefined }),
    },
    attachHost(host) {
      hosts.push(host);
      return () => {
        hosts.splice(hosts.indexOf(host), 1);
      };
    },
    voice: { start: () => calls.push("voice start"), stop: () => calls.push("voice stop") },
    dbgateCredentialFor: async () => undefined,
    startRemote: () => calls.push("startRemote"),
    announceStartup: async () => {
      calls.push("announceStartup");
    },
    stop: () => calls.push("stop"),
  };
  return { client, pushes, changes, views, calls, hosts };
}

const stateA = { tabs: [{ id: "tab-1" }] } as unknown as WorkspaceState;
const stateB = { tabs: [{ id: "tab-9" }] } as unknown as WorkspaceState;
const host = { isFocused: () => true } as unknown as DesktopHost;

describe("switchable CoreClient", () => {
  it("moves pushes, tab listeners and the host to the new client, and hands over its state", async () => {
    const a = fakeClient("a", stateA);
    const b = fakeClient("b", stateB);
    const client = switchableCoreClient(a.client, () => {});
    const pushed: string[] = [];
    const states: WorkspaceState[] = [];
    const requests: ViewRequest[] = [];
    client.onPush((channel) => pushed.push(channel));
    client.workspace.onChange((state) => states.push(state));
    client.workspace.onViewRequest((request) => requests.push(request));
    client.attachHost(host);
    expect(client.firstRun).toBe(true);
    expect(await client.invoke("settings:read", [])).toBe("a");

    for (const push of a.pushes) push("turn:new", {} as never);
    client.switchTo(b.client);

    expect(a.pushes.size + a.changes.size + a.views.size + a.hosts.length).toBe(0);
    expect(b.hosts).toEqual([host]);
    expect(states).toEqual([stateB]);
    expect(client.workspace.state()).toBe(stateB);
    expect(await client.invoke("settings:read", [])).toBe("b");
    expect(client.hostConfig().allowPopups).toBe(false);
    // firstRun is the launch's: the window was built with it.
    expect(client.firstRun).toBe(true);

    for (const push of b.pushes) push("remote:update", {} as never);
    for (const change of b.changes) change(stateA);
    for (const view of b.views) view({ id: "x" } as unknown as ViewRequest);
    expect(pushed).toEqual(["turn:new", "remote:update"]);
    expect(states).toEqual([stateB, stateA]);
    expect(requests).toHaveLength(1);

    client.voice.start();
    client.workspace.suspend("tab-9");
    client.stop();
    expect(b.calls).toContain("voice start");
    expect(b.calls).toContain("suspend tab-9");
    expect(b.calls).toContain("stop");
    // Stopping what was switched away from is the caller's business.
    expect(a.calls).not.toContain("stop");
  });

  it("detaches the host from whichever client holds it, and not a newer host", () => {
    const a = fakeClient("a", stateA);
    const b = fakeClient("b", stateB);
    const client = switchableCoreClient(a.client, () => {});
    const detach = client.attachHost(host);
    client.switchTo(b.client);
    detach();
    expect(b.hosts).toEqual([]);

    const other = { isFocused: () => false } as unknown as DesktopHost;
    const detachFirst = client.attachHost(host);
    client.attachHost(other);
    detachFirst();
    expect(b.hosts).toEqual([other]);
  });

  it("keeps going when a tab listener throws", () => {
    const a = fakeClient("a", stateA);
    const b = fakeClient("b", stateB);
    const lines: string[] = [];
    const client = switchableCoreClient(a.client, (line) => lines.push(line));
    const seen: WorkspaceState[] = [];
    client.workspace.onChange(() => {
      throw new Error("boom");
    });
    client.workspace.onChange((state) => seen.push(state));
    client.switchTo(b.client);
    expect(seen).toEqual([stateB]);
    expect(lines).toEqual(["workspace listener failed: boom"]);
  });
});
