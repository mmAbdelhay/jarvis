// @vitest-environment jsdom
//
// The composer: sending, queueing, stopping, the mode and model menus, the `/`
// and `@` listboxes, history, drafts and attachments.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageKey } from "../../src/messages.js";
import { agentView, open, press, settle, t, typeInto, type Setup } from "./fixture.js";
import { prettyModel } from "./composer.js";

beforeEach(() => {
  document.body.replaceChildren();
});

const input = (s: Setup) => s.q<HTMLTextAreaElement>(".agent-chat__input");
const send = (s: Setup) => s.api.terminalAgentSend as unknown as ReturnType<typeof vi.fn>;
const file = (name: string, type = "image/png", bytes = [1, 2, 3]) =>
  new File([new Uint8Array(bytes)], name, { type });

describe("sending", () => {
  it("sends on Enter, clears the box and looks again", async () => {
    const s = await open();
    typeInto(s, "run the tests");
    const event = press(input(s), "Enter");
    expect(event.defaultPrevented).toBe(true);
    await settle();
    expect(send(s)).toHaveBeenCalledWith("t1", "run the tests");
    expect(input(s).value).toBe("");
  });

  it("leaves Shift+Enter and IME composition alone, and never sends an empty message", async () => {
    const s = await open();
    typeInto(s, "line one");
    expect(press(input(s), "Enter", { shiftKey: true }).defaultPrevented).toBe(false);
    press(input(s), "Enter", { isComposing: true });
    typeInto(s, "   ");
    press(input(s), "Enter");
    await settle();
    expect(send(s)).not.toHaveBeenCalled();
  });

  it("keeps the text and says why when a send is refused, the agent's own draft included", async () => {
    const s = await open();
    for (const [reason, key] of [
      ["prompt", "agentChatSendPrompt"],
      ["draft", "agentChatSendDraft"],
      ["gone", "agentChatSendGone"],
      ["invalid", "agentChatSendInvalid"],
    ] as const) {
      send(s).mockResolvedValueOnce({ ok: false, reason });
      typeInto(s, "keep me");
      press(input(s), "Enter");
      await settle();
      expect(input(s).value).toBe("keep me");
      expect(s.q(".agent-chat__note").textContent).toBe(t(key as MessageKey));
    }
    send(s).mockRejectedValueOnce(new Error("ipc"));
    press(input(s), "Enter");
    await settle();
    expect(input(s).value).toBe("keep me");
    expect(s.q(".agent-chat__note").textContent).toBe(t("agentChatSendFailed"));
  });

  it("sends once while a send is in flight", async () => {
    const s = await open();
    let release: (value: { ok: true }) => void = () => {};
    send(s).mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    typeInto(s, "once");
    press(input(s), "Enter");
    expect(s.q<HTMLButtonElement>(".agent-chat__send").disabled).toBe(true);
    press(input(s), "Enter");
    release({ ok: true });
    await settle();
    expect(send(s)).toHaveBeenCalledTimes(1);
    expect(s.q<HTMLButtonElement>(".agent-chat__send").disabled).toBe(false);
  });

  it("hands keys to the pane first, so the palette and splits keep working", async () => {
    const chatKey = vi.fn((event: KeyboardEvent) => event.key !== "p");
    const s = await open(agentView(), { chatKey });
    const claimed = press(input(s), "p", { metaKey: true });
    expect(chatKey).toHaveBeenCalled();
    expect(claimed.defaultPrevented).toBe(false);
    typeInto(s, "x");
    press(input(s), "Enter");
    await settle();
    expect(send(s)).toHaveBeenCalledTimes(1);
  });

  it("is locked only while a question is up, and says so", async () => {
    const s = await open(
      agentView({
        prompt: {
          kind: "single",
          question: "Proceed?",
          options: [{ label: "Yes", highlighted: true }],
        },
      }),
    );
    expect(input(s).disabled).toBe(true);
    expect(s.q<HTMLButtonElement>(".agent-chat__send").disabled).toBe(true);
    expect(input(s).placeholder).toBe(t("agentChatComposerLocked"));
    s.current.view = agentView();
    s.chat.refresh();
    await settle();
    expect(input(s).disabled).toBe(false);
  });

  it("grows with its text (up to a limit) and sets its height from the content", async () => {
    const s = await open();
    Object.defineProperty(input(s), "scrollHeight", { configurable: true, get: () => 90 });
    typeInto(s, "a\nb\nc");
    expect(input(s).style.height).toBe("90px");
    Object.defineProperty(input(s), "scrollHeight", { configurable: true, get: () => 900 });
    typeInto(s, "x");
    expect(input(s).style.height).toBe("220px");
  });
});

