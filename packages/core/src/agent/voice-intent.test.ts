import { describe, expect, it } from "vitest";
import type { Card, CardItem } from "./contract.js";
import { classifyUtterance, decideVoiceAction } from "./voice-intent.js";

const item = (id: string, over: Partial<CardItem> = {}): CardItem => ({
  itemId: id,
  tool: "settings.brightness",
  title: "Set brightness to 80%",
  detail: "",
  source: "system",
  risk: "confirm",
  secretFields: [],
  ...over,
});
const card = (items: CardItem[], cardId = "c1"): Card => ({
  cardId,
  turnId: "t1",
  expiresAt: 0,
  items,
});

describe("classifyUtterance", () => {
  it("matches only the short phrases, in English and Arabic", () => {
    expect(classifyUtterance("Yes.")).toBe("approve");
    expect(classifyUtterance("نَعَم")).toBe("approve");
    expect(classifyUtterance("موافق!")).toBe("approve");
    expect(classifyUtterance("No")).toBe("deny");
    expect(classifyUtterance("لا")).toBe("deny");
    expect(classifyUtterance("Stop")).toBe("stop");
    expect(classifyUtterance("yes, and delete my downloads too")).toBe("other");
    expect(classifyUtterance("no idea what that means")).toBe("other");
    expect(classifyUtterance("yesterday")).toBe("other");
  });
});

describe("decideVoiceAction (design §3.2: unlocked + card visible + short phrases)", () => {
  const open = card([item("item-1"), item("item-2")]);

  it("approves the visible card with every item, or with the shell's ticks", () => {
    expect(decideVoiceAction({ text: "yes", cardId: "c1", card: open, locked: false })).toEqual({
      action: "approve",
      cardId: "c1",
      ticked: ["item-1", "item-2"],
    });
    expect(
      decideVoiceAction({
        text: "yes",
        cardId: "c1",
        ticked: ["item-2", "item-9"],
        card: open,
        locked: false,
      }),
    ).toEqual({ action: "approve", cardId: "c1", ticked: ["item-2"] });
  });

  it("denies the visible card", () => {
    expect(decideVoiceAction({ text: "لا", cardId: "c1", card: open, locked: false })).toEqual({
      action: "deny",
      cardId: "c1",
    });
  });

  it("never answers a card while locked", () => {
    expect(decideVoiceAction({ text: "yes", cardId: "c1", card: open, locked: true })).toEqual({
      action: "ignored",
      reason: "locked",
    });
    expect(decideVoiceAction({ text: "no", cardId: "c1", card: open, locked: true })).toEqual({
      action: "ignored",
      reason: "locked",
    });
  });

  it("a stale card id is ignored, never a prompt", () => {
    expect(
      decideVoiceAction({ text: "yes", cardId: "c0", card: undefined, locked: false }),
    ).toEqual({
      action: "ignored",
      reason: "no-card",
    });
    expect(decideVoiceAction({ text: "yes", cardId: "c0", card: open, locked: false })).toEqual({
      action: "ignored",
      reason: "no-card",
    });
  });

  it("never approves a password card or a card that needs typed input", () => {
    const password = card([item("item-1", { risk: "password", tool: "users.add" })]);
    const wifi = card([
      item("item-1", { secretFields: [{ name: "password", label: "Wi-Fi password" }] }),
    ]);
    expect(decideVoiceAction({ text: "yes", cardId: "c1", card: password, locked: false })).toEqual(
      {
        action: "ignored",
        reason: "password-card",
      },
    );
    expect(decideVoiceAction({ text: "yes", cardId: "c1", card: wifi, locked: false })).toEqual({
      action: "ignored",
      reason: "card-needs-input",
    });
    expect(decideVoiceAction({ text: "no", cardId: "c1", card: password, locked: false })).toEqual({
      action: "deny",
      cardId: "c1",
    });
    expect(
      decideVoiceAction({ text: "yes", cardId: "c1", ticked: [], card: open, locked: false }),
    ).toEqual({ action: "ignored", reason: "card-needs-input" });
  });

  it("treats yes/no with no visible card, and everything else, as a prompt", () => {
    expect(decideVoiceAction({ text: "yes", card: undefined, locked: false })).toEqual({
      action: "prompt",
      text: "yes",
    });
    expect(
      decideVoiceAction({
        text: "make the screen brighter",
        cardId: "c1",
        card: open,
        locked: true,
      }),
    ).toEqual({ action: "prompt", text: "make the screen brighter" });
  });

  it("stops, and ignores silence", () => {
    expect(decideVoiceAction({ text: "stop", cardId: "c1", card: open, locked: false })).toEqual({
      action: "stop",
    });
    expect(decideVoiceAction({ text: " [BLANK_AUDIO] ", card: undefined, locked: false })).toEqual({
      action: "ignored",
      reason: "empty",
    });
  });
});
