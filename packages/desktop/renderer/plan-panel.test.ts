// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchoredComment, PlanBlock, PlanComment } from "@jarvis/core";
import type { PlanDoc, PlanList, PlanResult } from "@jarvis/platform";
import { createPlanPanel, type PlanPanelApi } from "./plan-panel.js";

type PlanReadFailure = Extract<PlanResult<PlanDoc>, { ok: false }>;

const blocks: PlanBlock[] = [
  {
    id: "heading-1",
    kind: "heading",
    level: 1,
    start: 0,
    end: 1,
    source: "# Build it",
    html: "<h1>Build it</h1>",
  },
  {
    id: "paragraph-1",
    kind: "paragraph",
    start: 1,
    end: 2,
    source: "Ship the useful feature safely.",
    html: "<p>Ship the useful feature safely.</p>",
  },
];

const doc: PlanDoc = {
  path: "/repo/docs/superpowers/plans/build.md",
  mtimeMs: 1_700_000_000_000,
  blocks,
};

function entry(
  path: string,
  name: string,
  source: "session" | "planMode" | "repo",
  extra: Record<string, unknown> = {},
) {
  return { path, name, source, mtimeMs: 1_700_000_000_000, ...extra };
}

const list: PlanList = {
  session: entry("/tmp/session.md", "session.md", "session"),
  planMode: [entry("/tmp/alpha.md", "Alpha plan.md", "planMode", { project: "jarvis" })],
  repo: [entry(doc.path, "build.md", "repo", { repoKind: "plan" })],
};

function comment(overrides: Partial<AnchoredComment> = {}): AnchoredComment {
  return {
    id: "comment-1",
    path: doc.path,
    blockId: "paragraph-1",
    quote: "useful feature",
    body: "Make the rollout explicit.",
    createdAt: 1,
    number: 1,
    anchor: { kind: "block", blockId: "paragraph-1", text: "Ship the useful feature safely." },
    ...overrides,
  };
}

function fakeApi(overrides: Partial<PlanPanelApi> = {}): PlanPanelApi {
  return {
    plansList: vi.fn(async () => list),
    plansRead: vi.fn(async (): Promise<PlanResult<PlanDoc>> => ({ ok: true, value: doc })),
    plansWriteBlock: vi.fn(async (): Promise<PlanResult<PlanDoc>> => ({ ok: true, value: doc })),
    plansComments: vi.fn(async () => []),
    plansAddComment: vi.fn(
      async (_path, blockId, quote, body): Promise<PlanComment> => ({
        id: "new-comment",
        path: doc.path,
        blockId,
        quote,
        body,
        createdAt: 2,
      }),
    ),
    plansUpdateComment: vi.fn(async () => undefined),
    plansDeleteComment: vi.fn(async () => true),
    plansSend: vi.fn(async () => ({ ok: true as const, sent: 0 })),
    ...overrides,
  };
}

function setup(api = fakeApi()) {
  const panel = createPlanPanel({ api, t: (key) => key });
  document.body.append(panel.element);
  panel.setPane("pane-1", "/repo");
  return { panel, api };
}