describe("queue, stop, mode and model", () => {
  it("says Queue while the agent works and can queue, and refuses to send to one that cannot", async () => {
    const busy = await open(agentView({ working: "Working…" }));
    expect(busy.q(".agent-chat__send").textContent).toBe(t("agentChatQueue"));
    typeInto(busy, "later");
    press(input(busy), "Enter");
    await settle();
    expect(send(busy)).toHaveBeenCalledWith("t1", "later");

    const noQueue = await open(
      agentView({ working: "Working…", caps: { ...agentView().caps, queue: false } }),
    );
    expect(noQueue.q(".agent-chat__send").textContent).toBe(t("agentChatSend"));
    typeInto(noQueue, "now");
    press(input(noQueue), "Enter");
    await settle();
    expect(send(noQueue)).not.toHaveBeenCalled();
    expect(noQueue.q(".agent-chat__note").textContent).toBe(t("agentChatBusyNoQueue"));
  });

  it("shows Stop only while working and only where the vendor has it, and says why a stop failed", async () => {
    const idle = await open();
    expect(idle.q<HTMLElement>(".ac-stop").hidden).toBe(true);
    const copilot = await open(
      agentView({ working: "Working…", caps: { ...agentView().caps, stop: false } }),
    );
    expect(copilot.q<HTMLElement>(".ac-stop").hidden).toBe(true);
    const s = await open(agentView({ working: "Crunching…" }));
    s.q<HTMLButtonElement>(".ac-stop").click();
    await settle();
    expect(s.api.terminalAgentStop).toHaveBeenCalledWith("t1");
    s.api.terminalAgentStop.mockResolvedValueOnce({ ok: false, reason: "draft" } as never);
    s.q<HTMLButtonElement>(".ac-stop").click();
    await settle();
    expect(s.q(".agent-chat__note").textContent).toBe(t("agentChatStopDraft"));
  });

  it("switches mode from a listbox and reports a refusal", async () => {
    const s = await open();
    const button = s.q<HTMLButtonElement>(".ac-modebutton");
    expect(button.textContent).toBe("Plan");
    button.click();
    const menu = s.q<HTMLElement>(".ac-menu:not(.ac-menu--suggest)[role='listbox']:not([hidden])");
    const rows = [...menu.querySelectorAll<HTMLElement>("[role='option']")];
    expect(rows.map((row) => row.querySelector(".ac-menu__label")?.textContent)).toEqual([
      "Default",
      "Accept edits",
      "Plan",
      "Auto",
    ]);
    expect(rows[2]?.getAttribute("aria-selected")).toBe("true");
    press(menu, "ArrowDown");
    press(menu, "Enter");
    await settle();
    expect(s.api.terminalAgentMode).toHaveBeenCalledWith("t1", "auto");
    s.api.terminalAgentMode.mockResolvedValueOnce({ ok: false, reason: "unreadable" } as never);
    button.click();
    press(s.q(".ac-menu:not([hidden])"), "Home");
    press(s.q(".ac-menu:not([hidden])"), "Enter");
    await settle();
    expect(s.q(".agent-chat__note").textContent).toBe(t("agentChatModeUnreadable"));
  });

  it("closes a picker on Escape and gives the focus back", async () => {
    const s = await open();
    const button = s.q<HTMLButtonElement>(".ac-modebutton");
    button.focus();
    button.click();
    const menu = s.q<HTMLElement>(".ac-menu:not([hidden])");
    press(menu, "Escape");
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it("hides the mode button when the screen does not prove a mode, and for vendors without one", async () => {
    const unknown = await open(agentView({ mode: undefined }));
    expect(unknown.q<HTMLElement>(".ac-modebutton").hidden).toBe(true);
  });

  it("sets Claude's model with a command, and opens another agent's own menu with /model", async () => {
    const s = await open();
    s.q<HTMLButtonElement>(".ac-modelbutton").click();
    const menu = s.q<HTMLElement>(".ac-menu:not([hidden])");
    expect([...menu.querySelectorAll(".ac-menu__label")].map((n) => n.textContent)).toEqual([
      "Opus",
      "Sonnet",
      "Haiku",
    ]);
    expect(menu.querySelector("[aria-selected='true']")?.textContent).toContain("Opus");
    press(menu, "ArrowDown");
    press(menu, "Enter");
    await settle();
    expect(s.api.terminalAgentCommand).toHaveBeenCalledWith("t1", "/model sonnet");
    s.api.terminalAgentCommand.mockResolvedValueOnce({ ok: false, reason: "busy" } as never);
    s.q<HTMLButtonElement>(".ac-modelbutton").click();
    press(s.q(".ac-menu:not([hidden])"), "End");
    press(s.q(".ac-menu:not([hidden])"), "Enter");
    await settle();
    expect(s.q(".agent-chat__note").textContent).toBe(t("agentChatCommandBusy"));

    const codex = await open(
      agentView({ vendor: "openai", model: "gpt-x", caps: { ...agentView().caps, model: "menu" } }),
    );
    expect(codex.q(".ac-modelbutton").textContent).toBe("gpt-x");
    codex.q<HTMLButtonElement>(".ac-modelbutton").click();
    await settle();
    expect(codex.api.terminalAgentCommand).toHaveBeenCalledWith("t1", "/model");
  });

  it("names the model and the context left, or used", async () => {
    const left = await open(agentView({ context: { used: 38000, leftPercent: 62 } }));
    expect(left.q(".ac-context").textContent).toBe("Context 62% left");
    const used = await open(agentView({ context: { used: 38000 } }));
    expect(used.q(".ac-context").textContent).toBe("Context 38k tokens used");
    expect(prettyModel("claude-opus-4-5-20251101", "anthropic")).toBe("Opus 4.5");
    expect(prettyModel("gpt-5.1-codex", "openai")).toBe("gpt-5.1-codex");
    expect(prettyModel(undefined, "anthropic")).toBeUndefined();
  });
});

describe("suggestions", () => {
  const optionsOf = (s: Setup) =>
    [...s.host.querySelectorAll(".ac-menu--suggest [role='option'] .ac-menu__label")].map(
      (n) => n.textContent,
    );

  it("lists commands after /, filters, moves with arrows and inserts with Enter or Tab", async () => {
    const s = await open();
    typeInto(s, "/");
    await settle();
    expect(optionsOf(s)).toEqual(["/compact", "/clear", "/review"]);
    expect(input(s).getAttribute("aria-expanded")).toBe("true");
    typeInto(s, "/cl");
    await settle();
    expect(optionsOf(s)).toEqual(["/clear"]);
    typeInto(s, "/");
    await settle();
    press(input(s), "ArrowDown");
    const enter = press(input(s), "Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(input(s).value).toBe("/clear ");
    expect(send(s)).not.toHaveBeenCalled();
    expect(s.host.querySelector(".ac-menu--suggest:not([hidden])")).toBeNull();
    typeInto(s, "/rev");
    await settle();
    press(input(s), "Tab");
    expect(input(s).value).toBe("/review ");
  });

  it("closes on Escape without clearing the text, and lists nothing when the vendor has no commands", async () => {
    const s = await open();
    typeInto(s, "/c");
    await settle();
    const escaped = press(input(s), "Escape");
    expect(escaped.defaultPrevented).toBe(true);
    expect(input(s).value).toBe("/c");
    expect(s.host.querySelector(".ac-menu--suggest:not([hidden])")).toBeNull();
    const none = await open(agentView({ caps: { ...agentView().caps, commands: false } }));
    typeInto(none, "/");
    await settle();
    expect(none.api.terminalAgentCommands).not.toHaveBeenCalled();
  });

  it("lists files after @ (debounced) and inserts the chosen path", async () => {
    const s = await open();
    typeInto(s, "look at @tot");
    expect(s.api.terminalAgentFiles).not.toHaveBeenCalled();
    s.timers.advance(120);
    await settle();
    expect(s.api.terminalAgentFiles).toHaveBeenCalledWith("t1", "tot");
    expect(optionsOf(s)).toEqual(["total.js", "total.test.js"]);
    press(input(s), "ArrowDown");
    press(input(s), "Enter");
    expect(input(s).value).toBe("look at @src/cart/total.test.js ");
  });

  it("ignores an answer for a query that has moved on", async () => {
    const s = await open();
    let release: (value: { files: { path: string; name: string }[] }) => void = () => {};
    s.api.terminalAgentFiles.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    typeInto(s, "@a");
    s.timers.advance(120);
    typeInto(s, "no mention");
    release({ files: [{ path: "a.ts", name: "a.ts" }] });
    await settle();
    expect(optionsOf(s)).toEqual([]);
  });
});

describe("history and drafts", () => {
  it("recalls earlier messages with Up and Down on an empty box, and back to empty", async () => {
    const s = await open(
      agentView({
        page: {
          items: [
            { id: "u1", kind: "user", text: "first" },
            { id: "u2", kind: "user", text: "second" },
          ],
        },
      }),
    );
    const up = press(input(s), "ArrowUp");
    expect(up.defaultPrevented).toBe(true);
    expect(input(s).value).toBe("second");
    press(input(s), "ArrowUp");
    expect(input(s).value).toBe("first");
    press(input(s), "ArrowDown");
    expect(input(s).value).toBe("second");
    press(input(s), "ArrowDown");
    expect(input(s).value).toBe("");
    // With text typed, the arrows stay the box's own.
    typeInto(s, "typing");
    expect(press(input(s), "ArrowUp").defaultPrevented).toBe(false);
  });

  it("keeps the draft in storage per pane and restores it, and clears it once sent", async () => {
    const first = await open();
    typeInto(first, "half a thought");
    expect(first.storage.store.get("jarvis.agentChatDraft.t1")).toBe("half a thought");
    const second = await open(agentView(), { storage: first.storage });
    expect(input(second).value).toBe("half a thought");
    press(input(second), "Enter");
    await settle();
    expect(first.storage.store.has("jarvis.agentChatDraft.t1")).toBe(false);
  });
});

describe("attachments", () => {
  it("attaches a picked file by its real path, shows a chip, and appends the path to the message", async () => {
    const s = await open();
    s.api.pathForFile.mockImplementation((f: File) => `/Users/me/My Docs/${f.name}`);
    const picker = s.q<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(picker, "files", {
      configurable: true,
      value: [file("a b.txt", "text/plain")],
    });
    picker.dispatchEvent(new Event("change"));
    await settle();
    expect(s.api.terminalAgentAttach).not.toHaveBeenCalled();
    const chip = s.q(".ac-attachment");
    expect(chip.textContent).toContain("a b.txt");
    typeInto(s, "read this");
    press(input(s), "Enter");
    await settle();
    expect(send(s)).toHaveBeenCalledWith("t1", 'read this\n\n"/Users/me/My Docs/a b.txt"');
    expect(s.host.querySelector(".ac-attachment")).toBeNull();
  });

  it("uploads a pasted image, names it, and sends nothing while it uploads", async () => {
    const s = await open();
    let release: () => void = () => {};
    s.api.terminalAgentAttach.mockImplementationOnce(
      (_pane, f) =>
        new Promise((resolve) => {
          release = () =>
            resolve({ ok: true, path: "/p/x.png", name: "x.png", kind: "image", ref: "/p/x.png" });
          expect(f.name).toBe("pasted-1.png");
          expect(f.bytes).toBeInstanceOf(Uint8Array);
        }),
    );
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, "clipboardData", { value: { files: [file("", "image/png")] } });
    input(s).dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    await settle();
    expect(s.q(".ac-attachment").getAttribute("data-state")).toBe("uploading");
    typeInto(s, "see");
    press(input(s), "Enter");
    await settle();
    expect(send(s)).not.toHaveBeenCalled();
    expect(s.q(".agent-chat__note").textContent).toBe(t("agentChatWaitUpload"));
    release();
    await settle();
    expect(s.q(".ac-attachment").getAttribute("data-state")).toBe("ready");
    press(input(s), "Enter");
    await settle();
    expect(send(s)).toHaveBeenCalledWith("t1", "see\n\n/p/x.png");
  });

  it("takes a dropped file, shows a failed upload with its reason, and removes a chip", async () => {
    const s = await open();
    s.api.terminalAgentAttach.mockResolvedValueOnce({ ok: false, reason: "invalid" } as never);
    const drop = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [file("a.exe", "application/x")] },
    });
    s.q(".agent-chat").dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    await settle();
    expect(s.q(".ac-attachment").getAttribute("data-state")).toBe("failed");
    expect(s.q(".agent-chat__note").textContent).toBe(t("agentChatAttachInvalid"));
    s.q<HTMLButtonElement>(".ac-attachment__remove").click();
    expect(s.host.querySelector(".ac-attachment")).toBeNull();
    expect(s.q(".ac-attachment__remove, .ac-attachments").hasAttribute("hidden")).toBe(true);
  });

  it("labels each remove button and refuses a file over 25 MB without uploading it", async () => {
    const s = await open();
    const big = file("big.png");
    Object.defineProperty(big, "size", { value: 25 * 1024 * 1024 + 1 });
    await s.chat.focused();
    const picker = s.q<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(picker, "files", { configurable: true, value: [big, file("ok.png")] });
    picker.dispatchEvent(new Event("change"));
    await settle();
    expect(s.api.terminalAgentAttach).toHaveBeenCalledTimes(1);
    expect(s.q(".ac-attachment__remove").getAttribute("aria-label")).toBe("Remove ok.png");
  });

  it("hides the attach button for a vendor that cannot take files", async () => {
    const s = await open(agentView({ caps: { ...agentView().caps, attach: false } }));
    expect(s.q<HTMLElement>(".ac-attach").hidden).toBe(true);
  });
});
