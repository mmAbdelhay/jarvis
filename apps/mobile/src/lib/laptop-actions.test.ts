import { describe, expect, it, vi } from "vitest";
import {
  canResume,
  closeLaptopTab,
  noticeText,
  parseResumeReply,
  renameLaptopTab,
  resumeSession,
  validateTabTitle,
} from "./laptop-actions";
import { isLaptopTabId } from "./workspace-tabs";

type Reply = { ok: true; value: unknown } | { ok: false; error: unknown };
function fake(reply: Reply) {
  const call = vi.fn(async () => reply);
  return { call } as unknown as { call: typeof call } & Parameters<typeof closeLaptopTab>[0];
}

describe("validateTabTitle", () => {
  it("accepts 1..80 characters and refuses blank, long and control text", () => {
    expect(validateTabTitle("api")).toBeUndefined();
    expect(validateTabTitle("x".repeat(80))).toBeUndefined();
    expect(validateTabTitle("   ")).toBe("empty");
    expect(validateTabTitle("")).toBe("empty");
    expect(validateTabTitle("x".repeat(81))).toBe("tooLong");
    expect(validateTabTitle("a\nb")).toBe("control");
    expect(validateTabTitle("a\u0007b")).toBe("control");
    expect(validateTabTitle("a\u202Eb")).toBe("control");
    expect(validateTabTitle("a\u2066b")).toBe("control");
  });
});

describe("workspace actions", () => {
  it("closes by id and renames with the id and title", async () => {
    const client = fake({ ok: true, value: undefined });
    expect(await closeLaptopTab(client, "t1")).toEqual({ ok: true });
    expect(client.call).toHaveBeenCalledWith("workspace:close", ["t1"], expect.anything());
    expect(await renameLaptopTab(client, "t1", "logs")).toEqual({ ok: true });
    expect(client.call).toHaveBeenLastCalledWith(
      "workspace:rename",
      ["t1", "logs"],
      expect.anything(),
    );
  });

  it("never calls the laptop with an invalid title", async () => {
    const client = fake({ ok: true, value: undefined });
    expect(await renameLaptopTab(client, "t1", " ")).toEqual({ ok: false, text: "rename.empty" });
    expect(client.call).not.toHaveBeenCalled();
  });

  it("returns the laptop's own text, or a generic key for a transport failure", async () => {
    const remote = fake({ ok: false, error: { kind: "remote", text: "No such tab" } });
    expect(await closeLaptopTab(remote, "x")).toEqual({ ok: false, text: "No such tab" });
    const offline = fake({ ok: false, error: { kind: "offline" } });
    expect(await closeLaptopTab(offline, "x")).toEqual({ ok: false, text: "common.loadFailed" });
  });

  it("tells keys from verbatim text", () => {
    expect(noticeText("en", "rename.empty")).toBe("The name can't be blank.");
    expect(noticeText("ar", "rename.empty")).not.toBe(noticeText("en", "rename.empty"));
    expect(noticeText("en", "No such tab")).toBe("No such tab");
  });

  it("separates laptop tabs from phone-only tools", () => {
    expect(isLaptopTabId("tab-1")).toBe(true);
    expect(isLaptopTabId("tool:docker")).toBe(false);
  });
});

describe("resume", () => {
  it("is offered only once a session has ended", () => {
    expect(canResume("done")).toBe(true);
    expect(canResume("dead")).toBe(true);
    expect(canResume("running")).toBe(false);
    expect(canResume(undefined)).toBe(false);
  });

  it("parses the success and refusal replies field by field", () => {
    expect(
      parseResumeReply({ ok: true, project: "p", tabId: "t9", language: "en", extra: 1 }),
    ).toEqual({
      ok: true,
      tabId: "t9",
    });
    expect(parseResumeReply({ ok: false, text: "Nothing to resume", language: "en" })).toEqual({
      ok: false,
      text: "Nothing to resume",
    });
    expect(parseResumeReply({ ok: true, tabId: 5 })).toEqual({
      ok: false,
      text: "common.loadFailed",
    });
    expect(parseResumeReply("ok")).toEqual({ ok: false, text: "common.loadFailed" });
  });

  it("sends the session id, and the project only when known", async () => {
    const client = fake({
      ok: true,
      value: { ok: true, project: "p", tabId: "t2", language: "en" },
    });
    expect(await resumeSession(client, "s1", "web")).toEqual({ ok: true, tabId: "t2" });
    expect(client.call).toHaveBeenCalledWith("session:resume", ["s1", "web"], expect.anything());
    await resumeSession(client, "s1", null);
    expect(client.call).toHaveBeenLastCalledWith("session:resume", ["s1"], expect.anything());
  });
});
