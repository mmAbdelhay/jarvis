import { describe, expect, it } from "vitest";
import { createWebRefreshLock, REFRESH_LOCK_NAME } from "./web-refresh-lock";

describe("createWebRefreshLock", () => {
  it("runs each task under the named Web Lock and returns its result", async () => {
    const names: string[] = [];
    const lock = createWebRefreshLock({
      request(name, callback) {
        names.push(name);
        return callback();
      },
    });
    expect(await lock(async () => 7)).toBe(7);
    expect(names).toEqual([REFRESH_LOCK_NAME]);
    expect(REFRESH_LOCK_NAME).toBe("jarvis-refresh");
  });

  it("without navigator.locks runs the task directly", async () => {
    const lock = createWebRefreshLock(undefined);
    expect(await lock(async () => "done")).toBe("done");
  });

  it("passes a task's rejection through", async () => {
    const lock = createWebRefreshLock({ request: (_name, callback) => callback() });
    await expect(
      lock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
