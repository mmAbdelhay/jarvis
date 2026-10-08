import { describe, expect, it } from "vitest";
import { answerCard, parseCard, renderCard } from "./card.js";
import { cardItem, makeCard } from "./testing/cards.js";
import { FakeTerminal } from "./testing/fake-terminal.js";

const twoApps = () =>
  makeCard("c1", "t1", [
    cardItem("i1", "Install GIMP", "flathub", [], "Image editor · 312 MB"),
    cardItem("i2", "Install VLC", "debian"),
  ]);

describe("renderCard", () => {
  it("renders a numbered list with every item ticked", () => {
    const card = twoApps();
    expect(renderCard(card, new Set(["i1", "i2"]))).toBe(
      [
        "Jarvis needs your approval for 2 changes:",
        "  1. [x] Install GIMP  (Flathub)",
        "        Image editor · 312 MB",
        "  2. [x] Install VLC  (Debian)",
        "  a = approve ticked (2)   d = deny   1-2 = tick or untick",
        "",
      ].join("\n"),
    );
  });

  it("renders hostile titles inert", () => {
    const card = makeCard("c1", "t1", [
      cardItem("i1", "Install\u001b[2K\rRemove everything", "debian", [], "\u001b]0;x\u0007ok"),
    ]);
    const text = renderCard(card, new Set(["i1"]));
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\r");
    expect(text).toContain("1. [x] Install Remove everything  (Debian)");
  });
});

describe("answerCard", () => {
  it("approves the ticked items after a number unticks one", async () => {
    const term = new FakeTerminal({ lines: ["2", "a"] });
    const answer = await answerCard(term, twoApps());
    expect(answer).toEqual({ cardId: "c1", approve: true, ticked: ["i1"], secrets: {} });
    expect(term.output).toContain("2. [ ] Install VLC");
  });

  it("denies on d and at the end of input", async () => {
    const deny = { cardId: "c1", approve: false, ticked: [], secrets: {} };
    expect(await answerCard(new FakeTerminal({ lines: ["d"] }), twoApps())).toEqual(deny);
    expect(await answerCard(new FakeTerminal({ lines: [] }), twoApps())).toEqual(deny);
  });

  it("will not approve with nothing ticked", async () => {
    const card = makeCard("c1", "t1");
    const term = new FakeTerminal({ lines: ["1", "a", "d"] });
    const answer = await answerCard(term, card);
    expect(answer?.approve).toBe(false);
    expect(term.output).toContain("Nothing is ticked.");
  });

  it("asks secrets with no echo, only for ticked items", async () => {
    const card = makeCard("c1", "t1", [
      cardItem("i1", "Connect to home", "network", [{ name: "password", label: "Wi-Fi password" }]),
      cardItem("i2", "Connect to cafe", "network", [{ name: "password", label: "Wi-Fi password" }]),
    ]);
    const term = new FakeTerminal({ lines: ["2", "a"], secrets: ["pw-home"] });
    const answer = await answerCard(term, card);
    expect(answer).toEqual({
      cardId: "c1",
      approve: true,
      ticked: ["i1"],
      secrets: { i1: { password: "pw-home" } },
    });
    expect(term.secretPrompts).toEqual(["Connect to home — Wi-Fi password (hidden): "]);
    expect(term.output).not.toContain("pw-home");
  });

  it("an empty or cancelled secret keeps the card open", async () => {
    const card = makeCard("c1", "t1", [
      cardItem("i1", "Connect to home", "network", [{ name: "password", label: "Password" }]),
    ]);
    const term = new FakeTerminal({ lines: ["a", "a", "a"], secrets: ["", null, "pw"] });
    const answer = await answerCard(term, card);
    expect(answer?.secrets).toEqual({ i1: { password: "pw" } });
    expect(term.output.match(/Not approved\. The card is still open\./g)).toHaveLength(2);
  });

  it("never answers a card from piped input: denies without reading", async () => {
    const term = new FakeTerminal({ interactive: false, lines: ["a"], secrets: ["pw"] });
    const answer = await answerCard(term, twoApps());
    expect(answer).toEqual({ cardId: "c1", approve: false, ticked: [], secrets: {} });
    expect(term.prompts).toEqual([]);
    expect(term.output).toContain("interactive terminal");
  });

  it("stops waiting when the card is closed elsewhere", async () => {
    const abort = new AbortController();
    const term = new FakeTerminal();
    const pending = answerCard(term, twoApps(), { signal: abort.signal });
    abort.abort();
    await expect(pending).resolves.toBeNull();
  });

  it("an expired card sends nothing", async () => {
    const card = twoApps();
    const term = new FakeTerminal({ lines: ["a"] });
    const answer = await answerCard(term, card, { now: () => card.expiresAt + 1 });
    expect(answer).toBeNull();
    expect(term.output).toContain("This card expired. Nothing was changed.");
  });

  it("explains unknown keys and missing item numbers", async () => {
    const term = new FakeTerminal({ lines: ["x", "9", "d"] });
    await answerCard(term, twoApps());
    expect(term.output).toContain("Type a to approve, d to deny, or an item number.");
    expect(term.output).toContain("There is no item 9.");
  });
});

describe("parseCard", () => {
  it("accepts a contract card", () => {
    expect(parseCard(twoApps())).toEqual(expect.objectContaining({ cardId: "c1", turnId: "t1" }));
  });

  it("refuses broken cards", () => {
    const good = twoApps();
    expect(parseCard(null)).toBeUndefined();
    expect(parseCard({ ...good, cardId: "" })).toBeUndefined();
    expect(parseCard({ ...good, items: [] })).toBeUndefined();
    expect(parseCard({ ...good, items: [good.items[0], good.items[0]] })).toBeUndefined();
    expect(parseCard({ ...good, items: [{ ...good.items[0], source: "pypi" }] })).toBeUndefined();
    expect(parseCard({ ...good, items: [{ ...good.items[0], risk: "safe" }] })).toBeUndefined();
    expect(
      parseCard({ ...good, items: [{ ...good.items[0], secretFields: undefined }] }),
    ).toBeUndefined();
    const many = Array.from({ length: 201 }, (_, i) => cardItem(`i${i}`, `App ${i}`));
    expect(parseCard({ ...good, items: many })).toBeUndefined();
    expect(parseCard({ ...good, items: many.slice(0, 200) })?.items).toHaveLength(200);
  });
});