function click(target: Element | null): void {
  if (!target) throw new Error("missing click target");
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** A plain (non-drag) mouse click on a block, in the order a real browser
 *  delivers it: mousedown (which collapses any selection) → mouseup →
 *  click. Block editing opens on the confirmed mousedown/mouseup pair (fix
 *  round 4, item B), not on `click`, so a bare `click` event is not enough. */
function clickBlock(target: Element | null): void {
  if (!target) throw new Error("missing click target");
  window.getSelection()?.removeAllRanges();
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function blockRow(panelElement: HTMLElement, blockId: string): HTMLElement {
  const content = panelElement.querySelector(`[data-block-id="${blockId}"]`);
  const row = content?.closest<HTMLElement>(".plan-panel__block-row");
  if (!row) throw new Error(`missing block row for ${blockId}`);
  return row;
}

/** A single macrotask tick drains the whole pending microtask queue no
 *  matter how many `.then()`s a handler chains — unlike a fixed count of
 *  `await Promise.resolve()`, it does not need to be re-tuned every time a
 *  handler grows one more await. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("createPlanPanel", () => {
  it("renders plan blocks and toggles the read-only source", async () => {
    const { panel } = setup();
    await panel.open(doc.path);

    expect(panel.element.querySelectorAll(".plan-block")).toHaveLength(2);
    expect(panel.element.querySelector('[data-block-id="paragraph-1"]')?.textContent).toContain(
      "Ship the useful feature safely.",
    );
    click(panel.element.querySelector('[data-action="source"]'));
    // S2: PlanDoc has no raw source text, so blocks are joined by one blank
    // line rather than a single "\n" that would read as one continuous run.
    expect(panel.element.querySelector("pre")?.textContent).toBe(
      "# Build it\n\nShip the useful feature safely.",
    );
  });

  it("replaces remote images with alt text but keeps data images", async () => {
    const imageDoc: PlanDoc = {
      ...doc,
      blocks: [
        {
          ...blocks[1]!,
          html: '<p><img src="https://tracker.invalid/pixel.png" alt="diagram"><img src="data:image/png;base64,AA" alt="inline"></p>',
        },
      ],
    };
    const api = fakeApi({ plansRead: vi.fn(async () => ({ ok: true as const, value: imageDoc })) });
    const { panel } = setup(api);
    await panel.open(doc.path);

    const images = panel.element.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("src")).toBe("data:image/png;base64,AA");
    expect(panel.element.textContent).toContain("diagram");
  });

  // Task 8: setWindowOpenHandler denies every target=_blank outright, so a
  // plan link's default action would otherwise silently do nothing — the
  // panel must always prevent it and hand the href to the caller instead.
  it("prevents a block link's default action and hands its href to onLinkClick", async () => {
    const linkDoc: PlanDoc = {
      ...doc,
      blocks: [
        {
          ...blocks[1]!,
          html: '<p>See <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">the docs</a>.</p>',
        },
      ],
    };
    const api = fakeApi({ plansRead: vi.fn(async () => ({ ok: true as const, value: linkDoc })) });
    const onLinkClick = vi.fn();
    const panel = createPlanPanel({ api, t: (key) => key, onLinkClick });
    document.body.append(panel.element);
    panel.setPane("pane-1", "/repo");
    await panel.open(doc.path);

    const anchor = panel.element.querySelector("a[href]");
    if (!anchor) throw new Error("missing link");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onLinkClick).toHaveBeenCalledWith("https://example.com/x");
  });

  it("highlights a quoted comment when its text spans inline markup", async () => {
    const markedUpDoc: PlanDoc = {
      ...doc,
      blocks: [
        {
          ...blocks[1]!,
          html: "<p>Ship the <strong>useful</strong> feature safely.</p>",
        },
      ],
    };
    const api = fakeApi({
      plansRead: vi.fn(async () => ({ ok: true as const, value: markedUpDoc })),
      plansComments: vi.fn(async () => [comment()]),
    });
    const { panel } = setup(api);
    await panel.open(doc.path);

    const highlight = panel.element.querySelector("mark.plan-quote");
    expect(highlight?.textContent).toBe("useful feature");
    expect(highlight?.querySelector("strong")?.textContent).toBe("useful");
  });

  it("groups picker entries, filters by name, and opens the active result with Enter", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    click(panel.element.querySelector(".plan-panel__file"));

    expect(panel.element.textContent).toContain("planPickerSession");
    expect(panel.element.textContent).toContain("planPickerRecent");
    expect(panel.element.textContent).toContain("planPickerRepo");
    const search = panel.element.querySelector<HTMLInputElement>(
      '.plan-panel__picker input[type="search"]',
    )!;
    search.value = "alpha";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(panel.element.querySelectorAll(".plan-panel__picker-item")).toHaveLength(1);
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(api.plansRead).toHaveBeenLastCalledWith("/tmp/alpha.md");
  });

  it("moves the active picker item with arrow keys and opens it with Enter", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    click(panel.element.querySelector(".plan-panel__file"));
    const search = panel.element.querySelector<HTMLInputElement>(
      '.plan-panel__picker input[type="search"]',
    )!;
    // Groups in order: This session (session.md), Plan mode (alpha.md), Repo (build.md).
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const items = panel.element.querySelectorAll(".plan-panel__picker-item");
    expect(items[2]?.getAttribute("data-active")).toBe("true");
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(api.plansRead).toHaveBeenLastCalledWith(doc.path);
  });

  it("translates the repo entry's spec/plan kind in the picker meta", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    click(panel.element.querySelector(".plan-panel__file"));
    const repoItem = [...panel.element.querySelectorAll(".plan-panel__picker-item")].find((item) =>
      item.textContent?.includes("build.md"),
    );
    expect(repoItem?.textContent).toContain("planKindPlan");
  });

  it("opens an empty state with a reachable header when this pane has no session plan", async () => {
    const api = fakeApi({
      plansList: vi.fn(async () => ({ session: undefined, planMode: [], repo: [] })),
    });
    const { panel } = setup(api);
    await panel.open();
    expect(panel.element.textContent).toContain("planEmptyTitle");
    expect(panel.element.textContent).toContain("planEmptyHint");
    expect(panel.element.querySelector('[data-action="open-picker"]')).toBeTruthy();
    expect(panel.element.querySelector('[data-action="close"]')).toBeTruthy();
  });

  it("opens the picker from the empty state and loads the chosen entry", async () => {
    const api = fakeApi({
      plansList: vi.fn(async () => ({ session: undefined, planMode: [], repo: [list.repo[0]!] })),
    });
    const { panel, api: usedApi } = setup(api);
    await panel.open();

    click(panel.element.querySelector('[data-action="open-picker"]'));
    expect(panel.element.querySelector(".plan-panel__picker")).toBeTruthy();
    click(panel.element.querySelector(".plan-panel__picker-item"));
    await flush();

    expect(usedApi.plansRead).toHaveBeenLastCalledWith(doc.path);
    expect(panel.element.querySelectorAll(".plan-block").length).toBeGreaterThan(0);
  });

  // Task 8 fix round 1: workspace-terminal.ts's auto-open calls open() on a
  // panel the user may have closed with the picker left showing — the
  // picker's own draw() queues a `search.focus()` microtask, which would
  // steal the terminal's focus back on a re-open nobody asked for. Closing
  // must leave nothing behind for the next open to walk into.
  it("resets the picker on close, so a later open never shows or re-focuses it", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    click(panel.element.querySelector('[data-action="open-picker"]'));
    expect(panel.element.querySelector(".plan-panel__picker")).toBeTruthy();

    panel.close();
    await panel.open(doc.path);

    expect(panel.element.querySelector(".plan-panel__picker")).toBeFalsy();
  });

  it("adds a comment for a text selection inside one block", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    const text = panel.element.querySelector('[data-block-id="paragraph-1"] p')?.firstChild;
    const range = document.createRange();
    range.setStart(text!, 9);
    range.setEnd(text!, 23);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    click(panel.element.querySelector('[data-action="comment-selection"]'));
    const textarea = panel.element.querySelector<HTMLTextAreaElement>(
      ".plan-panel__comment-box textarea",
    )!;
    textarea.value = "Clarify this.";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    click(panel.element.querySelector('[data-action="add-comment"]'));
    await flush();

    expect(api.plansAddComment).toHaveBeenCalledWith(
      doc.path,
      "paragraph-1",
      "useful feature",
      "Clarify this.",
    );
  });

  it("I1: keeps the selection-comment button alive through its own mousedown, mouseup and click", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    const text = panel.element.querySelector('[data-block-id="paragraph-1"] p')?.firstChild;
    const range = document.createRange();
    range.setStart(text!, 9);
    range.setEnd(text!, 23);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    const commentButton = panel.element.querySelector<HTMLElement>(
      '[data-action="comment-selection"]',
    );
    expect(commentButton).toBeTruthy();

    // The exact same button receives all three events of a real click, in
    // order — a mouseup elsewhere would remove the button, but this one
    // lands ON it and must not.
    commentButton!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    commentButton!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    commentButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(panel.element.querySelector(".plan-panel__comment-box")).toBeTruthy();
  });

  it("S3: positions the selection-comment button from the selection's own rect instead of a fixed CSS offset", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    const text = panel.element.querySelector('[data-block-id="paragraph-1"] p')?.firstChild;
    const range = document.createRange();
    range.setStart(text!, 0);
    range.setEnd(text!, 4);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    const commentButton = panel.element.querySelector<HTMLElement>(
      '[data-action="comment-selection"]',
    )!;
    // jsdom has no layout engine (every rect is 0x0 at the origin), so this
    // only proves positionSelectionButton ran and fell back to the block's
    // own rect — real pixel placement is a manual-pass concern.
    expect(commentButton.style.top).toBe("0px");
    expect(commentButton.style.left).toBe("0px");
  });

  it("opens a comment box with an empty quote from the block's own pin", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    click(blockRow(panel.element, "paragraph-1").querySelector('[data-action="block-comment"]'));
    const box = panel.element.querySelector(".plan-panel__comment-box");
    expect(box).toBeTruthy();
    expect(box?.querySelector("blockquote")).toBeNull();
  });

  it("Esc cancels the comment box", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    click(blockRow(panel.element, "paragraph-1").querySelector('[data-action="block-comment"]'));
    const textarea = panel.element.querySelector<HTMLTextAreaElement>(
      ".plan-panel__comment-box textarea",
    )!;
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.element.querySelector(".plan-panel__comment-box")).toBeNull();
  });

  it.each([
    { metaKey: true, label: "Cmd+Enter" },
    { ctrlKey: true, label: "Ctrl+Enter" },
  ])("saves the comment box on $label", async ({ metaKey, ctrlKey }) => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    click(blockRow(panel.element, "paragraph-1").querySelector('[data-action="block-comment"]'));
    const textarea = panel.element.querySelector<HTMLTextAreaElement>(
      ".plan-panel__comment-box textarea",
    )!;
    textarea.value = "Looks good";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, metaKey, ctrlKey }),
    );
    await flush();
    expect(api.plansAddComment).toHaveBeenCalledWith(doc.path, "paragraph-1", "", "Looks good");
  });

  it("opens a pin popover and deletes its comment", async () => {
    const api = fakeApi({ plansComments: vi.fn(async () => [comment()]) });
    const { panel } = setup(api);
    await panel.open(doc.path);
    click(panel.element.querySelector(".plan-panel__pin"));
    expect(panel.element.textContent).toContain("Make the rollout explicit.");
    click(panel.element.querySelector('[data-action="delete-comment"]'));
    await flush();
    expect(api.plansDeleteComment).toHaveBeenCalledWith("comment-1");
  });

  it("edits a comment and rejects an empty body", async () => {
    const api = fakeApi({ plansComments: vi.fn(async () => [comment()]) });
    const { panel } = setup(api);
    await panel.open(doc.path);
    click(panel.element.querySelector(".plan-panel__pin"));
    click(panel.element.querySelector('[data-action="edit-comment"]'));
    const input = panel.element.querySelector<HTMLTextAreaElement>(
      ".plan-panel__comment-popover textarea",
    )!;
    const save = panel.element.querySelector<HTMLButtonElement>('[data-action="save-comment"]')!;

    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(save.disabled).toBe(true);

    input.value = "Updated body";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(save.disabled).toBe(false);
    click(save);
    await flush();
    expect(api.plansUpdateComment).toHaveBeenCalledWith("comment-1", "Updated body");
  });

  it("closes the comment popover on Esc and on an outside click", async () => {
    const api = fakeApi({ plansComments: vi.fn(async () => [comment()]) });
    const { panel } = setup(api);
    await panel.open(doc.path);

    click(panel.element.querySelector(".plan-panel__pin"));
    expect(panel.element.querySelector(".plan-panel__comment-popover")).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.element.querySelector(".plan-panel__comment-popover")).toBeNull();

    click(panel.element.querySelector(".plan-panel__pin"));
    expect(panel.element.querySelector(".plan-panel__comment-popover")).toBeTruthy();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(panel.element.querySelector(".plan-panel__comment-popover")).toBeNull();
  });

  it("shows tray counts and sends only queued comment ids", async () => {
    const comments = [comment(), comment({ id: "sent", number: 2, sentAt: 3 })];
    const api = fakeApi({ plansComments: vi.fn(async () => comments) });
    const { panel } = setup(api);
    await panel.open(doc.path);

    expect(panel.element.querySelector(".plan-panel__tray-summary")?.textContent).toContain("2");
    expect(panel.element.querySelector(".plan-panel__tray-summary")?.textContent).toContain("1");
    click(panel.element.querySelector('[data-action="send-comments"]'));
    await flush();
    expect(api.plansSend).toHaveBeenCalledWith("pane-1", doc.path, ["comment-1"]);
  });

  it("disables Send when there are no queued comments", async () => {
    const api = fakeApi({ plansComments: vi.fn(async () => [comment({ sentAt: 3 })]) });
    const { panel } = setup(api);
    await panel.open(doc.path);
    expect(
      panel.element.querySelector<HTMLButtonElement>('[data-action="send-comments"]')?.disabled,
    ).toBe(true);
  });

  it("shows a translated error in the tray when Send reports ok:false", async () => {
    const api = fakeApi({
      plansComments: vi.fn(async () => [comment()]),
      plansSend: vi.fn(async () => ({ ok: false as const, reason: "forbidden" as const })),
    });
    const { panel } = setup(api);
    await panel.open(doc.path);
    click(panel.element.querySelector('[data-action="send-comments"]'));
    await flush();
    expect(panel.element.querySelector(".plan-panel__send-error")?.textContent).toBe(
      "planSendErrorForbidden",
    );
  });

  it("shows a generic translated error after a rejected action promise, and stays usable", async () => {
    const api = fakeApi({
      plansComments: vi.fn(async () => [comment()]),
      plansDeleteComment: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const { panel } = setup(api);
    await panel.open(doc.path);
    click(panel.element.querySelector(".plan-panel__pin"));
    click(panel.element.querySelector('[data-action="delete-comment"]'));
    await flush();
    expect(panel.element.querySelector(".plan-panel__action-error")?.textContent).toBe(
      "planActionError",
    );
    // The panel is not left broken: the same pin can still be opened again.
    click(panel.element.querySelector(".plan-panel__pin"));
    expect(panel.element.querySelector(".plan-panel__comment-popover")).toBeTruthy();
  });

  it("collapses the tray with Keep for later and expands it again from the summary", async () => {
    const api = fakeApi({ plansComments: vi.fn(async () => [comment()]) });
    const { panel } = setup(api);
    await panel.open(doc.path);
    click(panel.element.querySelector('[data-action="keep-comments"]'));
    expect(panel.element.querySelector(".plan-panel__tray")?.className).toContain(
      "plan-panel__tray--collapsed",
    );
    click(panel.element.querySelector(".plan-panel__tray-summary"));
    expect(panel.element.querySelector(".plan-panel__tray")?.className).not.toContain(
      "plan-panel__tray--collapsed",
    );
  });

  it("expands beyond three queued comments with Show all", async () => {
    const many = [1, 2, 3, 4].map((n) => comment({ id: `c${n}`, number: n, quote: "" }));
    const api = fakeApi({ plansComments: vi.fn(async () => many) });
    const { panel } = setup(api);
    await panel.open(doc.path);
    expect(panel.element.querySelectorAll(".plan-panel__tray-item")).toHaveLength(3);
    click(panel.element.querySelector('[data-action="show-all-comments"]'));
    expect(panel.element.querySelectorAll(".plan-panel__tray-item")).toHaveLength(4);
  });

  it("lists orphaned comments at the bottom with the changed-section label", async () => {
    const comments = [
      comment(),
      comment({ id: "orphan", number: 2, anchor: { kind: "orphaned" }, body: "Old section note" }),
    ];
    const api = fakeApi({ plansComments: vi.fn(async () => comments) });
    const { panel } = setup(api);
    await panel.open(doc.path);
    const orphan = panel.element.querySelector(".plan-panel__orphaned");
    expect(orphan?.textContent).toContain("planSectionChanged");
    expect(orphan?.textContent).toContain("Old section note");
    expect(orphan).toBe(panel.element.querySelector(".plan-panel__tray-list")?.lastElementChild);
  });

  it("refreshes the list and current document when notified of its path", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    panel.notifyChanged(doc.path);
    await flush();
    expect(api.plansList).toHaveBeenCalledTimes(2);
    expect(api.plansRead).toHaveBeenCalledTimes(2);
  });

  it("I2: keeps a draft across a same-path reload, and shows it as orphaned once its block is gone", async () => {
    let readCount = 0;
    const revisedDoc: PlanDoc = { ...doc, mtimeMs: doc.mtimeMs + 1, blocks: [blocks[0]!] };
    const api = fakeApi({
      plansRead: vi.fn(async (): Promise<PlanResult<PlanDoc>> => {
        readCount += 1;
        return { ok: true, value: readCount === 1 ? doc : revisedDoc };
      }),
    });
    const { panel } = setup(api);
    await panel.open(doc.path);
    click(blockRow(panel.element, "paragraph-1").querySelector('[data-action="block-comment"]'));
    expect(panel.element.querySelector(".plan-panel__comment-box")).toBeTruthy();

    panel.notifyChanged(doc.path);
    await flush();

    expect(panel.element.querySelector('[data-block-id="paragraph-1"]')).toBeNull();
    expect(panel.element.querySelector(".plan-panel__comment-box")).toBeTruthy();
    expect(panel.element.textContent).toContain("planDraftOrphaned");
  });

  it("I2: keeps the Source view across a same-path reload", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    click(panel.element.querySelector('[data-action="source"]'));
    expect(panel.element.querySelector("pre")).toBeTruthy();

    panel.notifyChanged(doc.path);
    await flush();
    expect(panel.element.querySelector("pre")).toBeTruthy();
  });

  it("I2: resets the draft and Source view when a different path is opened", async () => {
    const doc2: PlanDoc = { ...doc, path: "/repo/docs/superpowers/plans/other.md" };
    const api = fakeApi({
      plansRead: vi.fn(
        async (path: string): Promise<PlanResult<PlanDoc>> =>
          path === doc2.path ? { ok: true, value: doc2 } : { ok: true, value: doc },
      ),
    });
    const { panel } = setup(api);
    await panel.open(doc.path);
    click(panel.element.querySelector('[data-action="source"]'));
    expect(panel.element.querySelector("pre")).toBeTruthy();

    await panel.open(doc2.path);
    expect(panel.element.querySelector("pre")).toBeNull();
    expect(panel.element.querySelectorAll(".plan-block").length).toBeGreaterThan(0);
  });

  const readErrorCases: Array<[PlanReadFailure["reason"], string]> = [
    ["forbidden", "planErrorForbidden"],
    ["not-found", "planErrorNotFound"],
    ["too-large", "planErrorTooLarge"],
    ["conflict", "planErrorConflict"],
    ["missing-block", "planErrorMissingBlock"],
    ["io", "planErrorIo"],
  ];
  it.each(readErrorCases)(
    "I3: renders a translated error state for reason=%s, with the header still reachable",
    async (reason, key) => {
      const api = fakeApi({
        plansRead: vi.fn(async (): Promise<PlanResult<PlanDoc>> => ({ ok: false, reason })),
      });
      const { panel } = setup(api);
      await panel.open(doc.path);
      expect(panel.element.textContent).toContain(key);
      expect(panel.element.querySelector('[data-action="open-picker"]')).toBeTruthy();
      expect(panel.element.querySelector('[data-action="close"]')).toBeTruthy();
    },
  );

  it("S1: shows the translated 'now' label right after a save", async () => {
    vi.spyOn(Date, "now").mockReturnValue(doc.mtimeMs);
    const { panel } = setup();
    await panel.open(doc.path);
    expect(panel.element.querySelector(".plan-panel__updated")?.textContent).toContain(
      "planRelativeNow",
    );
  });

  it("S1: composes translated relative-time units for older updates", async () => {
    vi.spyOn(Date, "now").mockReturnValue(doc.mtimeMs + 5 * 60_000);
    const { panel } = setup();
    await panel.open(doc.path);
    expect(panel.element.querySelector(".plan-panel__updated")?.textContent).toBe(
      "planUpdated · 5planRelativeMinute",
    );
  });
});

describe("createPlanPanel: block editing (Task 7b)", () => {
  function paragraphEl(panelElement: HTMLElement): HTMLElement {
    return panelElement.querySelector<HTMLElement>(".plan-block-edit__rich")!;
  }

  async function editParagraph(panelElement: HTMLElement, text: string): Promise<void> {
    clickBlock(panelElement.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panelElement);
    editable.querySelector("p")!.textContent = text;
    editable.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("click enters edit mode: accent-outlined contenteditable, a formatting toolbar, and a hint", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);
    // jsdom doesn't implement the `.contentEditable` IDL property at all
    // (reads back `undefined` regardless of what's set) — the attribute is
    // what plan-panel.ts actually sets and what a real browser reflects.
    expect(editable.getAttribute("contenteditable")).toBe("true");
    expect(panel.element.querySelector(".plan-block-edit__toolbar")).toBeTruthy();
    expect(panel.element.querySelector(".plan-block-edit__hint")?.textContent).toBe("planEditHint");
  });

  it("a click-then-blur with no typing never writes (gated on a real dirty flag)", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    paragraphEl(panel.element).dispatchEvent(new Event("blur"));
    await flush();
    expect(api.plansWriteBlock).not.toHaveBeenCalled();
    expect(panel.element.querySelector(".plan-block-edit__rich")).toBeNull();
  });

  it("a typed edit that lands back on the original source never writes either (isNoopEdit)", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature safely.");
    paragraphEl(panel.element).dispatchEvent(new Event("blur"));
    await flush();
    expect(api.plansWriteBlock).not.toHaveBeenCalled();
  });

  it("writes the edited markdown on blur, against the doc's base mtime, and exits edit mode", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    paragraphEl(panel.element).dispatchEvent(new Event("blur"));
    await flush();
    expect(api.plansWriteBlock).toHaveBeenCalledWith(
      doc.path,
      "paragraph-1",
      "Ship the useful feature quickly.",
      doc.mtimeMs,
    );
    expect(panel.element.querySelector(".plan-block-edit__rich")).toBeNull();
  });

  it("⌘S writes the edit against the base mtime without exiting the block", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    paragraphEl(panel.element).dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }),
    );
    await flush();
    expect(api.plansWriteBlock).toHaveBeenCalledWith(
      doc.path,
      "paragraph-1",
      "Ship the useful feature quickly.",
      doc.mtimeMs,
    );
    expect(panel.element.querySelector(".plan-block-edit__rich")).toBeTruthy();
  });

  it("shows the header's Unsaved indicator once dirty, and hides it again after a successful save", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    expect(panel.element.querySelector<HTMLElement>(".plan-panel__unsaved")?.hidden).toBe(true);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    expect(panel.element.querySelector<HTMLElement>(".plan-panel__unsaved")?.hidden).toBe(false);
    paragraphEl(panel.element).dispatchEvent(new Event("blur"));
    await flush();
    expect(panel.element.querySelector<HTMLElement>(".plan-panel__unsaved")?.hidden).toBe(true);
  });

  it("Esc reverts the DOM to the original content without writing", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    await editParagraph(panel.element, "Something else entirely.");
    paragraphEl(panel.element).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush();
    expect(api.plansWriteBlock).not.toHaveBeenCalled();
    expect(panel.element.querySelector(".plan-block-edit__rich")).toBeNull();
    expect(panel.element.querySelector('[data-block-id="paragraph-1"]')?.textContent).toContain(
      "Ship the useful feature safely.",
    );
  });

  it("Bold wraps the current selection and saves it as **markdown**", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);
    const text = editable.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 9); // "useful feature"
    range.setEnd(text, 23);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    click(panel.element.querySelector(".plan-block-edit__bold"));
    expect(editable.querySelector("strong")?.textContent).toBe("useful feature");
    editable.dispatchEvent(new Event("blur"));
    await flush();
    expect(api.plansWriteBlock).toHaveBeenCalledWith(
      doc.path,
      "paragraph-1",
      "Ship the **useful feature** safely.",
      doc.mtimeMs,
    );
  });

  it("Link wraps the selection, focuses an inline URL input (no window.prompt), and saves [text](url)", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);
    const text = editable.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 9);
    range.setEnd(text, 23);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    click(panel.element.querySelector(".plan-block-edit__link"));
    const urlInput = panel.element.querySelector<HTMLInputElement>(".plan-block-edit__link-input")!;
    expect(urlInput).toBeTruthy();
    urlInput.value = "https://example.com";
    urlInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(editable.querySelector("a")?.getAttribute("href")).toBe("https://example.com");

    editable.dispatchEvent(new Event("blur"));
    await flush();
    expect(api.plansWriteBlock).toHaveBeenCalledWith(
      doc.path,
      "paragraph-1",
      "Ship the [useful feature](https://example.com) safely.",
      doc.mtimeMs,
    );
  });

  it("the toolbar's Comment button opens a draft quoting the selection, without discarding the in-progress edit", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);
    const text = editable.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 9);
    range.setEnd(text, 23);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    editable.querySelector("p")!.textContent = "Ship the useful feature safely, and more.";
    editable.dispatchEvent(new Event("input", { bubbles: true }));

    click(panel.element.querySelector(".plan-block-edit__comment"));
    const box = panel.element.querySelector(".plan-panel__comment-box");
    expect(box).toBeTruthy();
    // The edit itself is still live — a full re-render would have rebuilt
    // the block from the doc's original html, losing the typed text above.
    expect(panel.element.querySelector(".plan-block-edit__rich")).toBeTruthy();
    expect(editable.querySelector("p")!.textContent).toBe(
      "Ship the useful feature safely, and more.",
    );
  });

  it("a code block edits as plain text and keeps its fence and language on save", async () => {
    const codeDoc: PlanDoc = {
      ...doc,
      blocks: [
        {
          id: "code-1",
          kind: "code",
          start: 0,
          end: 3,
          source: "```js\nconst x = 1;\n```",
          html: '<pre><code class="language-js">const x = 1;\n</code></pre>',
        },
      ],
    };
    const api = fakeApi({ plansRead: vi.fn(async () => ({ ok: true as const, value: codeDoc })) });
    const { panel } = setup(api);
    await panel.open(codeDoc.path);

    clickBlock(panel.element.querySelector('[data-block-id="code-1"]'));
    const editable = panel.element.querySelector<HTMLElement>(".plan-block-edit__code")!;
    expect(panel.element.querySelector(".plan-block-edit__toolbar")).toBeNull();
    editable.querySelector("code")!.textContent = "const x = 2;";
    editable.dispatchEvent(new Event("input", { bubbles: true }));
    editable.dispatchEvent(new Event("blur"));
    await flush();
    expect(api.plansWriteBlock).toHaveBeenCalledWith(
      codeDoc.path,
      "code-1",
      "```js\nconst x = 2;\n```",
      codeDoc.mtimeMs,
    );
  });

  it("a table block opens as a raw-markdown editable box on the same save path", async () => {
    const tableSource = "| A | B |\n| - | - |\n| 1 | 2 |";
    const tableDoc: PlanDoc = {
      ...doc,
      blocks: [
        {
          id: "table-1",
          kind: "table",
          start: 0,
          end: 3,
          source: tableSource,
          html: "<table></table>",
        },
      ],
    };
    const api = fakeApi({ plansRead: vi.fn(async () => ({ ok: true as const, value: tableDoc })) });
    const { panel } = setup(api);
    await panel.open(tableDoc.path);

    clickBlock(panel.element.querySelector('[data-block-id="table-1"]'));
    const editable = panel.element.querySelector<HTMLElement>(".plan-block-edit__raw")!;
    expect(editable.textContent).toBe(tableSource);
    editable.textContent = "| A | B |\n| - | - |\n| 3 | 4 |";
    editable.dispatchEvent(new Event("input", { bubbles: true }));
    editable.dispatchEvent(new Event("blur"));
    await flush();
    expect(api.plansWriteBlock).toHaveBeenCalledWith(
      tableDoc.path,
      "table-1",
      "| A | B |\n| - | - |\n| 3 | 4 |",
      tableDoc.mtimeMs,
    );
  });

  const conflictReasons = ["conflict", "missing-block"] as const;
  it.each(conflictReasons)(
    "on a %s write result, shows a reapply notice and Apply re-writes against the fresh doc",
    async (reason) => {
      const revisedDoc: PlanDoc = {
        ...doc,
        mtimeMs: doc.mtimeMs + 1000,
        blocks: [blocks[0]!, { ...blocks[1]!, id: "paragraph-1-changed" }],
      };
      const writeBlock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, reason, doc: revisedDoc })
        .mockResolvedValueOnce({ ok: true, value: revisedDoc });
      const api = fakeApi({ plansWriteBlock: writeBlock });
      const { panel } = setup(api);
      await panel.open(doc.path);
      await editParagraph(panel.element, "Ship the useful feature quickly.");
      paragraphEl(panel.element).dispatchEvent(new Event("blur"));
      await flush();

      expect(panel.element.querySelector(".plan-panel__conflict-notice")?.textContent).toBe(
        "planEditConflictNotice",
      );
      const textarea = panel.element.querySelector<HTMLTextAreaElement>(
        ".plan-panel__conflict-textarea",
      )!;
      expect(textarea.value).toBe("Ship the useful feature quickly.");
      // The edit is no longer live underneath the notice.
      expect(panel.element.querySelector(".plan-block-edit__rich")).toBeNull();

      click(panel.element.querySelector('[data-action="apply-edit-conflict"]'));
      await flush();

      expect(writeBlock).toHaveBeenLastCalledWith(
        doc.path,
        "paragraph-1-changed", // original id gone from the fresh doc -> falls back to the same index
        "Ship the useful feature quickly.",
        revisedDoc.mtimeMs,
      );
      expect(panel.element.querySelector(".plan-panel__conflict")).toBeNull();
    },
  );

  it("keeps the conflict textarea and shows an error when Apply finds no block left to target", async () => {
    const revisedDoc: PlanDoc = { ...doc, mtimeMs: doc.mtimeMs + 1000, blocks: [blocks[0]!] };
    const writeBlock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "conflict" as const, doc: revisedDoc });
    const api = fakeApi({ plansWriteBlock: writeBlock });
    const { panel } = setup(api);
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    paragraphEl(panel.element).dispatchEvent(new Event("blur"));
    await flush();

    click(panel.element.querySelector('[data-action="apply-edit-conflict"]'));
    await flush();

    expect(writeBlock).toHaveBeenCalledTimes(1);
    expect(panel.element.querySelector(".plan-panel__conflict-textarea")).toBeTruthy();
    expect(panel.element.querySelector(".plan-panel__action-error")?.textContent).toBe(
      "planEditConflictGone",
    );
  });

  it("Discard drops the conflict notice without writing again", async () => {
    const revisedDoc: PlanDoc = {
      ...doc,
      mtimeMs: doc.mtimeMs + 1000,
      blocks: [blocks[0]!, { ...blocks[1]!, id: "paragraph-1-changed" }],
    };
    const writeBlock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "conflict" as const, doc: revisedDoc });
    const api = fakeApi({ plansWriteBlock: writeBlock });
    const { panel } = setup(api);
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    paragraphEl(panel.element).dispatchEvent(new Event("blur"));
    await flush();

    click(panel.element.querySelector('[data-action="discard-edit-conflict"]'));
    expect(panel.element.querySelector(".plan-panel__conflict")).toBeNull();
    expect(writeBlock).toHaveBeenCalledTimes(1);
  });

  // Superseded by fix round 3, item A: loadDocument itself now decides
  // echo-vs-real-change and dirty-vs-clean, which needs the freshly read
  // mtime — so notifyChanged forwards unconditionally rather than
  // pre-emptively skipping the read while dirty, and a `plansRead` DOES
  // happen here (findRoundState: the returned doc is a real, non-echo
  // change, so the dirty edit is deferred *after* reading it, not before).
  it("defers acting on a same-path reload while dirty (showing Updated-on-disk instead), and reloads once discarded", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    const readCallsBefore = vi.mocked(api.plansRead).mock.calls.length;
    await editParagraph(panel.element, "Ship the useful feature quickly.");

    panel.notifyChanged(doc.path);
    await flush();
    expect(vi.mocked(api.plansRead).mock.calls.length).toBe(readCallsBefore + 1);
    expect(panel.element.querySelector<HTMLElement>(".plan-panel__disk-changed")?.hidden).toBe(
      false,
    );
    // Still editing, untouched -- a real external change while dirty must
    // not re-render at all.
    expect(panel.element.querySelector(".plan-block-edit__rich")).toBeTruthy();

    paragraphEl(panel.element).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush();
    expect(vi.mocked(api.plansRead).mock.calls.length).toBe(readCallsBefore + 2);
  });
});

describe("createPlanPanel: block editing fix round 1", () => {
  function paragraphEl(panelElement: HTMLElement): HTMLElement {
    return panelElement.querySelector<HTMLElement>(".plan-block-edit__rich")!;
  }

  async function editParagraph(panelElement: HTMLElement, text: string): Promise<void> {
    clickBlock(panelElement.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panelElement);
    editable.querySelector("p")!.textContent = text;
    editable.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function selectText(node: Node, start: number, end: number): void {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // jsdom implements neither `ClipboardEvent` nor `DataTransfer` as global
  // constructors — a plain `Event` with a hand-attached `clipboardData`
  // (just the `.getData` shape plan-panel.ts's own paste handler reads) is
  // otherwise indistinguishable to that handler, and dispatchEvent accepts
  // any `Event` regardless of its static type.
  function pasteEvent(text: string): Event {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? text : "") },
    });
    return event;
  }

  // C1 -------------------------------------------------------------------

  it("C1: Enter in a rich paragraph inserts a hard break, never a sibling block", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);
    const textNode = editable.querySelector("p")!.firstChild!;
    selectText(textNode, 4, 4);

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    editable.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editable.querySelectorAll("p")).toHaveLength(1);
    expect(editable.querySelector("br")).toBeTruthy();

    editable.dispatchEvent(new Event("blur"));
    await flush();
    expect(api.plansWriteBlock).toHaveBeenCalledWith(
      doc.path,
      "paragraph-1",
      "Ship  \n the useful feature safely.",
      doc.mtimeMs,
    );
  });

  it("C1: Shift+Enter does the same as Enter in rich mode", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);
    const textNode = editable.querySelector("p")!.firstChild!;
    selectText(textNode, 4, 4);

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    editable.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(editable.querySelector("br")).toBeTruthy();
  });

  it("C1: Enter in a rich LIST block is left alone (native list behavior)", async () => {
    const listDoc: PlanDoc = {
      ...doc,
      blocks: [
        {
          id: "list-1",
          kind: "list",
          start: 0,
          end: 2,
          source: "- One\n- Two",
          html: "<ul><li>One</li><li>Two</li></ul>",
        },
      ],
    };
    const api = fakeApi({ plansRead: vi.fn(async () => ({ ok: true as const, value: listDoc })) });
    const { panel } = setup(api);
    await panel.open(listDoc.path);
    clickBlock(panel.element.querySelector('[data-block-id="list-1"]'));
    const editable = panel.element.querySelector<HTMLElement>(".plan-block-edit__rich")!;
    const li = editable.querySelector("li")!;
    const range = document.createRange();
    range.selectNodeContents(li);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    editable.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("C1: pasting multi-line text into a rich paragraph inserts hard breaks, never sibling blocks", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);
    const p = editable.querySelector("p")!;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const event = pasteEvent("line one\nline two");
    editable.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editable.querySelectorAll("p")).toHaveLength(1);
    expect(editable.querySelectorAll("br").length).toBeGreaterThanOrEqual(1);

    editable.dispatchEvent(new Event("blur"));
    await flush();
    expect(api.plansWriteBlock).toHaveBeenCalledWith(
      doc.path,
      "paragraph-1",
      "Ship the useful feature safely.line one  \nline two",
      doc.mtimeMs,
    );
  });

  it("C1: pasting multi-line text into a code block inserts literal newlines", async () => {
    const codeDoc: PlanDoc = {
      ...doc,
      blocks: [
        {
          id: "code-1",
          kind: "code",
          start: 0,
          end: 3,
          source: "```js\nconst x = 1;\n```",
          html: '<pre><code class="language-js">const x = 1;\n</code></pre>',
        },
      ],
    };
    const api = fakeApi({ plansRead: vi.fn(async () => ({ ok: true as const, value: codeDoc })) });
    const { panel } = setup(api);
    await panel.open(codeDoc.path);
    clickBlock(panel.element.querySelector('[data-block-id="code-1"]'));
    const editable = panel.element.querySelector<HTMLElement>(".plan-block-edit__code")!;
    const codeEl = editable.querySelector("code")!;
    const range = document.createRange();
    range.selectNodeContents(codeEl);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const event = pasteEvent("const y = 2;\nconst z = 3;");
    editable.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    editable.dispatchEvent(new Event("blur"));
    await flush();
    expect(api.plansWriteBlock).toHaveBeenCalledWith(
      codeDoc.path,
      "code-1",
      "```js\nconst x = 1;\nconst y = 2;\nconst z = 3;\n```",
      codeDoc.mtimeMs,
    );
  });

  // C2 -------------------------------------------------------------------

  it("C2: a code block edits as contentEditable='plaintext-only'", async () => {
    const codeDoc: PlanDoc = {
      ...doc,
      blocks: [
        {
          id: "code-1",
          kind: "code",
          start: 0,
          end: 1,
          source: "```\nx\n```",
          html: "<pre><code>x\n</code></pre>",
        },
      ],
    };
    const api = fakeApi({ plansRead: vi.fn(async () => ({ ok: true as const, value: codeDoc })) });
    const { panel } = setup(api);
    await panel.open(codeDoc.path);
    clickBlock(panel.element.querySelector('[data-block-id="code-1"]'));
    expect(
      panel.element
        .querySelector<HTMLElement>(".plan-block-edit__code")
        ?.getAttribute("contenteditable"),
    ).toBe("plaintext-only");
  });

  it("C2: a raw (table/hr/other) block edits as contentEditable='plaintext-only'", async () => {
    const tableDoc: PlanDoc = {
      ...doc,
      blocks: [
        {
          id: "table-1",
          kind: "table",
          start: 0,
          end: 1,
          source: "| A |\n| - |\n| 1 |",
          html: "<table></table>",
        },
      ],
    };
    const api = fakeApi({ plansRead: vi.fn(async () => ({ ok: true as const, value: tableDoc })) });
    const { panel } = setup(api);
    await panel.open(tableDoc.path);
    clickBlock(panel.element.querySelector('[data-block-id="table-1"]'));
    expect(
      panel.element
        .querySelector<HTMLElement>(".plan-block-edit__raw")
        ?.getAttribute("contenteditable"),
    ).toBe("plaintext-only");
  });

  // I1 -------------------------------------------------------------------

  it("I1: focusing the link URL input does not blur out of edit mode or write anything", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);
    // Real focus first: the bug is that focusing the URL input blurs the
    // container out from under itself, which only happens if the container
    // genuinely held focus beforehand (renderEditingBlock's own queued
    // focus() hasn't necessarily run yet at this point in the test).
    editable.focus();
    const text = editable.querySelector("p")!.firstChild!;
    selectText(text, 9, 23);

    click(panel.element.querySelector(".plan-block-edit__link"));
    const urlInput = panel.element.querySelector<HTMLInputElement>(".plan-block-edit__link-input")!;
    urlInput.focus();
    await flush();

    expect(api.plansWriteBlock).not.toHaveBeenCalled();
    expect(panel.element.querySelector(".plan-block-edit__rich")).toBeTruthy();
  });

  it("I1: committing the link with an empty URL unwraps the anchor instead of writing [text]()", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);
    const text = editable.querySelector("p")!.firstChild!;
    selectText(text, 9, 23);

    click(panel.element.querySelector(".plan-block-edit__link"));
    const urlInput = panel.element.querySelector<HTMLInputElement>(".plan-block-edit__link-input")!;
    urlInput.value = "";
    urlInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(editable.querySelector("a")).toBeNull();
    editable.dispatchEvent(new Event("blur"));
    await flush();
    // Unwrapping restores the exact original text -> isNoopEdit -> no write.
    expect(api.plansWriteBlock).not.toHaveBeenCalled();
    expect(panel.element.querySelector(".plan-block-edit__rich")).toBeNull();
  });

  // I2 -------------------------------------------------------------------

  it("I2: text typed while a ⌘S save is in flight is not lost", async () => {
    let resolveWrite: (value: PlanResult<PlanDoc>) => void;
    const writeBlock = vi.fn(
      () =>
        new Promise<PlanResult<PlanDoc>>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const api = fakeApi({ plansWriteBlock: writeBlock });
    const { panel } = setup(api);
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    const editable = paragraphEl(panel.element);

    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }),
    );
    expect(writeBlock).toHaveBeenCalledTimes(1);

    editable.querySelector("p")!.textContent = "Ship the useful feature quickly, and more.";
    editable.dispatchEvent(new Event("input", { bubbles: true }));

    resolveWrite!({ ok: true, value: doc });
    await flush();

    // Same live node -- never rebuilt from the doc's own (now stale) html.
    expect(paragraphEl(panel.element)).toBe(editable);
    expect(editable.querySelector("p")!.textContent).toBe(
      "Ship the useful feature quickly, and more.",
    );
    expect(panel.element.querySelector<HTMLElement>(".plan-panel__unsaved")?.hidden).toBe(false);

    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }),
    );
    await flush();
    expect(writeBlock).toHaveBeenLastCalledWith(
      doc.path,
      "paragraph-1",
      "Ship the useful feature quickly, and more.",
      doc.mtimeMs,
    );
  });

  // I3 -------------------------------------------------------------------

  it("I3: edits to the conflict textarea survive an unrelated re-render", async () => {
    const revisedDoc: PlanDoc = {
      ...doc,
      mtimeMs: doc.mtimeMs + 1000,
      blocks: [blocks[0]!, { ...blocks[1]!, id: "paragraph-1-changed" }],
    };
    const writeBlock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "conflict" as const, doc: revisedDoc });
    const api = fakeApi({ plansWriteBlock: writeBlock });
    const { panel } = setup(api);
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    paragraphEl(panel.element).dispatchEvent(new Event("blur"));
    await flush();

    const textarea = panel.element.querySelector<HTMLTextAreaElement>(
      ".plan-panel__conflict-textarea",
    )!;
    textarea.value = "Ship the useful feature quickly, edited again.";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    // An unrelated action elsewhere in the panel triggers a full re-render;
    // the conflict notice (and its textarea) always renders regardless.
    click(panel.element.querySelector('[data-action="source"]'));

    const rebuilt = panel.element.querySelector<HTMLTextAreaElement>(
      ".plan-panel__conflict-textarea",
    )!;
    expect(rebuilt.value).toBe("Ship the useful feature quickly, edited again.");
  });

  // I4 -------------------------------------------------------------------

  it("I4: Apply's index fallback only applies when the block now there has the same kind", async () => {
    const revisedDoc: PlanDoc = {
      ...doc,
      mtimeMs: doc.mtimeMs + 1000,
      blocks: [
        blocks[0]!,
        { id: "hr-now-here", kind: "hr", start: 1, end: 2, source: "---", html: "<hr>" },
      ],
    };
    const writeBlock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "conflict" as const, doc: revisedDoc });
    const api = fakeApi({ plansWriteBlock: writeBlock });
    const { panel } = setup(api);
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    paragraphEl(panel.element).dispatchEvent(new Event("blur"));
    await flush();

    click(panel.element.querySelector('[data-action="apply-edit-conflict"]'));
    await flush();

    expect(writeBlock).toHaveBeenCalledTimes(1);
    expect(panel.element.querySelector(".plan-panel__action-error")?.textContent).toBe(
      "planEditConflictGone",
    );
  });

  it("I4: the conflict notice shows the target block's current source, read-only", async () => {
    const revisedDoc: PlanDoc = {
      ...doc,
      mtimeMs: doc.mtimeMs + 1000,
      blocks: [
        blocks[0]!,
        { ...blocks[1]!, id: "paragraph-1-changed", source: "Someone else's edit." },
      ],
    };
    const writeBlock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "conflict" as const, doc: revisedDoc });
    const api = fakeApi({ plansWriteBlock: writeBlock });
    const { panel } = setup(api);
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    paragraphEl(panel.element).dispatchEvent(new Event("blur"));
    await flush();

    expect(panel.element.querySelector(".plan-panel__conflict-current")?.textContent).toBe(
      "Someone else's edit.",
    );
  });

  // I5 -------------------------------------------------------------------

  it("I5: a click that lands on a non-collapsed selection does not also start editing", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    const content = panel.element.querySelector<HTMLElement>('[data-block-id="paragraph-1"]')!;
    const text = content.querySelector("p")!.firstChild!;
    content.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    selectText(text, 0, 4);
    content.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    content.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel.element.querySelector(".plan-block-edit__rich")).toBeNull();
  });

  it("I5: clicking a link inside a block does not start editing it", async () => {
    const linkedDoc: PlanDoc = {
      ...doc,
      blocks: [
        {
          ...blocks[1]!,
          html: '<p>Ship the <a href="https://example.com">useful</a> feature safely.</p>',
        },
      ],
    };
    const api = fakeApi({
      plansRead: vi.fn(async () => ({ ok: true as const, value: linkedDoc })),
    });
    const { panel } = setup(api);
    await panel.open(linkedDoc.path);
    const link = panel.element.querySelector("a")!;
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    link.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    link.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel.element.querySelector(".plan-block-edit__rich")).toBeNull();
  });

  // I6 -------------------------------------------------------------------

  it("I6: selecting text inside an actively-edited rich block anchors the comment draft to the real block id", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);
    const text = editable.querySelector("p")!.firstChild!;
    selectText(text, 9, 23);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    click(panel.element.querySelector('[data-action="comment-selection"]'));
    const textarea = panel.element.querySelector<HTMLTextAreaElement>(
      ".plan-panel__comment-box textarea",
    )!;
    textarea.value = "Clarify.";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    click(panel.element.querySelector('[data-action="add-comment"]'));
    await flush();

    expect(api.plansAddComment).toHaveBeenCalledWith(
      doc.path,
      "paragraph-1",
      "useful feature",
      "Clarify.",
    );
  });

  // Minors -----------------------------------------------------------------

  it("minor: switching blocks while a save is in flight needs only one click", async () => {
    let resolveWrite: (value: PlanResult<PlanDoc>) => void;
    const writeBlock = vi.fn(
      () =>
        new Promise<PlanResult<PlanDoc>>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const api = fakeApi({ plansWriteBlock: writeBlock });
    const { panel } = setup(api);
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    const editableA = paragraphEl(panel.element);
    const contentB = panel.element.querySelector<HTMLElement>('[data-block-id="heading-1"]')!;

    // Real event order for a click on a different block while A is focused:
    // mousedown(B) -> blur(A, relatedTarget=B) -> mouseup(B) -> click(B).
    contentB.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    editableA.dispatchEvent(new FocusEvent("blur", { relatedTarget: contentB }));
    contentB.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    contentB.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // The save is still in flight -> B did not open on this click.
    expect(
      panel.element.querySelector('[data-block-id="heading-1"] .plan-block-edit__rich'),
    ).toBeNull();

    resolveWrite!({ ok: true, value: doc });
    await flush();

    // Once the save settles, B opens automatically -- no second click.
    expect(
      panel.element.querySelector('[data-block-id="heading-1"] .plan-block-edit__rich'),
    ).toBeTruthy();
  });

  // Superseded by fix round 3, item A, which replaces round 2's id/index
  // re-anchor logic entirely: a *real* external change (this fake's own
  // plansRead, unlike an echo of our own write) while editing is clean now
  // exits editing and re-renders normally, rather than keeping a stale
  // container open across content that's genuinely different on disk —
  // see "createPlanPanel: block editing fix round 3", item A's own tests
  // for the echo and dirty cases.
  it("minor: a same-path reload while editing (not dirty) exits cleanly rather than leaving a detached container", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = panel.element.querySelector(".plan-block-edit__rich");
    expect(editable).toBeTruthy();

    panel.notifyChanged(doc.path);
    await flush();

    // Exited -- not a detached reference to the old container, a clean
    // read-mode render (no write, nothing of the user's own to lose).
    expect(panel.element.querySelector(".plan-block-edit__rich")).toBeNull();
    expect(api.plansRead).toHaveBeenCalledTimes(2);
  });

  it("minor: a write that resolves after dispose() does not throw", async () => {
    let resolveWrite: (value: PlanResult<PlanDoc>) => void;
    const writeBlock = vi.fn(
      () =>
        new Promise<PlanResult<PlanDoc>>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const api = fakeApi({ plansWriteBlock: writeBlock });
    const { panel } = setup(api);
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    paragraphEl(panel.element).dispatchEvent(new Event("blur"));

    panel.dispose();
    expect(() => resolveWrite!({ ok: true, value: doc })).not.toThrow();
    await flush();
  });

  it("minor: Esc while editing does not propagate past the editor", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);
    const outerHandler = vi.fn();
    document.addEventListener("keydown", outerHandler);
    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    document.removeEventListener("keydown", outerHandler);
    expect(outerHandler).not.toHaveBeenCalled();
  });
});

describe("createPlanPanel: block editing fix round 2", () => {
  function paragraphEl(panelElement: HTMLElement): HTMLElement {
    return panelElement.querySelector<HTMLElement>(".plan-block-edit__rich")!;
  }

  async function editParagraph(panelElement: HTMLElement, text: string): Promise<void> {
    clickBlock(panelElement.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panelElement);
    editable.querySelector("p")!.textContent = text;
    editable.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function selectText(node: Node, start: number, end: number): void {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // Item 1 --------------------------------------------------------------

  it("item1: after ⌘S, the toolbar Comment button anchors its draft to the new block id", async () => {
    const savedDoc: PlanDoc = {
      ...doc,
      mtimeMs: doc.mtimeMs + 1000,
      blocks: [
        blocks[0]!,
        { ...blocks[1]!, id: "paragraph-1-new", source: "Ship the useful feature quickly." },
      ],
    };
    const api = fakeApi({
      plansWriteBlock: vi.fn(async () => ({ ok: true as const, value: savedDoc })),
    });
    const { panel } = setup(api);
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    const editable = paragraphEl(panel.element);
    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }),
    );
    await flush();

    click(panel.element.querySelector(".plan-block-edit__comment"));
    const textarea = panel.element.querySelector<HTMLTextAreaElement>(
      ".plan-panel__comment-box textarea",
    )!;
    textarea.value = "Note";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    click(panel.element.querySelector('[data-action="add-comment"]'));
    await flush();

    expect(api.plansAddComment).toHaveBeenCalledWith(doc.path, "paragraph-1-new", "", "Note");
  });

  it("item1: after ⌘S, a text selection also anchors its comment draft to the new block id", async () => {
    const savedDoc: PlanDoc = {
      ...doc,
      mtimeMs: doc.mtimeMs + 1000,
      blocks: [
        blocks[0]!,
        { ...blocks[1]!, id: "paragraph-1-new", source: "Ship the useful feature quickly." },
      ],
    };
    const api = fakeApi({
      plansWriteBlock: vi.fn(async () => ({ ok: true as const, value: savedDoc })),
    });
    const { panel } = setup(api);
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    const editable = paragraphEl(panel.element);
    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }),
    );
    await flush();

    const textNode = editable.querySelector("p")!.firstChild!;
    selectText(textNode, 0, 4);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    click(panel.element.querySelector('[data-action="comment-selection"]'));

    const textarea = panel.element.querySelector<HTMLTextAreaElement>(
      ".plan-panel__comment-box textarea",
    )!;
    textarea.value = "Note";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    click(panel.element.querySelector('[data-action="add-comment"]'));
    await flush();

    expect(api.plansAddComment).toHaveBeenCalledWith(doc.path, "paragraph-1-new", "Ship", "Note");
  });

  // Item 2 --------------------------------------------------------------

  it("item2: leaving via the link URL input to an element outside the panel does not steal focus back, and saves once", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    const outside = document.createElement("button");
    document.body.append(outside);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);
    editable.focus();
    const text = editable.querySelector("p")!.firstChild!;
    selectText(text, 9, 23);

    click(panel.element.querySelector(".plan-block-edit__link"));
    const urlInput = panel.element.querySelector<HTMLInputElement>(".plan-block-edit__link-input")!;
    urlInput.focus();
    urlInput.value = "https://example.com";
    await flush();

    outside.focus(); // real focus move -> blur(urlInput, relatedTarget=outside)
    await flush();

    expect(document.activeElement).toBe(outside);
    expect(api.plansWriteBlock).toHaveBeenCalledTimes(1);
    expect(api.plansWriteBlock).toHaveBeenCalledWith(
      doc.path,
      "paragraph-1",
      "Ship the [useful feature](https://example.com) safely.",
      doc.mtimeMs,
    );
    expect(panel.element.querySelector(".plan-block-edit__rich")).toBeNull();
  });

  // Item 3 --------------------------------------------------------------

  it("item3a: typing while a reload's own awaits are in flight is not dropped", async () => {
    let resolveRead: (value: PlanResult<PlanDoc>) => void;
    const plansRead = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: doc })
      .mockImplementationOnce(
        () =>
          new Promise<PlanResult<PlanDoc>>((resolve) => {
            resolveRead = resolve;
          }),
      );
    const api = fakeApi({ plansRead });
    const { panel } = setup(api);
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);

    panel.notifyChanged(doc.path); // not dirty yet -> loadDocument starts, awaiting plansRead

    editable.querySelector("p")!.textContent = "Ship the useful feature quickly.";
    editable.dispatchEvent(new Event("input", { bubbles: true }));

    resolveRead!({ ok: true, value: doc });
    await flush();

    expect(paragraphEl(panel.element)).toBe(editable); // same live node, not rebuilt
    expect(editable.querySelector("p")!.textContent).toBe("Ship the useful feature quickly.");
    expect(panel.element.querySelector<HTMLElement>(".plan-panel__unsaved")?.hidden).toBe(false);
  });

  it("item3b: a watcher echo right after ⌘S keeps the block open for editing", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    const editable = paragraphEl(panel.element);
    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }),
    );
    await flush();
    expect(panel.element.querySelector(".plan-block-edit__rich")).toBeTruthy();

    panel.notifyChanged(doc.path); // watcher echo: clean now (just saved) -> reload runs immediately
    await flush();

    expect(panel.element.querySelector(".plan-block-edit__rich")).toBeTruthy();
    expect(vi.mocked(api.plansRead)).toHaveBeenCalledTimes(2);
  });

  // Item 4 (minor) --------------------------------------------------------

  it("item4a: mousedown on a link inside a different block does not record a pending switch target", async () => {
    const linkedDoc: PlanDoc = {
      ...doc,
      blocks: [
        { ...blocks[0]!, html: '<h1>Build <a href="https://example.com">it</a></h1>' },
        blocks[1]!,
      ],
    };
    let resolveWrite: (value: PlanResult<PlanDoc>) => void;
    const writeBlock = vi.fn(
      () =>
        new Promise<PlanResult<PlanDoc>>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const api = fakeApi({
      plansRead: vi.fn(async () => ({ ok: true as const, value: linkedDoc })),
      plansWriteBlock: writeBlock,
    });
    const { panel } = setup(api);
    await panel.open(linkedDoc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    const editableA = paragraphEl(panel.element);
    const link = panel.element.querySelector("a")!;

    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    editableA.dispatchEvent(new FocusEvent("blur", { relatedTarget: link }));

    resolveWrite!({ ok: true, value: linkedDoc });
    await flush();

    expect(
      panel.element.querySelector('[data-block-id="heading-1"] .plan-block-edit__rich'),
    ).toBeNull();
  });

  it("item4b: a pending switch target only opens on a real click with a collapsed selection", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    const editableA = paragraphEl(panel.element);
    const contentB = panel.element.querySelector<HTMLElement>('[data-block-id="heading-1"]')!;
    const headingText = contentB.querySelector("h1")!.firstChild!;

    contentB.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    editableA.dispatchEvent(new FocusEvent("blur", { relatedTarget: contentB }));
    // The mousedown turned into a text selection on B, not a plain click.
    selectText(headingText, 0, 4);
    contentB.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    contentB.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    expect(
      panel.element.querySelector('[data-block-id="heading-1"] .plan-block-edit__rich'),
    ).toBeNull();
  });

  it("item4c: a stale pending target does not auto-open after an unrelated Esc", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    const editableA = paragraphEl(panel.element);
    const contentB = panel.element.querySelector<HTMLElement>('[data-block-id="heading-1"]')!;

    // Records a pending target for B, but the user changes their mind and
    // cancels A instead of ever completing a click on B.
    contentB.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    editableA.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await flush();

    expect(api.plansWriteBlock).not.toHaveBeenCalled();
    expect(
      panel.element.querySelector('[data-block-id="heading-1"] .plan-block-edit__rich'),
    ).toBeNull();
  });

  // Item 5 ----------------------------------------------------------------

  it("item5: Enter at the end of a paragraph inserts a double <br>, and an untouched trailing break is not saved", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);
    const p = editable.querySelector("p")!;
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false); // caret at the very end
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    editable.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(p.querySelectorAll("br")).toHaveLength(2);

    editable.dispatchEvent(new Event("blur"));
    await flush();
    // No trailing hard break saved -- the user never typed anything after it.
    expect(api.plansWriteBlock).not.toHaveBeenCalled();
  });

  // Item 6 ------------------------------------------------------------------

  it("item6: Enter in a heading does nothing (single-line)", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="heading-1"]'));
    const editable = panel.element.querySelector<HTMLElement>(".plan-block-edit__rich")!;
    const textNode = editable.querySelector("h1")!.firstChild!;
    selectText(textNode, 2, 2);

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    editable.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(editable.querySelector("br")).toBeNull();
    expect(editable.querySelector("h1")?.textContent).toBe("Build it");

    editable.dispatchEvent(new Event("blur"));
    await flush();
    expect(api.plansWriteBlock).not.toHaveBeenCalled();
  });

  it("item6: pasted newlines in a heading become spaces", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="heading-1"]'));
    const editable = panel.element.querySelector<HTMLElement>(".plan-block-edit__rich")!;
    const h1 = editable.querySelector("h1")!;
    const range = document.createRange();
    range.selectNodeContents(h1);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? "and\nmore" : "") },
    });
    editable.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(editable.querySelector("br")).toBeNull();
    expect(h1.textContent).toBe("Build itand more");

    editable.dispatchEvent(new Event("blur"));
    await flush();
    expect(api.plansWriteBlock).toHaveBeenCalledWith(
      doc.path,
      "heading-1",
      "# Build itand more",
      doc.mtimeMs,
    );
  });
});

describe("createPlanPanel: block editing fix round 3", () => {
  function paragraphEl(panelElement: HTMLElement): HTMLElement {
    return panelElement.querySelector<HTMLElement>(".plan-block-edit__rich")!;
  }

  async function editParagraph(panelElement: HTMLElement, text: string): Promise<void> {
    clickBlock(panelElement.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panelElement);
    editable.querySelector("p")!.textContent = text;
    editable.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function selectText(node: Node, start: number, end: number): void {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // Item A ------------------------------------------------------------

  it("A1: our own write's echo keeps edit mode and focus, doing nothing at all", async () => {
    const savedDoc: PlanDoc = { ...doc, mtimeMs: doc.mtimeMs + 1000 };
    const api = fakeApi({
      plansRead: vi.fn(async () => ({ ok: true as const, value: savedDoc })),
      plansWriteBlock: vi.fn(async () => ({ ok: true as const, value: savedDoc })),
    });
    const { panel } = setup(api);
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    const editable = paragraphEl(panel.element);
    editable.focus();
    editable.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }),
    );
    await flush();
    // lastOwnWrite is now {path: doc.path, mtimeMs: savedDoc.mtimeMs}.

    panel.notifyChanged(doc.path); // the watcher noticing our own write land
    await flush();

    expect(panel.element.querySelector(".plan-block-edit__rich")).toBe(editable);
    expect(document.activeElement).toBe(editable);
  });

  it("A2: a real external change while clean exits editing without writing", async () => {
    const revisedDoc: PlanDoc = { ...doc, mtimeMs: doc.mtimeMs + 1000 };
    const plansRead = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: doc })
      .mockResolvedValue({ ok: true, value: revisedDoc });
    const api = fakeApi({ plansRead });
    const { panel } = setup(api);
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));

    panel.notifyChanged(doc.path);
    await flush();

    expect(panel.element.querySelector(".plan-block-edit__rich")).toBeNull();
    expect(api.plansWriteBlock).not.toHaveBeenCalled();
  });

  it("A3: a real external change while dirty keeps the DOM and text, then the next save conflicts with the typed text kept", async () => {
    const revisedDoc: PlanDoc = { ...doc, mtimeMs: doc.mtimeMs + 1000 };
    const plansRead = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: doc })
      .mockResolvedValue({ ok: true, value: revisedDoc });
    const writeBlock = vi.fn(async () => ({
      ok: false as const,
      reason: "conflict" as const,
      doc: revisedDoc,
    }));
    const api = fakeApi({ plansRead, plansWriteBlock: writeBlock });
    const { panel } = setup(api);
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    const editable = paragraphEl(panel.element);

    panel.notifyChanged(doc.path);
    await flush();

    // notifyChanged really did forward to a read (echo detection needs
    // the fresh mtime to compare against) -- this is not the old
    // pre-round-3 short-circuit that skipped reading entirely while dirty.
    expect(plansRead).toHaveBeenCalledTimes(2);
    // DOM and text untouched -- same live node, still the typed text.
    expect(paragraphEl(panel.element)).toBe(editable);
    expect(editable.querySelector("p")!.textContent).toBe("Ship the useful feature quickly.");
    expect(panel.element.querySelector<HTMLElement>(".plan-panel__disk-changed")?.hidden).toBe(
      false,
    );

    editable.dispatchEvent(new Event("blur"));
    await flush();

    // The write still went out with the OLD baseMtimeMs -- that's what
    // makes the server (fake, here) discover the conflict itself.
    expect(writeBlock).toHaveBeenCalledWith(
      doc.path,
      "paragraph-1",
      "Ship the useful feature quickly.",
      doc.mtimeMs,
    );
    const textarea = panel.element.querySelector<HTMLTextAreaElement>(
      ".plan-panel__conflict-textarea",
    );
    expect(textarea?.value).toBe("Ship the useful feature quickly.");
  });

  // Item B ------------------------------------------------------------

  it("B1: switching blocks while a save is in flight opens B once A's save settles (mouseup-confirmed)", async () => {
    let resolveWrite: (value: PlanResult<PlanDoc>) => void;
    const writeBlock = vi.fn(
      () =>
        new Promise<PlanResult<PlanDoc>>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const api = fakeApi({ plansWriteBlock: writeBlock });
    const { panel } = setup(api);
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    const editableA = paragraphEl(panel.element);
    const contentB = panel.element.querySelector<HTMLElement>('[data-block-id="heading-1"]')!;

    // Real event order: mousedown(B) -> blur(A, relatedTarget=B) -> A's
    // save starts (state.saving = true) -> mouseup(B) -> click(B).
    contentB.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    editableA.dispatchEvent(new FocusEvent("blur", { relatedTarget: contentB }));
    contentB.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    contentB.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // A's save is still in flight -> B did not open on this click.
    expect(
      panel.element.querySelector('[data-block-id="heading-1"] .plan-block-edit__rich'),
    ).toBeNull();

    resolveWrite!({ ok: true, value: doc });
    await flush();

    // Once the save settles, B opens automatically -- no second click.
    expect(
      panel.element.querySelector('[data-block-id="heading-1"] .plan-block-edit__rich'),
    ).toBeTruthy();
  });

  it("B2: a drag-select on B, with a real microtask checkpoint before the click, does not open B", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    const editableA = paragraphEl(panel.element);
    const contentBBeforeSettle = panel.element.querySelector<HTMLElement>(
      '[data-block-id="heading-1"]',
    )!;

    contentBBeforeSettle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    editableA.dispatchEvent(new FocusEvent("blur", { relatedTarget: contentBBeforeSettle }));
    // Real microtask checkpoint: A's own save (default mock, resolves
    // promptly) fully settles here, well before the click below -- A's own
    // exit re-renders the whole document, so B's row (never itself
    // edited) is a fresh element after this, not `contentBBeforeSettle`.
    await flush();

    const contentB = panel.element.querySelector<HTMLElement>('[data-block-id="heading-1"]')!;
    const headingText = contentB.querySelector("h1")!.firstChild!;
    // A drag-select on B, not a plain click.
    selectText(headingText, 0, 4);
    contentB.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    contentB.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    expect(
      panel.element.querySelector('[data-block-id="heading-1"] .plan-block-edit__rich'),
    ).toBeNull();
    expect(api.plansWriteBlock).toHaveBeenCalledTimes(1); // only A's own dirty save
  });

  // Item C ------------------------------------------------------------

  it("C1: Enter at the end of a quote's first paragraph still gets the caret-visibility filler, even with a second paragraph later in the same container", async () => {
    const quoteDoc: PlanDoc = {
      ...doc,
      blocks: [
        {
          id: "quote-1",
          kind: "quote",
          start: 0,
          end: 3,
          source: "> Hello\n>\n> World",
          html: "<blockquote><p>Hello</p><p>World</p></blockquote>",
        },
      ],
    };
    const api = fakeApi({ plansRead: vi.fn(async () => ({ ok: true as const, value: quoteDoc })) });
    const { panel } = setup(api);
    await panel.open(quoteDoc.path);
    clickBlock(panel.element.querySelector('[data-block-id="quote-1"]'));
    const editable = panel.element.querySelector<HTMLElement>(".plan-block-edit__rich")!;
    const firstP = editable.querySelectorAll("p")[0]!;
    const range = document.createRange();
    range.selectNodeContents(firstP);
    range.collapse(false); // caret at the end of "Hello" -- "World" follows, but in the SECOND <p>
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    editable.dispatchEvent(event);

    expect(firstP.querySelectorAll("br")).toHaveLength(2);
  });

  it("C2: a trailing empty text node after a hard break does not hide it from being stripped", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);
    const p = editable.querySelector("p")!;
    // A shape a real browser's own editing commands can produce, not
    // reachable through insertHardBreak itself: two trailing <br>s
    // followed by an empty text node.
    p.append(
      document.createElement("br"),
      document.createElement("br"),
      document.createTextNode(""),
    );
    editable.dispatchEvent(new Event("input", { bubbles: true }));

    editable.dispatchEvent(new Event("blur"));
    await flush();

    // Both breaks (and the empty text node after them) strip away to
    // nothing meaningful -- still a no-op edit.
    expect(api.plansWriteBlock).not.toHaveBeenCalled();
  });

  it("C3: Enter in the link URL input does not exit editing", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);
    editable.focus();
    const text = editable.querySelector("p")!.firstChild!;
    selectText(text, 9, 23);

    click(panel.element.querySelector(".plan-block-edit__link"));
    const urlInput = panel.element.querySelector<HTMLInputElement>(".plan-block-edit__link-input")!;
    urlInput.focus();
    urlInput.value = "https://example.com";
    urlInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    // Enter's own applyUrl() removes `urlInput` from the DOM; a real
    // browser fires a blur on it as a direct side effect of that removal
    // (jsdom does not reliably reproduce this on its own), dispatched here
    // explicitly so the test doesn't depend on jsdom's own inconsistent
    // removal-blur behavior to exercise the fix. `urlInput` is still a
    // valid event target even though it's already detached — listeners
    // aren't unregistered by removal.
    urlInput.dispatchEvent(new Event("blur"));
    await flush();

    expect(panel.element.querySelector(".plan-block-edit__rich")).toBeTruthy();
    expect(api.plansWriteBlock).not.toHaveBeenCalled();
    expect(editable.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  });
});

describe("createPlanPanel: block editing fix round 4", () => {
  function paragraphEl(panelElement: HTMLElement): HTMLElement {
    return panelElement.querySelector<HTMLElement>(".plan-block-edit__rich")!;
  }

  function headingEditor(panelElement: HTMLElement): Element | null {
    return panelElement.querySelector('[data-block-id="heading-1"] .plan-block-edit__rich');
  }

  function liveHeading(panelElement: HTMLElement): HTMLElement {
    return panelElement.querySelector<HTMLElement>('[data-block-id="heading-1"]')!;
  }

  async function editParagraph(panelElement: HTMLElement, text: string): Promise<void> {
    clickBlock(panelElement.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panelElement);
    editable.querySelector("p")!.textContent = text;
    editable.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function selectText(node: Node, start: number, end: number): void {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function pendingWrite() {
    let resolveWrite: (value: PlanResult<PlanDoc>) => void = () => undefined;
    const plansWriteBlock = vi.fn(
      () =>
        new Promise<PlanResult<PlanDoc>>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    return { plansWriteBlock, resolve: (value: PlanResult<PlanDoc>) => resolveWrite(value) };
  }

  // Item A ------------------------------------------------------------

  it("A: typing that starts while a reload's plansComments is pending is kept, flagged, and later conflicts", async () => {
    const revisedDoc: PlanDoc = { ...doc, mtimeMs: doc.mtimeMs + 1000 };
    const plansRead = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: doc })
      .mockResolvedValue({ ok: true, value: revisedDoc });
    let resolveComments: (value: AnchoredComment[]) => void = () => undefined;
    const plansComments = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise<AnchoredComment[]>((resolve) => {
            resolveComments = resolve;
          }),
      )
      .mockResolvedValue([]);
    const writeBlock = vi.fn(async () => ({
      ok: false as const,
      reason: "conflict" as const,
      doc: revisedDoc,
    }));
    const api = fakeApi({ plansRead, plansComments, plansWriteBlock: writeBlock });
    const { panel } = setup(api);
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);

    // Real external change; the block is clean when loadDocument checks,
    // so it proceeds to await plansComments.
    panel.notifyChanged(doc.path);
    await flush();
    expect(plansComments).toHaveBeenCalledTimes(2);

    // Typing starts while plansComments is still pending.
    editable.querySelector("p")!.textContent = "Ship the useful feature quickly.";
    editable.dispatchEvent(new Event("input", { bubbles: true }));

    resolveComments([]);
    await flush();

    expect(paragraphEl(panel.element)).toBe(editable);
    expect(editable.querySelector("p")!.textContent).toBe("Ship the useful feature quickly.");
    expect(panel.element.querySelector<HTMLElement>(".plan-panel__disk-changed")?.hidden).toBe(
      false,
    );
    expect(writeBlock).not.toHaveBeenCalled();

    editable.dispatchEvent(new Event("blur"));
    await flush();

    expect(writeBlock).toHaveBeenCalledWith(
      doc.path,
      "paragraph-1",
      "Ship the useful feature quickly.",
      doc.mtimeMs,
    );
    expect(
      panel.element.querySelector<HTMLTextAreaElement>(".plan-panel__conflict-textarea")?.value,
    ).toBe("Ship the useful feature quickly.");
  });

  // Item B ------------------------------------------------------------

  it("B1: A's blur-exit rebuilds the rows before mouseup and no click fires; mouseup on the new B element opens B", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    const editableA = paragraphEl(panel.element);
    const staleB = liveHeading(panel.element);

    staleB.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    editableA.dispatchEvent(new FocusEvent("blur", { relatedTarget: staleB }));
    await flush(); // A's save settles and its exit rebuilds every row

    const freshB = liveHeading(panel.element);
    expect(freshB).not.toBe(staleB);
    freshB.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    // Chromium dispatches no click here: the mousedown target is gone.
    await flush();

    expect(api.plansWriteBlock).toHaveBeenCalledTimes(1);
    expect(headingEditor(panel.element)).toBeTruthy();
  });

  it("B1b: a clean A's synchronous blur-exit rebuild before mouseup still opens B with no click", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    clickBlock(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editableA = paragraphEl(panel.element);
    const staleB = liveHeading(panel.element);

    staleB.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    editableA.dispatchEvent(new FocusEvent("blur", { relatedTarget: staleB }));
    const freshB = liveHeading(panel.element);
    expect(freshB).not.toBe(staleB);
    freshB.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await flush();

    expect(api.plansWriteBlock).not.toHaveBeenCalled();
    expect(headingEditor(panel.element)).toBeTruthy();
  });

  it("B1c: mouseup on B while A's save is still in flight opens B once the save settles, with no click", async () => {
    const write = pendingWrite();
    const { panel } = setup(fakeApi({ plansWriteBlock: write.plansWriteBlock }));
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    const editableA = paragraphEl(panel.element);
    const contentB = liveHeading(panel.element);

    contentB.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    editableA.dispatchEvent(new FocusEvent("blur", { relatedTarget: contentB }));
    liveHeading(panel.element).dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(headingEditor(panel.element)).toBeNull();

    write.resolve({ ok: true, value: doc });
    await flush();

    expect(headingEditor(panel.element)).toBeTruthy();
  });

  it("B2: a drag-select on the rebuilt B (non-collapsed selection at mouseup) never opens B", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    const editableA = paragraphEl(panel.element);
    const staleB = liveHeading(panel.element);

    staleB.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    editableA.dispatchEvent(new FocusEvent("blur", { relatedTarget: staleB }));
    await flush();

    const freshB = liveHeading(panel.element);
    selectText(freshB.querySelector("h1")!.firstChild!, 0, 4);
    freshB.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await flush();

    expect(headingEditor(panel.element)).toBeNull();
  });

  it("B3: a mousedown back into A clears a pending switch to B", async () => {
    const write = pendingWrite();
    const { panel } = setup(fakeApi({ plansWriteBlock: write.plansWriteBlock }));
    await panel.open(doc.path);
    await editParagraph(panel.element, "Ship the useful feature quickly.");
    const editableA = paragraphEl(panel.element);
    const contentB = liveHeading(panel.element);

    contentB.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    editableA.dispatchEvent(new FocusEvent("blur", { relatedTarget: contentB }));
    liveHeading(panel.element).dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    // Changed their mind: click back into A while its save is in flight.
    paragraphEl(panel.element).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    paragraphEl(panel.element).dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    write.resolve({ ok: true, value: doc });
    await flush();

    expect(headingEditor(panel.element)).toBeNull();
  });

  it("B4: mousedown on B and mouseup elsewhere does not open B", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    // Fix round 5: a pointer that stays put still confirms (layout shift),
    // so "mouseup elsewhere" here means the pointer really moved there.
    liveHeading(panel.element).dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 10 }),
    );
    panel.element
      .querySelector('[data-block-id="paragraph-1"]')!
      .dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 10, clientY: 60 }));
    await flush();

    expect(panel.element.querySelector(".plan-block-edit__rich")).toBeNull();
  });
});

describe("createPlanPanel: block editing fix round 5", () => {
  type CaretDoc = Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };

  function paragraphEl(panelElement: HTMLElement): HTMLElement {
    return panelElement.querySelector<HTMLElement>(".plan-block-edit__rich")!;
  }

  function headingEditor(panelElement: HTMLElement): Element | null {
    return panelElement.querySelector('[data-block-id="heading-1"] .plan-block-edit__rich');
  }

  function liveHeading(panelElement: HTMLElement): HTMLElement {
    return panelElement.querySelector<HTMLElement>('[data-block-id="heading-1"]')!;
  }

  function mouse(type: string, target: EventTarget, x: number, y: number): void {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
  }

  function selectText(node: Node, start: number, end: number): void {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  afterEach(() => {
    Reflect.deleteProperty(document, "caretRangeFromPoint");
    vi.restoreAllMocks();
  });

  // Item 1: caret at the click point ------------------------------------

  it("1a: click-to-edit places the caret at the pointer via caretRangeFromPoint", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    const caretRangeFromPoint = vi.fn((_x: number, _y: number) => {
      const text = paragraphEl(panel.element)?.querySelector("p")?.firstChild;
      if (!text) return null;
      const range = document.createRange();
      range.setStart(text, 9);
      range.collapse(true);
      return range;
    });
    (document as CaretDoc).caretRangeFromPoint = caretRangeFromPoint;

    const content = panel.element.querySelector('[data-block-id="paragraph-1"]')!;
    window.getSelection()?.removeAllRanges();
    mouse("mousedown", content, 120, 40);
    mouse("mouseup", content, 120, 40);
    await flush();

    const editable = paragraphEl(panel.element);
    const selection = window.getSelection()!;
    expect(caretRangeFromPoint).toHaveBeenCalledWith(120, 40);
    expect(selection.isCollapsed).toBe(true);
    expect(selection.anchorNode).toBe(editable.querySelector("p")!.firstChild);
    expect(selection.anchorOffset).toBe(9);
  });

  it("1b: when the pointer resolves to nothing, the caret goes to the END of the block", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    (document as CaretDoc).caretRangeFromPoint = vi.fn(() => null);

    const content = panel.element.querySelector('[data-block-id="paragraph-1"]')!;
    window.getSelection()?.removeAllRanges();
    mouse("mousedown", content, 5, 5);
    mouse("mouseup", content, 5, 5);
    await flush();

    const text = paragraphEl(panel.element).querySelector("p")!.firstChild!;
    const selection = window.getSelection()!;
    expect(selection.isCollapsed).toBe(true);
    expect(selection.anchorNode).toBe(text);
    expect(selection.anchorOffset).toBe(text.textContent!.length);
  });

  it("1c: a caret range outside the edited block also falls back to the end", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    (document as CaretDoc).caretRangeFromPoint = vi.fn(() => {
      const outside = panel.element.querySelector('[data-block-id="heading-1"] h1')!.firstChild!;
      const range = document.createRange();
      range.setStart(outside, 2);
      range.collapse(true);
      return range;
    });

    const content = panel.element.querySelector('[data-block-id="paragraph-1"]')!;
    window.getSelection()?.removeAllRanges();
    mouse("mousedown", content, 5, 5);
    mouse("mouseup", content, 5, 5);
    await flush();

    const text = paragraphEl(panel.element).querySelector("p")!.firstChild!;
    expect(window.getSelection()!.anchorNode).toBe(text);
    expect(window.getSelection()!.anchorOffset).toBe(text.textContent!.length);
  });

  // Item 2: layout shift under a stationary pointer --------------------

  async function startSwitchWithShift(panelElement: HTMLElement) {
    // A is open and dirty; its save resolves immediately (default mock).
    clickBlock(panelElement.querySelector('[data-block-id="paragraph-1"]'));
    const editableA = paragraphEl(panelElement);
    editableA.querySelector("p")!.textContent = "Ship the useful feature quickly.";
    editableA.dispatchEvent(new Event("input", { bubbles: true }));
    const staleB = liveHeading(panelElement);
    window.getSelection()?.removeAllRanges();
    mouse("mousedown", staleB, 200, 100);
    editableA.dispatchEvent(new FocusEvent("blur", { relatedTarget: staleB }));
    await flush(); // A saves and exits: every row is rebuilt and shifts up
    expect(liveHeading(panelElement)).not.toBe(staleB);
    return panelElement.querySelector<HTMLElement>(".plan-panel__body")!;
  }

  it("2a: mouseup at the same point lands on the panel body after the shift, and B still opens", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    const body = await startSwitchWithShift(panel.element);

    mouse("mouseup", body, 200, 100);
    await flush();

    expect(headingEditor(panel.element)).toBeTruthy();
  });

  it("2b: a pointer that moved 5px or more before mouseup on another target does not open B", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    const body = await startSwitchWithShift(panel.element);

    mouse("mouseup", body, 205, 100);
    await flush();

    expect(headingEditor(panel.element)).toBeNull();
  });

  it("2c: a stationary mouseup more than 800ms after mousedown on another target does not open B", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const body = await startSwitchWithShift(panel.element);

    now += 801;
    mouse("mouseup", body, 200, 100);
    await flush();

    expect(headingEditor(panel.element)).toBeNull();
  });

  it("2d: a drag-select still never opens B, even at the same point", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    const body = await startSwitchWithShift(panel.element);

    selectText(liveHeading(panel.element).querySelector("h1")!.firstChild!, 0, 4);
    mouse("mouseup", body, 200, 100);
    await flush();

    expect(headingEditor(panel.element)).toBeNull();
  });
});
