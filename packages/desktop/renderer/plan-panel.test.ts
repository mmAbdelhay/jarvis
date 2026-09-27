// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
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
    click(panelElement.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panelElement);
    editable.querySelector("p")!.textContent = text;
    editable.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("click enters edit mode: accent-outlined contenteditable, a formatting toolbar, and a hint", async () => {
    const { panel } = setup();
    await panel.open(doc.path);
    click(panel.element.querySelector('[data-block-id="paragraph-1"]'));
    const editable = paragraphEl(panel.element);
    expect(editable.contentEditable).toBe("true");
    expect(panel.element.querySelector(".plan-block-edit__toolbar")).toBeTruthy();
    expect(panel.element.querySelector(".plan-block-edit__hint")?.textContent).toBe("planEditHint");
  });

  it("a click-then-blur with no typing never writes (gated on a real dirty flag)", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    click(panel.element.querySelector('[data-block-id="paragraph-1"]'));
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
    click(panel.element.querySelector('[data-block-id="paragraph-1"]'));
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
    click(panel.element.querySelector('[data-block-id="paragraph-1"]'));
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
    click(panel.element.querySelector('[data-block-id="paragraph-1"]'));
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

    click(panel.element.querySelector('[data-block-id="code-1"]'));
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

    click(panel.element.querySelector('[data-block-id="table-1"]'));
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

  it("defers a same-path reload while dirty (showing Updated-on-disk instead), and reloads once discarded", async () => {
    const { panel, api } = setup();
    await panel.open(doc.path);
    const readCallsBefore = vi.mocked(api.plansRead).mock.calls.length;
    await editParagraph(panel.element, "Ship the useful feature quickly.");

    panel.notifyChanged(doc.path);
    await flush();
    expect(vi.mocked(api.plansRead).mock.calls.length).toBe(readCallsBefore);
    expect(panel.element.querySelector<HTMLElement>(".plan-panel__disk-changed")?.hidden).toBe(
      false,
    );

    paragraphEl(panel.element).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush();
    expect(vi.mocked(api.plansRead).mock.calls.length).toBe(readCallsBefore + 1);
  });
});
