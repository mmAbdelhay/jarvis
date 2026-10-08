import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { ControlDeps } from "./deps.js";
import { answersConnection } from "./liveness.js";

/** A connect that fails at once with `code`, the way node reports it. */
function failingNet(code: string): Pick<ControlDeps, "net"> {
  return {
    net: {
      connect: () => {
        const socket = Object.assign(new EventEmitter(), { destroy: () => {} });
        queueMicrotask(() =>
          socket.emit("error", Object.assign(new Error(`connect ${code}`), { code })),
        );
        return socket;
      },
    } as unknown as ControlDeps["net"],
  };
}

describe("answersConnection", () => {
  it.each(["ECONNREFUSED", "ENOENT", "ENOTSOCK"])("reads %s as nobody home", async (code) => {
    await expect(answersConnection("/run/jarvisd.sock", failingNet(code))).resolves.toBe(false);
  });

  // A socket path longer than the platform allows (104 bytes on macOS, 108
  // on Linux) — a deep HOME — fails connect with EINVAL. No daemon can be
  // listening there either: listen fails with the same EINVAL. Reading it
  // as "busy" made the app offer to stop a daemon that cannot exist.
  it("reads EINVAL, a socket path too long to bind, as nobody home", async () => {
    await expect(answersConnection("/run/jarvisd.sock", failingNet("EINVAL"))).resolves.toBe(false);
  });

  it("still reads any other failure as someone there", async () => {
    await expect(answersConnection("/run/jarvisd.sock", failingNet("EAGAIN"))).resolves.toBe(true);
  });
});
