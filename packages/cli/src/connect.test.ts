import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectJarvis, NotRunningError, readBuildStamp } from "./connect.js";
import { MISSING_STAMP, TEST_BUILD, type TestDaemon, testDaemons } from "./testing/daemon.js";

const daemons = testDaemons();

describe("readBuildStamp", () => {
  it("reads {build} and answers empty for a missing or broken stamp", async () => {
    const dir = await mkdtemp(join("/tmp", "jcli-stamp-"));
    try {
      await writeFile(join(dir, "good.json"), JSON.stringify({ build: "0.3.0+abc" }));
      await writeFile(join(dir, "bad.json"), "{not json");
      await writeFile(join(dir, "odd.json"), JSON.stringify({ build: 7 }));
      expect(await readBuildStamp(join(dir, "good.json"))).toBe("0.3.0+abc");
      expect(await readBuildStamp(join(dir, "bad.json"))).toBe("");
      expect(await readBuildStamp(join(dir, "odd.json"))).toBe("");
      expect(await readBuildStamp(join(dir, "missing.json"))).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("connectJarvis", () => {
  it("reaches jarvisd without a build stamp: restart-required, then the daemon's build", async () => {
    const d: TestDaemon = await daemons.start((channel) =>
      channel === "provider:list" ? { providers: [] } : null,
    );
    const client = await connectJarvis(
      {},
      { runDirectory: d.runDirectory, buildStampPath: MISSING_STAMP },
    );
    try {
      expect(await client.invoke("provider:list", [])).toEqual({ providers: [] });
    } finally {
      client.close();
    }
  });

  it("uses JARVIS_BUILD_STAMP when it matches the daemon", async () => {
    const d: TestDaemon = await daemons.start(() => "pong");
    const dir = await mkdtemp(join("/tmp", "jcli-stamp-"));
    try {
      const stamp = join(dir, "build-stamp.json");
      await writeFile(stamp, JSON.stringify({ build: TEST_BUILD }));
      const client = await connectJarvis(
        { JARVIS_BUILD_STAMP: stamp },
        { runDirectory: d.runDirectory },
      );
      expect(await client.invoke("test:ping", [])).toBe("pong");
      client.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("explains a daemon that is not running", async () => {
    const attempt = connectJarvis(
      {},
      { runDirectory: "/tmp/jcli-nobody-home/run", buildStampPath: MISSING_STAMP },
    );
    await expect(attempt).rejects.toBeInstanceOf(NotRunningError);
    await expect(attempt).rejects.toThrow("systemctl --user start jarvisd");
  });
});
