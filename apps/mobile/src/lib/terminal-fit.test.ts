import { describe, expect, it } from "vitest";
import { createTerminalFit, type FitSendResult, type TerminalSize } from "./terminal-fit";

type Sent = {
  size: TerminalSize;
  mode: "fit" | "restore";
  answer(result: FitSendResult): Promise<void>;
};

function setup() {
  const sent: Sent[] = [];
  const restored: TerminalSize[] = [];
  let openListener: (() => void) | undefined;
  const fit = createTerminalFit({
    send: (size, mode) =>
      new Promise<FitSendResult>((resolve) => {
        sent.push({
          size,
          mode,
          answer: async (result) => {
            resolve(result);
            // Let the .then() handlers run.
            await Promise.resolve();
            await Promise.resolve();
          },
        });
      }),
    watchOpen: (listener) => {
      openListener = listener;
      return () => {
        openListener = undefined;
      };
    },
    restored: (size) => restored.push(size),
  });
  const reopen = () => openListener?.();
  const calls = () => sent.map(({ size, mode }) => ({ ...size, mode }));
  return { fit, sent, restored, reopen, calls };
}

const OK = { ok: true } as const;
const FAIL = { ok: false } as const;
const DESKTOP = { cols: 200, rows: 50 };
const PHONE = { cols: 48, rows: 40 };

describe("createTerminalFit", () => {
  it("starts off and sends nothing for page sizes while off", () => {
    const { fit, sent } = setup();
    fit.pageSize(PHONE);
    expect(fit.isOn()).toBe(false);
    expect(sent).toEqual([]);
  });

  it("cannot turn on before the pty's size is known (nothing to restore to)", () => {
    const { fit } = setup();
    expect(fit.enable(undefined)).toBe(false);
    expect(fit.isOn()).toBe(false);
  });

  it("on: sends each new page size once it lands, never a repeat", async () => {
    const { fit, sent, calls } = setup();
    expect(fit.enable(DESKTOP)).toBe(true);
    fit.pageSize(PHONE);
    fit.pageSize(PHONE); // in flight: not sent twice
    await sent[0]?.answer(OK);
    fit.pageSize(PHONE);
    fit.pageSize({ cols: 48, rows: 22 });
    expect(calls()).toEqual([
      { ...PHONE, mode: "fit" },
      { cols: 48, rows: 22, mode: "fit" },
    ]);
  });

  it("a size changed while one is in flight goes out once that one lands", async () => {
    const { fit, sent, calls } = setup();
    fit.enable(DESKTOP);
    fit.pageSize(PHONE);
    fit.pageSize({ cols: 48, rows: 22 });
    await sent[0]?.answer(OK);
    expect(calls()).toEqual([
      { ...PHONE, mode: "fit" },
      { cols: 48, rows: 22, mode: "fit" },
    ]);
  });

  it("a rejected fit size is sent again on the next open", async () => {
    const { fit, sent, calls, reopen } = setup();
    fit.enable(DESKTOP);
    fit.pageSize(PHONE);
    await sent[0]?.answer(FAIL);
    expect(sent).toHaveLength(1);
    reopen();
    expect(calls()).toEqual([
      { ...PHONE, mode: "fit" },
      { ...PHONE, mode: "fit" },
    ]);
  });

  it("off: restores the desktop size, keeping it until the host says the pty has it", async () => {
    const { fit, sent, restored, calls } = setup();
    fit.enable(DESKTOP);
    fit.pageSize(PHONE);
    await sent[0]?.answer(OK);
    expect(fit.disable()).toEqual(DESKTOP);
    expect(fit.isOn()).toBe(false);
    expect(calls().at(-1)).toEqual({ ...DESKTOP, mode: "restore" });
    await sent[1]?.answer({ ok: true, size: { cols: 210, rows: 52 } });
    expect(restored).toEqual([{ cols: 210, rows: 52 }]);
    fit.pageSize(PHONE);
    expect(sent).toHaveLength(2);
  });

  it("a restore that fails is sent again on the next open", async () => {
    const { fit, sent, restored, calls, reopen } = setup();
    fit.enable(DESKTOP);
    fit.disable();
    await sent[0]?.answer(FAIL);
    expect(restored).toEqual([]);
    reopen();
    expect(calls()).toEqual([
      { ...DESKTOP, mode: "restore" },
      { ...DESKTOP, mode: "restore" },
    ]);
    await sent[1]?.answer(OK);
    expect(restored).toEqual([DESKTOP]);
  });

  it("off when already off sends nothing", () => {
    const { fit, sent } = setup();
    expect(fit.disable()).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("a reported pty size that is its own echo changes nothing", async () => {
    const { fit, sent } = setup();
    fit.enable(DESKTOP);
    fit.pageSize(PHONE);
    await sent[0]?.answer(OK);
    expect(fit.ptyReported(PHONE)).toBe(false);
    expect(fit.isOn()).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("the desktop's size reported while on means the fit never held: sent again", async () => {
    const { fit, sent, calls } = setup();
    fit.enable(DESKTOP);
    fit.pageSize(PHONE);
    await sent[0]?.answer(OK);
    expect(fit.ptyReported(DESKTOP)).toBe(false);
    expect(fit.isOn()).toBe(true);
    expect(calls()).toEqual([
      { ...PHONE, mode: "fit" },
      { ...PHONE, mode: "fit" },
    ]);
  });

  it("another size reported while on means the desktop resized: off, nothing sent back", async () => {
    const { fit, sent } = setup();
    fit.enable(DESKTOP);
    fit.pageSize(PHONE);
    await sent[0]?.answer(OK);
    expect(fit.ptyReported({ cols: 160, rows: 45 })).toBe(true);
    expect(fit.isOn()).toBe(false);
    expect(fit.disable()).toBeUndefined();
    expect(sent).toHaveLength(1);
  });
});
